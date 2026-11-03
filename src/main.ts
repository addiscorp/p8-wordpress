const statusEl = document.querySelector<HTMLSpanElement>('#status')!
const frame = document.querySelector<HTMLIFrameElement>('#site')!
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!

let ready = false
let nextId = 1
let php: Worker | null = null
const pending = new Map<number, MessagePort>()

function setStatus(text: string) {
  statusEl.textContent = text
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
      frame.src = '/site/'
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
    const port = pending.get(data.id)
    pending.delete(data.id)
    if (!port) return
    const body = data.body ?? new ArrayBuffer(0)
    port.postMessage({ status: data.status ?? 502, headers: data.headers ?? [], body }, [body])
  }
  worker.onerror = (event) => {
    setStatus(event.message || 'p8 failed')
  }
}

navigator.serviceWorker.addEventListener('message', (event) => {
  const port = event.ports[0]
  const data = event.data as { type?: string; method: string; path: string; headers: [string, string][]; body: ArrayBuffer } | null
  if (!port || data?.type !== 'request') return
  if (!php) {
    const body = new TextEncoder().encode('p8 is still starting').buffer
    port.postMessage({ status: 503, headers: [['Content-Type', 'text/plain; charset=utf-8']], body }, [body])
    return
  }
  const id = nextId++
  pending.set(id, port)
  const body = data.body ?? new ArrayBuffer(0)
  php.postMessage({ type: 'http', id, method: data.method, path: data.path, headers: data.headers, body }, [body])
})

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
