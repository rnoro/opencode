type VscodeApi = { postMessage(msg: unknown): void }

declare function acquireVsCodeApi(): VscodeApi

let _vscode: VscodeApi | undefined

export function getVscodeApi(): VscodeApi {
  if (!_vscode) {
    _vscode = acquireVsCodeApi()
  }
  return _vscode
}

type PendingFetch = {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  streamController?: ReadableStreamDefaultController<Uint8Array>
}

const pending = new Map<string, PendingFetch>()

function handleMessage(event: MessageEvent) {
  const msg = event.data
  if (!msg || !msg.type || !msg.id) return

  const entry = pending.get(msg.id)
  if (!entry) return

  switch (msg.type) {
    case "fetch-response": {
      pending.delete(msg.id)
      const body = Array.isArray(msg.bodyBytes)
        ? Uint8Array.from(msg.bodyBytes)
        : typeof msg.body === "string"
          ? new TextEncoder().encode(msg.body)
          : null
      entry.resolve(
        new Response(body, {
          status: msg.status,
          statusText: msg.statusText ?? "",
          headers: new Headers(msg.headers ?? {}),
        }),
      )
      break
    }

    case "fetch-response-head": {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          entry.streamController = controller
        },
        cancel() {
          pending.delete(msg.id)
          getVscodeApi().postMessage({ type: "fetch-stream-cancel", id: msg.id })
        },
      })
      entry.resolve(
        new Response(stream, {
          status: msg.status,
          statusText: msg.statusText ?? "",
          headers: new Headers(msg.headers ?? {}),
        }),
      )
      break
    }

    case "fetch-stream-chunk": {
      if (!entry.streamController) break
      if (msg.done) {
        entry.streamController.close()
        pending.delete(msg.id)
      } else if (Array.isArray(msg.bytes)) {
        entry.streamController.enqueue(Uint8Array.from(msg.bytes))
      } else if (typeof msg.chunk === "string") {
        entry.streamController.enqueue(new TextEncoder().encode(msg.chunk))
      }
      break
    }

    case "fetch-error": {
      pending.delete(msg.id)
      entry.reject(new Error(msg.error ?? "fetch failed"))
      break
    }
  }
}

let listening = false

function ensureListener() {
  if (listening) return
  listening = true
  window.addEventListener("message", handleMessage)
}

export function vscodeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  ensureListener()

  const id = crypto.randomUUID()
  const request = new Request(input, init)

  return request.text().then((body) => {
    const headers: Record<string, string> = {}
    request.headers.forEach((v, k) => {
      headers[k] = v
    })

    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject })

      getVscodeApi().postMessage({
        type: "fetch",
        id,
        url: request.url,
        method: request.method,
        headers,
        body: body || null,
      })

      if (init?.signal) {
        init.signal.addEventListener("abort", () => {
          const entry = pending.get(id)
          if (entry) {
            pending.delete(id)
            if (entry.streamController) {
              try {
                entry.streamController.close()
              } catch {}
            }
            entry.reject(new DOMException("The operation was aborted.", "AbortError"))
            getVscodeApi().postMessage({ type: "fetch-stream-cancel", id })
          }
        })
      }
    })
  })
}
