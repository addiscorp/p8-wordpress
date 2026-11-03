type Reply = { status: number; headers: [string, string][]; body: ArrayBuffer }

const MAX_ASSET = 12 * 1024 * 1024

function header(reply: Reply, name: string): string {
  return reply.headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? ''
}

function mime(path: string, claimed: string): string {
  const clean = claimed.split(';')[0].trim()
  if (clean && clean !== 'application/octet-stream') return clean
  const file = path.split('?')[0]
  if (file.endsWith('.css') || path.includes('load-styles.php')) return 'text/css'
  if (file.endsWith('.js') || path.includes('load-scripts.php')) return 'text/javascript'
  if (file.endsWith('.woff2')) return 'font/woff2'
  if (file.endsWith('.woff')) return 'font/woff'
  if (file.endsWith('.ttf')) return 'font/ttf'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg'
  if (file.endsWith('.gif')) return 'image/gif'
  if (file.endsWith('.webp')) return 'image/webp'
  if (file.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}

function b64(bytes: Uint8Array): string {
  let binary = ''
  const size = 0x8000
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + size, bytes.length)))
  }
  return btoa(binary)
}

export function localPath(value: string, base: string, origin: string): string | null {
  if (!value || value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('#')) return null
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.origin !== origin) return null
  if (url.pathname !== '/site' && !url.pathname.startsWith('/site/')) return null
  return url.pathname + url.search
}

function place(node: Element, name: string, value: string) {
  node.setAttribute(name, value)
  if (!value.startsWith('data:')) return
  node.removeAttribute('integrity')
  node.removeAttribute('crossorigin')
}

export async function preparePage(html: string, origin: string, page: string, bridge: string, request: (path: string) => Promise<Reply>): Promise<string> {
  const cache = new Map<string, Promise<string>>()
  const inflight = new Set<string>()
  const pathOnly = page.split('?')[0].split('#')[0]
  const dir = pathOnly.endsWith('/') ? pathOnly : pathOnly.slice(0, pathOnly.lastIndexOf('/') + 1)
  const documentBase = `${origin}${dir || '/site/'}`

  async function asset(path: string): Promise<string> {
    const cached = cache.get(path)
    if (cached) return cached
    const loading = (async () => {
      inflight.add(path)
      try {
        const reply = await request(path)
        if (reply.status !== 200) throw new Error(`asset ${reply.status}`)
        if (reply.body.byteLength > MAX_ASSET) throw new Error('asset too large')
        const type = mime(path, header(reply, 'content-type'))
        let bytes = new Uint8Array(reply.body)
        let finalType = type
        const file = path.split('?')[0]
        if (type.includes('css') || file.endsWith('.css') || path.includes('load-styles.php')) {
          bytes = new TextEncoder().encode(await rewriteCss(new TextDecoder().decode(bytes), path))
          finalType = 'text/css'
        }
        return `data:${finalType};base64,${b64(bytes)}`
      } finally {
        inflight.delete(path)
      }
    })()
    cache.set(path, loading)
    try {
      return await loading
    } catch (error) {
      cache.delete(path)
      throw error
    }
  }

  async function rewriteCss(css: string, cssPath: string): Promise<string> {
    const base = `${origin}${cssPath.split('?')[0]}`
    const found = new Set<string>()
    const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/gi
    for (const match of css.matchAll(pattern)) {
      const raw = match[2] || match[4]
      const path = raw ? localPath(raw, base, origin) : null
      if (!path || path.split('?')[0] === cssPath.split('?')[0] || inflight.has(path)) continue
      found.add(path)
    }
    const replacements = new Map<string, string>()
    await Promise.all([...found].map(async (path) => {
      try {
        replacements.set(path, await asset(path))
      } catch {
        replacements.set(path, '')
      }
    }))
    return css.replace(pattern, (full, _quote, urlValue, _importQuote, importValue) => {
      const raw = urlValue || importValue
      const path = raw ? localPath(raw, base, origin) : null
      const next = path ? replacements.get(path) : ''
      if (!path || !next) return full
      return urlValue ? `url("${next}")` : `@import "${next}"`
    })
  }

  async function inline(value: string | null): Promise<string | null> {
    if (!value) return value
    const path = localPath(value, documentBase, origin)
    if (!path) return value
    try {
      return await asset(path)
    } catch {
      return value
    }
  }

  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const node of doc.querySelectorAll('base')) node.remove()
  const base = doc.createElement('base')
  base.href = documentBase
  const script = doc.createElement('script')
  script.textContent = bridge.replaceAll('</script', '<\\/script')
  doc.head.prepend(base, script)

  const jobs: Promise<void>[] = []
  for (const link of doc.querySelectorAll('link[href]')) {
    const rel = link.getAttribute('rel')?.toLowerCase() ?? ''
    if (!/\bstylesheet\b|\bmodulepreload\b|\bpreload\b|\bicon\b/.test(rel)) continue
    jobs.push(inline(link.getAttribute('href')).then((value) => { if (value) place(link, 'href', value) }))
  }
  for (const node of doc.querySelectorAll('script[src], img[src], audio[src], video[src], source[src], embed[src]')) {
    jobs.push(inline(node.getAttribute('src')).then((value) => { if (value) place(node, 'src', value) }))
  }
  for (const node of doc.querySelectorAll('img[srcset], source[srcset]')) {
    const srcset = node.getAttribute('srcset')
    if (!srcset) continue
    jobs.push((async () => {
      const parts = await Promise.all(srcset.split(',').map(async (part) => {
        const bits = part.trim().split(/\s+/)
        const value = await inline(bits[0])
        if (value) bits[0] = value
        return bits.join(' ')
      }))
      node.setAttribute('srcset', parts.join(', '))
    })())
  }
  for (const style of doc.querySelectorAll('style')) {
    jobs.push(rewriteCss(style.textContent || '', `${dir}inline.css`).then((css) => { style.textContent = css }))
  }
  for (const map of doc.querySelectorAll('script[type="importmap"]')) {
    jobs.push((async () => {
      try {
        const json = JSON.parse(map.textContent || '{}') as { imports?: Record<string, string> }
        for (const [key, value] of Object.entries(json.imports ?? {})) {
          json.imports![key] = await inline(value) ?? value
        }
        map.textContent = JSON.stringify(json)
      } catch {
        // A broken import map stays as WordPress sent it.
      }
    })())
  }
  await Promise.all(jobs)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}
