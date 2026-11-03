import bridgeSource from './bridge.js?raw'
import { preparePage } from './prepare'

const statusEl = document.querySelector<HTMLSpanElement>('#status')!
const frame = document.querySelector<HTMLIFrameElement>('#site')!
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!
const origin = location.origin

type Reply = { status: number; headers: [string, string][]; body: ArrayBuffer; path: string }

let ready = false
let frameReady = false
let shown = false
let generation = 0
let nextId = 1
let php: Worker | null = null
const pending = new Map<number, (reply: { status: number; headers: [string, string][]; body: ArrayBuffer }) => void>()
const jar = new Map<string, string>()

function setStatus(text: string) {
  statusEl.textContent = text
}

function isSitePath(path: string): boolean {
  const pathname = path.split('?')[0].split('#')[0]
  if (pathname.includes('\\') || pathname.includes('\0')) return false
  if (pathname.split('/').includes('..')) return false
  return pathname === '/site' || pathname.startsWith('/site/')
}

function rememberSetCookie(header: string) {
  const parts = header.split(';').map((part) => part.trim())
  const eq = parts[0].indexOf('=')
  if (eq <= 0) return
  const name = parts[0].slice(0, eq).trim()
  const value = parts[0].slice(eq + 1).trim()
  let expired = value === ''
  for (const part of parts.slice(1)) {
    const split = part.indexOf('=')
    const key = (split === -1 ? part : part.slice(0, split)).trim().toLowerCase()
    const setting = split === -1 ? '' : part.slice(split + 1).trim()
    if (key === 'max-age' && Number(setting) <= 0) expired = true
    if (key === 'expires') {
      const when = Date.parse(setting)
      if (!Number.isNaN(when) && when <= Date.now()) expired = true
    }
  }
  if (expired) jar.delete(name)
  else jar.set(name, value)
}

function cookieHeader(): string {
  if (!jar.size) return ''
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

function bytesOf(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
}

function asBuffer(body: unknown): ArrayBuffer {
  if (body instanceof ArrayBuffer) return body
  if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  return new ArrayBuffer(0)
}

function requestPhp(method: string, path: string, headers: [string, string][], body: ArrayBuffer) {
  return new Promise<{ status: number; headers: [string, string][]; body: ArrayBuffer }>((resolve) => {
    if (!php) {
      resolve({ status: 503, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: bytesOf('p8 is still starting') })
      return
    }
    const id = nextId++
    const timer = window.setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      resolve({ status: 504, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: bytesOf('p8 timed out') })
    }, 180000)
    pending.set(id, (reply) => {
      window.clearTimeout(timer)
      resolve(reply)
    })
    const bytes = body.byteLength ? body : new ArrayBuffer(0)
    php.postMessage({ type: 'http', id, method, path, headers, body: bytes }, bytes.byteLength ? [bytes] : [])
  })
}

function redirectTarget(locationHeader: string, currentPath: string): string | null {
  let url: URL
  try {
    url = new URL(locationHeader, origin + currentPath)
  } catch {
    return null
  }
  if (url.origin !== origin || !isSitePath(url.pathname)) return null
  return url.pathname + url.search
}

async function requestFollow(method: string, path: string, headers: [string, string][], body: ArrayBuffer, redirects = 0): Promise<Reply> {
  if (!isSitePath(path)) throw new Error('Refusing a path outside /site')
  const nextHeaders = headers.filter(([name]) => name.toLowerCase() !== 'cookie' && name.toLowerCase() !== 'host')
  const cookie = cookieHeader()
  if (cookie) nextHeaders.push(['Cookie', cookie])
  const reply = await requestPhp(method, path, nextHeaders, body)
  for (const [name, value] of reply.headers) {
    if (name.toLowerCase() === 'set-cookie') rememberSetCookie(value)
  }
  const kept = reply.headers.filter(([name]) => {
    const key = name.toLowerCase()
    return key !== 'set-cookie' && key !== 'content-length' && key !== 'transfer-encoding' && key !== 'connection' && key !== 'keep-alive'
  })
  if ((reply.status === 301 || reply.status === 302 || reply.status === 303) && redirects < 8) {
    const locationHeader = reply.headers.find(([name]) => name.toLowerCase() === 'location')?.[1]
    const next = locationHeader ? redirectTarget(locationHeader, path) : null
    if (next) return requestFollow('GET', next, [], new ArrayBuffer(0), redirects + 1)
  }
  return { status: reply.status, headers: kept, body: reply.body, path }
}

function contentType(reply: Reply): string {
  return reply.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1]?.toLowerCase() ?? ''
}

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (char) => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;')
}

