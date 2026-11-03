import { unzipSync } from 'fflate'
import { Directory, File, compilePhp, encodeRequest, lookup, makeRoot, parseHttpResponse, removeFile, runPhp, walk, writeFile } from './engine'

const MIME: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  map: 'application/json',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  xml: 'text/xml; charset=utf-8',
  webmanifest: 'application/manifest+json',
}

// is_ssl() is true only when this listen port is 443. Match the page so CSS stays on the same scheme.
const phpPort = self.location.protocol === 'https:' ? '443' : '80'
const PHP_ARGS = ['php2', '-d', 'max_execution_time=0', '-d', 'date.timezone=UTC', '-d', 'display_errors=0', '-S', `127.0.0.1:${phpPort}`, '--stdio', '127.0.0.1:1', '-t', '/www']

const root = makeRoot()
let php: WebAssembly.Module | null = null
let ready = false
const pristine = new Map<string, string>()
let chain = Promise.resolve()
let saveTimer = 0

type Snapshot = { files: [string, ArrayBuffer][]; deleted: string[] }
type HttpMessage = { type?: string; id?: number; method?: string; path?: string; headers?: [string, string][]; body?: ArrayBuffer }
type HttpResult = { status: number; headers: [string, string][]; body: ArrayBuffer }

function postStatus(text: string) {
  self.postMessage({ type: 'status', text })
}

function fnv(data: Uint8Array): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i]
    hash = Math.imul(hash, 0x01000193)
  }
  return `${data.length.toString(16)}:${(hash >>> 0).toString(16)}`
}

function watched(path: string): boolean {
  return path === 'wp-config.php' || path.startsWith('wp-content/')
}

function siteDir(): Directory {
  const node = lookup(root, '/www/site')
  if (!(node instanceof Directory)) throw new Error('WordPress is not mounted')
  return node
}

function rememberPristine() {
  pristine.clear()
  for (const [path, node] of walk(siteDir())) {
    if (node instanceof File && watched(path)) pristine.set(path, fnv(node.data))
  }
}

