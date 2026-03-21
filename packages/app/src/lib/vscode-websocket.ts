import { getVscodeApi } from "./vscode-fetch"

type WSListener = (event: any) => void

export class VscodeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState = VscodeWebSocket.CONNECTING
  binaryType: BinaryType = "blob"
  bufferedAmount = 0
  extensions = ""
  protocol = ""
  url: string

  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null

  private _id: string
  private _handler: (event: MessageEvent) => void

  constructor(url: string | URL, _protocols?: string | string[]) {
    super()
    this.url = String(url)
    this._id = crypto.randomUUID()

    this._handler = (event: MessageEvent) => {
      const msg = event.data
      if (!msg || msg.id !== this._id) return

      switch (msg.type) {
        case "ws-open": {
          this.readyState = VscodeWebSocket.OPEN
          const ev = new Event("open")
          this.onopen?.(ev)
          this.dispatchEvent(ev)
          break
        }
        case "ws-message": {
          let data: string | ArrayBuffer
          if (Array.isArray(msg.data)) {
            data = new Uint8Array(msg.data).buffer
          } else {
            data = msg.data
          }
          const ev = new MessageEvent("message", { data })
          this.onmessage?.(ev)
          this.dispatchEvent(ev)
          break
        }
        case "ws-error": {
          const ev = new Event("error")
          this.onerror?.(ev)
          this.dispatchEvent(ev)
          break
        }
        case "ws-close": {
          this.readyState = VscodeWebSocket.CLOSED
          window.removeEventListener("message", this._handler)
          const ev = new CloseEvent("close", {
            code: msg.code ?? 1000,
            reason: msg.reason ?? "",
            wasClean: true,
          })
          this.onclose?.(ev)
          this.dispatchEvent(ev)
          break
        }
      }
    }

    window.addEventListener("message", this._handler)

    getVscodeApi().postMessage({
      type: "ws-open",
      id: this._id,
      url: this.url,
    })
  }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== VscodeWebSocket.OPEN) {
      throw new DOMException("WebSocket is not open", "InvalidStateError")
    }

    let payload: string | number[]
    if (typeof data === "string") {
      payload = data
    } else if (data instanceof ArrayBuffer) {
      payload = Array.from(new Uint8Array(data))
    } else {
      payload = Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    }

    getVscodeApi().postMessage({
      type: "ws-send",
      id: this._id,
      data: payload,
    })
  }

  close(code?: number, reason?: string) {
    if (this.readyState === VscodeWebSocket.CLOSED || this.readyState === VscodeWebSocket.CLOSING) return
    this.readyState = VscodeWebSocket.CLOSING
    getVscodeApi().postMessage({
      type: "ws-close",
      id: this._id,
      code: code ?? 1000,
      reason: reason ?? "",
    })
  }
}