async function showPath(path: string, method = 'GET', headers: [string, string][] = [], body = new ArrayBuffer(0)) {
  const gen = ++generation
  setStatus('Loading WordPress…')
  try {
    const reply = await requestFollow(method, path, headers, body)
    if (gen !== generation || !frame.contentWindow) return
    const type = contentType(reply)
    const text = new TextDecoder().decode(new Uint8Array(reply.body))
    let html: string
    if (!type.includes('html')) {
      html = `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(text)}</pre>`
    } else {
      const bridge = bridgeSource.replaceAll('__ORIGIN__', JSON.stringify(origin)).replaceAll('__PAGE__', JSON.stringify(reply.path))
      html = await preparePage(text, origin, reply.path, bridge, (assetPath) => requestFollow('GET', assetPath, [], new ArrayBuffer(0)))
    }
    if (gen !== generation || !frame.contentWindow) return
    frame.contentWindow.postMessage({ type: 'render', html }, '*')
    setStatus('')
  } catch (error) {
    if (gen !== generation) return
    setStatus(error instanceof Error ? error.message : String(error))
  }
}

function maybeShow() {
  if (!ready || !frameReady || shown) return
  shown = true
  void showPath('/site/')
}

function startWorker() {
  const worker = new Worker(new URL('./php/worker.ts', import.meta.url), { type: 'module' })
  php = worker
  worker.onmessage = (event: MessageEvent<{ type?: string; text?: string; message?: string; id?: number; status?: number; headers?: [string, string][]; body?: ArrayBuffer }>) => {
    const data = event.data
    if (data.type === 'status') {
      setStatus(data.text ?? '')
      return
    }
    if (data.type === 'ready') {
      ready = true
      setStatus('')
      maybeShow()
      return
    }
    if (data.type === 'error') {
      setStatus(data.message ?? 'p8 failed')
      return
    }
    if (data.type === 'reset-done') {
      location.reload()
      return
    }
    if (data.type !== 'http' || data.id == null) return
    const resolve = pending.get(data.id)
    pending.delete(data.id)
    if (!resolve) return
    resolve({ status: data.status ?? 502, headers: data.headers ?? [], body: data.body ?? new ArrayBuffer(0) })
  }
  worker.onerror = (event) => {
    setStatus(event.message || 'p8 failed')
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return
  const data = event.data as { type?: string; id?: number; method?: string; path?: string; headers?: [string, string][]; body?: ArrayBuffer }
  if (data.type === 'frame-ready') {
    frameReady = true
    maybeShow()
    return
  }
  if (data.type === 'navigate' && typeof data.path === 'string' && isSitePath(data.path)) {
    void showPath(data.path, (data.method || 'GET').toUpperCase(), data.headers ?? [], asBuffer(data.body))
    return
  }
  if (data.type !== 'http' || data.id == null || !frame.contentWindow) return
  const replyTo = (status: number, headers: [string, string][], body: ArrayBuffer) => {
    frame.contentWindow?.postMessage({ type: 'reply', id: data.id, status, headers, body }, '*', body.byteLength ? [body] : [])
  }
  if (typeof data.path !== 'string' || !isSitePath(data.path)) {
    replyTo(400, [['Content-Type', 'text/plain; charset=utf-8']], bytesOf('Refusing a path outside /site'))
    return
  }
  void requestFollow((data.method || 'GET').toUpperCase(), data.path, data.headers ?? [], asBuffer(data.body))
    .then((reply) => replyTo(reply.status, reply.headers, reply.body))
    .catch((error: unknown) => replyTo(502, [['Content-Type', 'text/plain; charset=utf-8']], bytesOf(error instanceof Error ? error.message : String(error))))
})

async function boot() {
  setStatus('Starting…')
  const registrations = await navigator.serviceWorker.getRegistrations()
  if (navigator.serviceWorker.controller) {
    await Promise.all(registrations.map((registration) => registration.unregister()))
    if (sessionStorage.getItem('p8-sw-off') !== '1') {
      sessionStorage.setItem('p8-sw-off', '1')
      location.reload()
      return
    }
  } else if (registrations.length) {
    await Promise.all(registrations.map((registration) => registration.unregister()))
  }
  startWorker()
}

resetButton.addEventListener('click', () => {
  if (!ready || !php) return
  if (!confirm('Clear this browser’s changes and restore the installed site?')) return
  ready = false
  php.postMessage({ type: 'reset' })
})

window.addEventListener('pagehide', () => {
  php?.postMessage({ type: 'persist' })
})

void boot().catch((error: unknown) => {
  setStatus(error instanceof Error ? error.message : String(error))
})
