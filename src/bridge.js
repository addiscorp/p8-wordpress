(() => {
const ORIGIN = __ORIGIN__
const PAGE = __PAGE__
const pending = new Map()
let seq = 0

function memoryStorage() {
  const store = new Map()
  return {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => { store.set(String(key), String(value)) },
    removeItem: (key) => { store.delete(String(key)) },
    clear: () => { store.clear() },
    key: (index) => [...store.keys()][index] ?? null,
    get length() { return store.size },
  }
}
try {
  localStorage.length
} catch {
  const local = memoryStorage()
  const session = memoryStorage()
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => local })
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => session })
  } catch { /* The sandbox keeps the native getter. */ }
}

function ask(message, transfer) {
  const id = ++seq
  return new Promise((resolve) => {
    pending.set(id, resolve)
    parent.postMessage({ ...message, id }, '*', transfer || [])
  })
}

function isSite(url) {
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === ORIGIN && (url.pathname === '/site' || url.pathname.startsWith('/site/'))
}

function siteUrl(value) {
  try {
    return new URL(value, ORIGIN + PAGE)
  } catch {
    return null
  }
}

function encodeBody(body) {
  if (body == null) return Promise.resolve(new ArrayBuffer(0))
  if (typeof body === 'string') {
    const encoded = new TextEncoder().encode(body)
    return Promise.resolve(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength))
  }
  if (body instanceof ArrayBuffer) return Promise.resolve(body)
  if (ArrayBuffer.isView(body)) return Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
  try {
    return new Request('https://p8.invalid/', { method: 'POST', body }).arrayBuffer()
  } catch {
    return Promise.resolve(new ArrayBuffer(0))
  }
}

if (typeof window.__p8OnMessage === 'function') window.removeEventListener('message', window.__p8OnMessage)
window.__p8OnMessage = (event) => {
  if (event.source !== parent) return
  if (event.data?.type === 'render' && typeof event.data.html === 'string') {
    document.open()
    document.write(event.data.html)
    document.close()
    return
  }
  if (event.data?.type !== 'reply') return
  const resolve = pending.get(event.data.id)
  if (!resolve) return
  pending.delete(event.data.id)
  resolve(event.data)
}
window.addEventListener('message', window.__p8OnMessage)

function go(method, path, headers, body) {
  const bytes = body || new ArrayBuffer(0)
  parent.postMessage({ type: 'navigate', method, path, headers: headers || [], body: bytes }, '*', bytes.byteLength ? [bytes] : [])
}

document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!link || link.hasAttribute('download')) return
  const url = siteUrl(link.href)
  if (!url || !isSite(url)) return
  if (url.pathname + url.search === PAGE) return
  event.preventDefault()
  go('GET', url.pathname + url.search)
}, true)

document.addEventListener('submit', (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  const url = siteUrl(form.action || PAGE)
  if (!url || !isSite(url)) return
  event.preventDefault()
  const method = (form.method || 'GET').toUpperCase()
  if (method === 'GET') {
    const query = new URLSearchParams(new FormData(form))
    const extra = query.toString()
    go('GET', url.pathname + (extra ? `?${extra}` : ''))
    return
  }
  const request = new Request(url, { method, body: new FormData(form) })
  void request.arrayBuffer().then((body) => {
    const headers = []
    const type = request.headers.get('content-type')
    if (type) headers.push(['Content-Type', type])
    go(method, url.pathname + url.search, headers, body)
  })
}, true)

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
  const url = siteUrl(raw)
  if (!url || !isSite(url)) return nativeFetch(input, init)
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = [...new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))]
  const source = init?.body ?? (input instanceof Request ? input.body : null)
  const body = source ? await new Response(source).arrayBuffer() : new ArrayBuffer(0)
  const reply = await ask({ type: 'http', method, path: url.pathname + url.search, headers, body }, body.byteLength ? [body] : [])
  const responseHeaders = new Headers()
  for (const [name, value] of reply.headers || []) {
    try { responseHeaders.append(name, value) } catch { /* A forbidden header stays on the shell. */ }
  }
  return new Response(new Uint8Array(reply.body || []), { status: reply.status || 502, headers: responseHeaders })
}

const NativeXHR = window.XMLHttpRequest
function P8XHR() {
  const real = new NativeXHR()
  let method = 'GET'
  let url = ''
  let async = true
  const headers = []
  const listeners = {}
  let responseHeaders = []
  this.readyState = 0
  this.status = 0
  this.statusText = ''
  this.response = ''
  this.responseText = ''
  this.responseType = ''
  this.responseURL = ''
  this.upload = real.upload
  this.onreadystatechange = null
  this.onload = null
  this.onerror = null
  const emit = (type) => {
    if (type === 'readystatechange' && this.onreadystatechange) this.onreadystatechange()
    if (type === 'load' && this.onload) this.onload()
    if (type === 'error' && this.onerror) this.onerror()
    for (const fn of listeners[type] || []) fn.call(this)
  }
  const finish = (status, text, bytes) => {
    this.readyState = 4
    this.status = status
    this.statusText = status ? 'OK' : ''
    this.responseText = text
    if (this.responseType === 'arraybuffer') this.response = bytes
    else if (this.responseType === 'blob') this.response = new Blob([bytes])
    else if (this.responseType === 'json') {
      try { this.response = JSON.parse(text) } catch { this.response = null }
    } else this.response = text
    emit('readystatechange')
    emit(status ? 'load' : 'error')
  }
  this.open = (nextMethod, nextUrl, nextAsync) => {
    method = nextMethod
    url = String(nextUrl)
    async = nextAsync !== false
    this.readyState = 1
    this.responseURL = url
    emit('readystatechange')
  }
  this.setRequestHeader = (name, value) => { headers.push([name, value]) }
  this.getResponseHeader = (name) => {
    const found = responseHeaders.filter(([key]) => key.toLowerCase() === String(name).toLowerCase())
    return found.length ? found.map(([, value]) => value).join(', ') : null
  }
  this.getAllResponseHeaders = () => responseHeaders.map(([name, value]) => `${name}: ${value}`).join('\r\n')
  this.overrideMimeType = () => {}
  this.abort = () => {}
  this.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn) }
  this.removeEventListener = (type, fn) => { listeners[type] = (listeners[type] || []).filter((item) => item !== fn) }
  this.send = (body) => {
    const parsed = siteUrl(url)
    if (!parsed || !isSite(parsed)) {
      real.open(method, url, async)
      for (const [name, value] of headers) real.setRequestHeader(name, value)
      real.onreadystatechange = () => {
        this.readyState = real.readyState
        this.status = real.status
        this.responseText = real.responseText
        this.response = real.response
        emit('readystatechange')
        if (real.readyState === 4) emit('load')
      }
      real.send(body)
      return
    }
    void encodeBody(body).then((bytes) => ask({
      type: 'http',
      method: method.toUpperCase(),
      path: parsed.pathname + parsed.search,
      headers,
      body: bytes,
    }, bytes.byteLength ? [bytes] : [])).then((reply) => {
      responseHeaders = reply.headers || []
      const bytes = new Uint8Array(reply.body || [])
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      finish(reply.status || 502, new TextDecoder().decode(bytes), copy)
    }).catch(() => finish(0, '', new ArrayBuffer(0)))
  }
}
P8XHR.prototype = NativeXHR.prototype
P8XHR.UNSENT = 0
P8XHR.OPENED = 1
P8XHR.HEADERS_RECEIVED = 2
P8XHR.LOADING = 3
P8XHR.DONE = 4
window.XMLHttpRequest = P8XHR
})()