function collectSnapshot(): Snapshot {
  const files: [string, ArrayBuffer][] = []
  const seen = new Set<string>()
  for (const [path, node] of walk(siteDir())) {
    if (!(node instanceof File) || !watched(path)) continue
    seen.add(path)
    if (pristine.get(path) !== fnv(node.data)) files.push([path, node.data.slice().buffer])
  }
  const deleted = [...pristine.keys()].filter((path) => !seen.has(path))
  return { files, deleted }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('p8-wordpress', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('kv')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function loadSnapshot(): Promise<Snapshot | null> {
  const db = await openDb()
  const snapshot = await new Promise<Snapshot | null>((resolve, reject) => {
    const request = db.transaction('kv').objectStore('kv').get('overlay')
    request.onsuccess = () => resolve((request.result as Snapshot | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return snapshot
}

async function saveSnapshot(snapshot: Snapshot) {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction('kv', 'readwrite').objectStore('kv').put(snapshot, 'overlay')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
  db.close()
}

function applySnapshot(snapshot: Snapshot) {
  for (const path of snapshot.deleted) removeFile(root, `/www/site/${path}`)
  for (const [path, bytes] of snapshot.files) writeFile(root, `/www/site/${path}`, new Uint8Array(bytes))
}

let lastSignature = ''

function scheduleSave() {
  self.clearTimeout(saveTimer)
  saveTimer = self.setTimeout(() => { void enqueue(() => persist()) }, 250)
}

function signatureOf(snapshot: Snapshot): string {
  const files = snapshot.files.map(([path, bytes]) => `${path}:${fnv(new Uint8Array(bytes))}`)
  return `${snapshot.deleted.join('|')}|${files.join('|')}`
}

async function persist() {
  if (!ready) return
  const snapshot = collectSnapshot()
  const signature = signatureOf(snapshot)
  if (signature === lastSignature) return
  await saveSnapshot(snapshot)
  lastSignature = signature
}

function enqueue(job: () => Promise<void>) {
  const run = chain.then(job, job)
  chain = run.then(() => undefined, () => undefined)
  return run
}

function tightBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function textBody(status: number, text: string): HttpResult {
  return { status, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: tightBuffer(new TextEncoder().encode(text)) }
}

async function answer(message: HttpMessage): Promise<HttpResult> {
  const path = message.path ?? '/'
  const queryAt = path.indexOf('?')
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt)
  const relative = pathname === '/site' ? '/' : pathname.replace(/^\/site/, '') || '/'
  const fsPath = relative === '/' ? '/www/site' : `/www/site${relative}`
  const method = (message.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    const node = lookup(root, fsPath)
    if (node instanceof File && !fsPath.endsWith('.php')) {
      const ext = fsPath.slice(fsPath.lastIndexOf('.') + 1).toLowerCase()
      const bytes = method === 'HEAD' ? new Uint8Array() : node.data
      return { status: 200, headers: [['Content-Type', MIME[ext] ?? 'application/octet-stream']], body: bytes.slice().buffer }
    }
  }
  if (!php) return textBody(503, 'p8 is still starting')
  const stdin = encodeRequest(method, path, self.location.origin, message.headers ?? [], new Uint8Array(message.body ?? new ArrayBuffer(0)))
  const result = await runPhp(php, PHP_ARGS, root, stdin)
  if (!result.stdout.length) return textBody(502, result.stderr || 'p8 returned an empty response')
  const parsed = parseHttpResponse(result.stdout)
  scheduleSave()
  return { status: parsed.status, headers: parsed.headers, body: tightBuffer(parsed.body) }
}

async function loadZip(): Promise<Uint8Array> {
  const manifest = await fetch('/wp.json').then(async (response) => {
    if (!response.ok) throw new Error('WordPress bundle is missing')
    return response.json() as Promise<{ parts: string[] }>
  })
  const chunks = await Promise.all(manifest.parts.map(async (name) => {
    const response = await fetch(`/wp/${name}`)
    if (!response.ok) throw new Error(`WordPress bundle part ${name} is missing`)
    return new Uint8Array(await response.arrayBuffer())
  }))
  const zip = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    zip.set(chunk, offset)
    offset += chunk.length
  }
  return zip
}

async function boot() {
  postStatus('Loading PHP…')
  const zipPromise = loadZip()
  php = await compilePhp('/php2.wasm')
  postStatus('Unpacking WordPress…')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const files = unzipSync(await zipPromise)
  for (const [path, data] of Object.entries(files)) {
    if (!path || path.endsWith('/')) continue
    writeFile(root, `/www/site/${path}`, data)
  }
  rememberPristine()
  const snapshot = await loadSnapshot()
  if (snapshot) {
    applySnapshot(snapshot)
    lastSignature = signatureOf(collectSnapshot())
  }
  writeFile(root, '/www/site/wp-content/mu-plugins/p8-auto-login.php', new TextEncoder().encode(`<?php
add_action( 'init', function () {
	if ( is_user_logged_in() ) {
		return;
	}
	$user = get_user_by( 'login', 'admin' );
	if ( ! $user ) {
		return;
	}
	$user_id = (int) $user->ID;
	$expiration = time() + apply_filters( 'auth_cookie_expiration', 2 * DAY_IN_SECONDS, $user_id, false );
	$token = WP_Session_Tokens::get_instance( $user_id )->create( $expiration );
	$secure = is_ssl();
	$auth_cookie = wp_generate_auth_cookie( $user_id, $expiration, $secure ? 'secure_auth' : 'auth', $token );
	$logged_in_cookie = wp_generate_auth_cookie( $user_id, $expiration, 'logged_in', $token );
	$_COOKIE[ $secure ? SECURE_AUTH_COOKIE : AUTH_COOKIE ] = $auth_cookie;
	$_COOKIE[ LOGGED_IN_COOKIE ] = $logged_in_cookie;
	wp_set_auth_cookie( $user_id, false, $secure, $token );
	wp_set_current_user( $user_id );
}, 1 );
`))
  ready = true
  self.postMessage({ type: 'ready' })
}

function resetDatabase() {
  const request = indexedDB.deleteDatabase('p8-wordpress')
  const done = () => self.postMessage({ type: 'reset-done' })
  request.onsuccess = done
  request.onerror = done
  request.onblocked = done
}

self.onmessage = (event: MessageEvent<HttpMessage>) => {
  const message = event.data
  void enqueue(async () => {
    if (message.type === 'persist') {
      await persist()
      return
    }
    if (message.type === 'reset') {
      resetDatabase()
      return
    }
    if (message.type !== 'http' || message.id == null) return
    try {
      const result = await answer(message)
      self.postMessage({ type: 'http', id: message.id, ...result }, [result.body])
    } catch (error) {
      const result = textBody(500, error instanceof Error ? error.message : String(error))
      self.postMessage({ type: 'http', id: message.id, ...result }, [result.body])
    }
  })
}

void enqueue(() => boot()).catch((error: unknown) => {
  self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
})
