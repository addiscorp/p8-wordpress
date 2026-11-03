import { unzipSync } from 'fflate'
import { Directory, File, compilePhp, encodeRequest, lookup, makeRoot, parseHttpResponse, removeFile, runPhp, walk, writeFile } from './php/engine'

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

const PHP_ARGS = ['php2', '-d', 'max_execution_time=0', '-d', 'date.timezone=UTC', '-d', 'display_errors=0', '-S', '127.0.0.1:80', '--stdio', '127.0.0.1:1', '-t', '/www']

const statusEl = document.querySelector<HTMLSpanElement>('#status')!
const frame = document.querySelector<HTMLIFrameElement>('#site')!
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!

const root = makeRoot()
let php: WebAssembly.Module | null = null
let ready = false
const pristine = new Map<string, string>()
let chain = Promise.resolve()
let saveTimer = 0

type Snapshot = { files: [string, ArrayBuffer][]; deleted: string[] }

function setStatus(text: string) {
  statusEl.textContent = text
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
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => { void persist() }, 250)
}

function signatureOf(snapshot: Snapshot): string {
  const files = snapshot.files.map(([path, bytes]) => `${path}:${fnv(new Uint8Array(bytes))}`)
  return `${snapshot.deleted.join('|')}|${files.join('|')}`
}

async function persist() {
  const snapshot = collectSnapshot()
  const signature = signatureOf(snapshot)
  if (signature === lastSignature) return
  await saveSnapshot(snapshot)
  lastSignature = signature
}

function enqueue<T>(job: () => T): Promise<T> {
  const run = chain.then(job, job)
  chain = run.then(() => undefined, () => undefined)
  return run
}

function answer(message: { method: string; path: string; headers: [string, string][]; body: ArrayBuffer }): { status: number; headers: [string, string][]; body: ArrayBuffer } {
  const queryAt = message.path.indexOf('?')
  const pathname = queryAt === -1 ? message.path : message.path.slice(0, queryAt)
  const relative = pathname === '/site' ? '/' : pathname.replace(/^\/site/, '') || '/'
  const fsPath = relative === '/' ? '/www/site' : `/www/site${relative}`
  const method = message.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    const node = lookup(root, fsPath)
    if (node instanceof File && !fsPath.endsWith('.php')) {
      const ext = fsPath.slice(fsPath.lastIndexOf('.') + 1).toLowerCase()
      const bytes = method === 'HEAD' ? new Uint8Array() : node.data
      const body = bytes.slice().buffer
      return { status: 200, headers: [['Content-Type', MIME[ext] ?? 'application/octet-stream']], body }
    }
  }
  if (!php) return { status: 503, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: new TextEncoder().encode('p8 is still starting').buffer }
  const stdin = encodeRequest(method, message.path, location.origin, message.headers, new Uint8Array(message.body))
  const result = runPhp(php, PHP_ARGS, root, stdin)
  if (!result.stdout.length) {
    const body = new TextEncoder().encode(result.stderr || 'p8 returned an empty response')
    return { status: 502, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: body.buffer }
  }
  const parsed = parseHttpResponse(result.stdout)
  scheduleSave()
  return { status: parsed.status, headers: parsed.headers, body: new Uint8Array(parsed.body).buffer }
}

navigator.serviceWorker.addEventListener('message', (event) => {
  const port = event.ports[0]
  const data = event.data as { type?: string; method: string; path: string; headers: [string, string][]; body: ArrayBuffer } | null
  if (!port || data?.type !== 'request') return
  void enqueue(() => answer(data)).then((result) => {
    port.postMessage(result, [result.body])
  }, (error: unknown) => {
    const body = new TextEncoder().encode(error instanceof Error ? error.message : String(error))
    port.postMessage({ status: 500, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: body.buffer }, [body.buffer])
  })
})

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
  setStatus('Starting…')
  const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => resolve(), 3000)
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.clearTimeout(timer)
        resolve()
      }, { once: true })
    })
    if (!navigator.serviceWorker.controller) {
      if (sessionStorage.getItem('p8-sw') !== '1') {
        sessionStorage.setItem('p8-sw', '1')
        location.reload()
        return
      }
    }
  }
  registration.update().catch(() => undefined)

  setStatus('Loading PHP…')
  const zipPromise = loadZip()
  php = await compilePhp('/php2.wasm')
  setStatus('Unpacking WordPress…')
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
  ready = true
  setStatus('')
  frame.src = '/site/'
}

resetButton.addEventListener('click', () => {
  if (!ready) return
  if (!confirm('Clear this browser’s changes and restore the installed site?')) return
  const request = indexedDB.deleteDatabase('p8-wordpress')
  request.onsuccess = () => location.reload()
  request.onerror = () => location.reload()
})

window.addEventListener('pagehide', () => { void persist() })

void boot().catch((error: unknown) => {
  setStatus(error instanceof Error ? error.message : String(error))
})
