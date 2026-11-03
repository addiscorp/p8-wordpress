const jar = new Map()

function rememberSetCookie(header) {
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

function cookieHeader(existing) {
  const merged = new Map()
  if (existing) {
    for (const part of existing.split(';')) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      merged.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
  }
  for (const [name, value] of jar) merged.set(name, value)
  if (!merged.size) return ''
  return [...merged].map(([name, value]) => `${name}=${value}`).join('; ')
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname !== '/site' && !url.pathname.startsWith('/site/')) return
  event.respondWith(proxy(event.request))
})

async function proxy(request) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const shell = clients.find((client) => {
    const path = new URL(client.url).pathname
    return path === '/' || path === '/index.html'
  })
  if (!shell) {
    return new Response('Open the p8 WordPress page to start PHP.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const url = new URL(request.url)
  const body = request.method === 'GET' || request.method === 'HEAD' ? new ArrayBuffer(0) : await request.arrayBuffer()
  const headers = [...request.headers]
  const cookieAt = headers.findIndex(([name]) => name.toLowerCase() === 'cookie')
  const baked = cookieHeader(cookieAt === -1 ? '' : headers[cookieAt][1])
  if (baked) {
    if (cookieAt === -1) headers.push(['Cookie', baked])
    else headers[cookieAt][1] = baked
  }
  const channel = new MessageChannel()
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('p8 timed out')), 120000)
    channel.port1.onmessage = (event) => {
      clearTimeout(timer)
      resolve(event.data)
    }
  })
  shell.postMessage({
    type: 'request',
    method: request.method,
    path: url.pathname + url.search,
    headers,
    body,
  }, [channel.port2, body])

  try {
    const data = await reply
    const responseHeaders = new Headers()
    for (const [name, value] of data.headers) {
      const key = name.toLowerCase()
      if (key === 'set-cookie') {
        rememberSetCookie(value)
        continue
      }
      if (key === 'content-length' || key === 'transfer-encoding' || key === 'connection' || key === 'keep-alive') continue
      try {
        responseHeaders.append(name, value)
      } catch {
        // A forbidden response header must not fail the whole page.
      }
    }
    return new Response(data.body, { status: data.status || 502, headers: responseHeaders })
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'p8 failed', { status: 504 })
  }
}
