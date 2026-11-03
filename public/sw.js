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
    headers: [...request.headers],
    body,
  }, [channel.port2, body])

  try {
    const data = await reply
    const headers = new Headers()
    for (const [name, value] of data.headers) {
      const key = name.toLowerCase()
      if (key === 'content-length' || key === 'transfer-encoding' || key === 'connection' || key === 'keep-alive') continue
      headers.append(name, value)
    }
    return new Response(data.body, { status: data.status || 502, headers })
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'p8 failed', { status: 504 })
  }
}
