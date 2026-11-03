import { WASI, File, OpenFile, Directory, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim'

export { Directory, File }

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function makeRoot(): Directory {
  return new Directory([
    ['tmp', new Directory([])],
    ['www', new Directory([])],
  ])
}

export function writeFile(root: Directory, path: string, data: Uint8Array): File {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error(`empty path: ${path}`)
  let dir = root
  for (const part of parts) {
    let next = dir.contents.get(part)
    if (!next) {
      next = new Directory([])
      dir.contents.set(part, next)
    }
    if (!(next instanceof Directory)) throw new Error(`${part} is not a directory`)
    dir = next
  }
  const file = new File(data)
  dir.contents.set(name, file)
  return file
}

export function lookup(root: Directory, path: string): File | Directory | null {
  let node: File | Directory = root
  for (const part of path.split('/').filter(Boolean)) {
    if (!(node instanceof Directory)) return null
    const next = node.contents.get(part)
    if (!next) return null
    if (!(next instanceof File) && !(next instanceof Directory)) return null
    node = next
  }
  return node
}

export function removeFile(root: Directory, path: string): void {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) return
  let dir: File | Directory = root
  for (const part of parts) {
    if (!(dir instanceof Directory)) return
    const next = dir.contents.get(part)
    if (!next || !(next instanceof Directory)) return
    dir = next
  }
  if (dir instanceof Directory) dir.contents.delete(name)
}

export function* walk(dir: Directory, prefix = ''): Generator<[string, File | Directory]> {
  for (const [name, node] of dir.contents) {
    const path = prefix ? `${prefix}/${name}` : name
    if (node instanceof Directory) {
      yield [path, node]
      yield* walk(node, path)
    } else if (node instanceof File) {
      yield [path, node]
    }
  }
}

export async function compilePhp(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not download p8 (${response.status})`)
  try {
    return await WebAssembly.compileStreaming(response)
  } catch {
    const again = await fetch(url)
    if (!again.ok) throw new Error(`Could not download p8 (${again.status})`)
    return WebAssembly.compile(await again.arrayBuffer())
  }
}

export type RunResult = { status: number; stdout: Uint8Array; stderr: string }

export async function runPhp(module: WebAssembly.Module, args: string[], root: Directory, stdin: Uint8Array = new Uint8Array()): Promise<RunResult> {
  const out: Uint8Array[] = []
  const err: Uint8Array[] = []
  const wasi = new WASI(args, ['HOME=/tmp', 'TMPDIR=/tmp', 'TMP=/tmp'], [
    new OpenFile(new File(stdin)),
    new ConsoleStdout((bytes) => { out.push(copyBytes(bytes)) }),
    new ConsoleStdout((bytes) => { err.push(copyBytes(bytes)) }),
    new PreopenDirectory('/', root.contents),
  ], { debug: false })
  // Chrome rejects `new WebAssembly.Instance` on the main thread above 8MB.
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport })
  let status = 0
  try {
    status = wasi.start(instance)
  } catch (error) {
    status = 1
    const message = error instanceof Error ? error.message : String(error)
    err.push(encoder.encode(message))
  }
  return { status, stdout: concat(out), stderr: decoder.decode(concat(err)) }
}

export function parseHttpResponse(raw: Uint8Array): { status: number; headers: [string, string][]; body: Uint8Array } {
  let split = raw.length
  for (let i = 0; i + 3 < raw.length; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      split = i
      break
    }
  }
  const head = decoder.decode(raw.subarray(0, split))
  const lines = head.split('\r\n')
  const status = Number(lines[0]?.split(' ')[1] ?? 502)
  const headers: [string, string][] = []
  for (const line of lines.slice(1)) {
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
  }
  const body = split < raw.length ? raw.subarray(split + 4) : new Uint8Array()
  return { status: Number.isFinite(status) ? status : 502, headers, body }
}

export function encodeRequest(method: string, path: string, origin: string, headers: [string, string][], body: Uint8Array): Uint8Array {
  const host = new URL(origin).host
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, `X-P8-Origin: ${origin}`]
  for (const [name, value] of headers) {
    const key = name.toLowerCase()
    if (key === 'host' || key === 'content-length' || key === 'x-p8-origin' || key === 'connection' || key === 'accept-encoding') continue
    lines.push(`${name}: ${value}`)
  }
  if (body.byteLength > 0 || method === 'POST' || method === 'PUT' || method === 'PATCH') {
    lines.push(`Content-Length: ${body.byteLength}`)
  }
  const head = encoder.encode(`${lines.join('\r\n')}\r\n\r\n`)
  const out = new Uint8Array(head.length + body.length)
  out.set(head)
  out.set(body, head.length)
  return out
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
