/* eslint-disable semi */
import * as vscode from "vscode"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { WebSocket } from "ws"

const TERMINAL_NAME = "opencode"
const PRIMARY_VIEW = "opencode.sidebar.primary"
const SECONDARY_VIEW = "opencode.sidebar.secondary"
const SECONDARY_CONTEXT = "opencode.secondarySidebarSupported"
const SESSION_DIFF_SCHEME = "opencode-session-diff"

class SessionDiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private docs = new Map<string, string>()
  private emitter = new vscode.EventEmitter<vscode.Uri>()

  readonly onDidChange = this.emitter.event

  set(uri: vscode.Uri, value: string) {
    this.docs.set(uri.toString(), value)
    this.emitter.fire(uri)
  }

  provideTextDocumentContent(uri: vscode.Uri) {
    return this.docs.get(uri.toString()) ?? ""
  }

  dispose() {
    this.docs.clear()
    this.emitter.dispose()
  }
}

export function deactivate() {}

export function activate(context: vscode.ExtensionContext) {
  const manager = new ServerManager()
  const diffProvider = new SessionDiffContentProvider()
  const provider = new SidebarProvider(manager, diffProvider, context.extensionUri)

  context.subscriptions.push(
    manager,
    diffProvider,
    vscode.workspace.registerTextDocumentContentProvider(SESSION_DIFF_SCHEME, diffProvider),
    vscode.window.registerWebviewViewProvider(PRIMARY_VIEW, provider),
    vscode.window.registerWebviewViewProvider(SECONDARY_VIEW, provider),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
  )

  void vscode.commands.executeCommand("setContext", SECONDARY_CONTEXT, supportsSecondarySidebar())

  const openTerminalDisposable = vscode.commands.registerCommand("opencode.openTerminal", async () => {
    await openTerminal(context, false)
  })

  const openNewTerminalDisposable = vscode.commands.registerCommand("opencode.openNewTerminal", async () => {
    await openTerminal(context, true)
  })

  const addFilepathDisposable = vscode.commands.registerCommand("opencode.addFilepathToTerminal", async () => {
    const fileRef = getActiveFileRef()
    if (!fileRef) {
      return
    }

    const terminal = vscode.window.activeTerminal
    if (terminal?.name === TERMINAL_NAME) {
      terminal.sendText(fileRef, false)
      terminal.show()
      return
    }

    const local = manager.localUrl()
    if (!local) {
      vscode.window.showInformationMessage("Open opencode sidebar first")
      return
    }

    await appendPrompt(local, fileRef)
  })

  context.subscriptions.push(openTerminalDisposable, openNewTerminalDisposable, addFilepathDisposable)
}

class SidebarProvider implements vscode.WebviewViewProvider {
  private views = new Set<vscode.WebviewView>()

  constructor(
    private manager: ServerManager,
    private diffProvider: SessionDiffContentProvider,
    private extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.views.add(view)
    view.onDidDispose(() => {
      this.views.delete(view)
    })

    const webviewDir = vscode.Uri.joinPath(this.extensionUri, "dist", "webview")
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewDir],
    }
    void this.render(view)
  }

  refresh() {
    for (const view of this.views) {
      void this.render(view)
    }
  }

  private async render(view: vscode.WebviewView) {
    const root = getWorkspaceRoot()
    if (!root) {
      view.webview.html = emptyWorkspaceHtml()
      return
    }

    try {
      const local = await this.manager.ensureRunning(root)
      await waitForServer(local)

      const webviewDir = vscode.Uri.joinPath(this.extensionUri, "dist", "webview")
      const indexPath = join(this.extensionUri.fsPath, "dist", "webview", "index-vscode.html")
      let html = readFileSync(indexPath, "utf-8")

      // Rewrite asset paths to webview URIs
      html = html.replace(/(href|src)="(\/[^"]+)"/g, (_match, attr, path) => {
        const assetUri = view.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, path))
        return `${attr}="${assetUri}"`
      })

      // Inject server URL and CSP
      const nonce = createNonce()
      const cspMeta = webviewCsp(view.webview.cspSource, nonce)
      const serverScript = webviewServerScript(local, nonce)

      html = html.replace("<head>", `<head>\n${cspMeta}\n${serverScript}`)

      view.webview.html = html

      // Set up message handler
      const disposable = view.webview.onDidReceiveMessage((msg) =>
        handleWebviewMessage(view.webview, local, msg, this.diffProvider),
      )
      view.onDidDispose(() => disposable.dispose())
    } catch (error) {
      view.webview.html = failureHtml(error)
    }
  }
}

// --- PostMessage proxy handlers ---

const activeFetches = new Map<string, AbortController>()
const activeWebSockets = new Map<string, WebSocket>()

async function handleWebviewMessage(
  webview: vscode.Webview,
  serverUrl: string,
  msg: any,
  diffProvider: SessionDiffContentProvider,
) {
  if (!msg || !msg.type) {
    return
  }

  switch (msg.type) {
    case "fetch":
      return handleFetch(webview, serverUrl, msg)
    case "fetch-stream-cancel":
      return handleFetchCancel(msg)
    case "ws-open":
      return handleWsOpen(webview, serverUrl, msg)
    case "ws-send":
      return handleWsSend(msg)
    case "ws-close":
      return handleWsClose(msg)
    case "open-external":
      if (msg.url) {
        void vscode.env.openExternal(vscode.Uri.parse(msg.url))
      }
      return
    case "open-session-diff":
      return handleOpenSessionDiff(serverUrl, msg, diffProvider)
  }
}

async function handleFetch(webview: vscode.Webview, serverUrl: string, msg: any) {
  const { id, url, method, headers, body } = msg

  const abort = new AbortController()
  activeFetches.set(id, abort)

  try {
    const resolvedUrl = resolveServerHttpUrl(serverUrl, url)

    const response = await fetch(resolvedUrl, {
      method,
      headers,
      body: body ?? undefined,
      signal: abort.signal,
    })

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v
    })

    if (response.body) {
      // Streaming response: send head first, then chunks
      webview.postMessage({
        type: "fetch-response-head",
        id,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })

      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            webview.postMessage({ type: "fetch-stream-chunk", id, chunk: "", done: true })
            break
          }

          const chunk = value ?? new Uint8Array()
          if (chunk.length === 0) {
            continue
          }
          for (let index = 0; index < chunk.length; index += 16384) {
            const slice = chunk.subarray(index, index + 16384)
            webview.postMessage({
              type: "fetch-stream-chunk",
              id,
              bytes: Array.from(slice),
              done: false,
            })
          }
        }
      } catch (err) {
        webview.postMessage({ type: "fetch-stream-chunk", id, chunk: "", done: true })
      }
    } else {
      // Non-streaming: read full body and send
      const text = await response.text()
      webview.postMessage({
        type: "fetch-response",
        id,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: text,
      })
    }
  } catch (err: any) {
    if (err?.name !== "AbortError") {
      webview.postMessage({
        type: "fetch-error",
        id,
        error: err?.message ?? "fetch failed",
      })
    }
  } finally {
    activeFetches.delete(id)
  }
}

function handleFetchCancel(msg: any) {
  const abort = activeFetches.get(msg.id)
  if (abort) {
    abort.abort()
    activeFetches.delete(msg.id)
  }
}

function handleWsOpen(webview: vscode.Webview, serverUrl: string, msg: any) {
  const { id } = msg
  const url = resolveServerWsUrl(serverUrl, msg.url)

  const ws = new WebSocket(url)
  ws.binaryType = "arraybuffer"
  activeWebSockets.set(id, ws)

  ws.on("open", () => {
    webview.postMessage({ type: "ws-open", id })
  })

  ws.on("message", (data: Buffer | ArrayBuffer | string) => {
    if (typeof data === "string") {
      webview.postMessage({ type: "ws-message", id, data })
    } else {
      const buf = data instanceof ArrayBuffer ? Buffer.from(data) : data
      webview.postMessage({ type: "ws-message", id, data: Array.from(buf) })
    }
  })

  ws.on("error", () => {
    webview.postMessage({ type: "ws-error", id })
  })

  ws.on("close", (code: number, reason: Buffer) => {
    activeWebSockets.delete(id)
    webview.postMessage({
      type: "ws-close",
      id,
      code,
      reason: reason.toString(),
    })
  })
}

function handleWsSend(msg: any) {
  const ws = activeWebSockets.get(msg.id)
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return
  }

  if (typeof msg.data === "string") {
    ws.send(msg.data)
  } else if (Array.isArray(msg.data)) {
    ws.send(Buffer.from(msg.data))
  }
}

function handleWsClose(msg: any) {
  const ws = activeWebSockets.get(msg.id)
  if (!ws) {
    return
  }
  activeWebSockets.delete(msg.id)
  ws.close(msg.code ?? 1000, msg.reason ?? "")
}

function isWebviewOrigin(url: URL) {
  const host = url.hostname
  return url.protocol.startsWith("vscode-") || host.endsWith(".vscode-cdn.net") || host.endsWith(".vscode-webview.net")
}

function resolveServerHttpUrl(serverUrl: string, value: string) {
  const server = new URL(serverUrl)
  try {
    const parsed = new URL(value)
    if (parsed.origin === server.origin) {
      return parsed.toString()
    }
    if (!isWebviewOrigin(parsed)) {
      return parsed.toString()
    }
    return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, server).toString()
  } catch {
    return new URL(value.startsWith("/") ? value : `/${value}`, server).toString()
  }
}

function resolveServerWsUrl(serverUrl: string, value: string) {
  const server = new URL(serverUrl)
  const ws = new URL(serverUrl)
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:"
  try {
    const parsed = new URL(value)
    if (parsed.origin === server.origin || isWebviewOrigin(parsed)) {
      return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, ws).toString()
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:"
    }
    return parsed.toString()
  } catch {
    return new URL(value.startsWith("/") ? value : `/${value}`, ws).toString()
  }
}

async function handleOpenSessionDiff(serverUrl: string, msg: any, provider: SessionDiffContentProvider) {
  if (!msg?.sessionID || typeof msg.sessionID !== "string") {
    return
  }

  try {
    const endpoint = new URL(`/session/${encodeURIComponent(msg.sessionID)}/diff`, serverUrl).toString()
    const response = await fetch(endpoint)
    if (!response.ok) {
      vscode.window.showErrorMessage(`Failed to load session diff (${response.status})`)
      return
    }

    const payload = await response.json()
    if (!Array.isArray(payload) || payload.length === 0) {
      vscode.window.showInformationMessage("No session changes to review")
      return
    }

    const diffs = payload.filter(
      (item): item is { file: string; before?: string; after?: string } =>
        !!item && typeof item === "object" && typeof item.file === "string",
    )
    if (diffs.length === 0) {
      vscode.window.showInformationMessage("No session changes to review")
      return
    }

    const target = typeof msg.file === "string" ? (diffs.find((diff) => diff.file === msg.file) ?? diffs[0]) : diffs[0]
    if (!target) {
      vscode.window.showInformationMessage("No session changes to review")
      return
    }

    const stamp = Date.now()
    const normalizedPath = target.file.startsWith("/") ? target.file : `/${target.file}`
    const left = vscode.Uri.from({
      scheme: SESSION_DIFF_SCHEME,
      path: normalizedPath,
      query: `session=${encodeURIComponent(msg.sessionID)}&side=before&t=${stamp}`,
    })
    const right = vscode.Uri.from({
      scheme: SESSION_DIFF_SCHEME,
      path: normalizedPath,
      query: `session=${encodeURIComponent(msg.sessionID)}&side=after&t=${stamp}`,
    })

    provider.set(left, target.before ?? "")
    provider.set(right, target.after ?? "")

    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${target.file} (session ${msg.sessionID.slice(0, 8)})`,
    )
  } catch {
    vscode.window.showErrorMessage("Failed to open session diff")
  }
}

// --- Server Manager ---

class ServerManager implements vscode.Disposable {
  private proc?: ChildProcessWithoutNullStreams
  private url?: string
  private starting?: Promise<string>
  private root?: string

  localUrl() {
    return this.url
  }

  async ensureRunning(root: string) {
    if (this.root && this.root !== root) {
      this.stop()
    }

    if (this.url && this.proc && !this.proc.killed) {
      return this.url
    }

    if (this.starting) {
      return this.starting
    }

    this.starting = this.spawn(root).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  dispose() {
    this.stop()
  }

  private stop() {
    this.root = undefined
    this.url = undefined
    const proc = this.proc
    this.proc = undefined
    this.starting = undefined
    if (!proc || proc.killed) {
      return
    }

    proc.kill()
  }

  private spawn(root: string) {
    return new Promise<string>((resolve, reject) => {
      const proc = spawn("opencode", ["serve", "--hostname=localhost", "--port=0"], {
        cwd: root,
        env: {
          ...process.env,
          OPENCODE_CALLER: "vscode",
          OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: process.env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY ?? "1",
        },
      })

      this.proc = proc
      this.root = root
      let output = ""
      let settled = false

      const finish = (error?: Error, value?: string) => {
        if (settled) {
          return
        }

        settled = true
        if (error) {
          reject(error)
          return
        }

        if (!value) {
          reject(new Error("Missing opencode server URL"))
          return
        }

        resolve(value)
      }

      proc.stdout.on("data", (chunk) => {
        output += chunk.toString()
        const match = output.match(/opencode server listening on\s+(https?:\/\/[^\s]+)/)
        if (!match) {
          return
        }

        this.url = match[1]
        finish(undefined, match[1])
      })

      proc.stderr.on("data", (chunk) => {
        output += chunk.toString()
      })

      proc.once("error", (error) => {
        this.url = undefined
        this.proc = undefined
        finish(error)
      })

      proc.once("exit", (code) => {
        this.url = undefined
        this.proc = undefined
        if (settled) {
          return
        }

        finish(new Error(`opencode server exited with code ${code ?? "unknown"}: ${output.trim()}`))
      })
    })
  }
}

// --- Utilities ---

function supportsSecondarySidebar() {
  const [majorRaw, minorRaw] = vscode.version.split(".")
  const major = Number(majorRaw)
  const minor = Number(minorRaw)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return false
  }

  if (major > 1) {
    return true
  }

  return minor >= 104
}

async function openTerminal(context: vscode.ExtensionContext, forceNew: boolean) {
  if (!forceNew) {
    const existing = vscode.window.terminals.find((terminal) => terminal.name === TERMINAL_NAME)
    if (existing) {
      existing.show()
      return
    }
  }

  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: {
      light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
      dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
    },
    location: {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
    },
    env: {
      OPENCODE_CALLER: "vscode",
    },
  })
  terminal.show()
  terminal.sendText("opencode")
}

function getWorkspaceRoot() {
  const active = vscode.window.activeTextEditor
  if (active) {
    const folder = vscode.workspace.getWorkspaceFolder(active.document.uri)
    if (folder) {
      return folder.uri.fsPath
    }
  }

  const [folder] = vscode.workspace.workspaceFolders ?? []
  return folder?.uri.fsPath
}

function getActiveFileRef() {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return
  }

  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
  if (!folder) {
    return
  }

  const relative = vscode.workspace.asRelativePath(editor.document.uri)
  if (editor.selection.isEmpty) {
    return `@${relative}`
  }

  const start = editor.selection.start.line + 1
  const end = editor.selection.end.line + 1
  if (start === end) {
    return `@${relative}#L${start}`
  }

  return `@${relative}#L${start}-${end}`
}

async function appendPrompt(base: string, text: string) {
  await fetch(`${base}/tui/append-prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  })
}

async function waitForServer(base: string) {
  let tries = 20
  let failure = ""
  while (tries > 0) {
    const response = await fetch(`${base}/global/health`).catch((error) => {
      failure = error instanceof Error ? error.message : String(error)
      return undefined
    })
    if (response?.ok) {
      return
    }

    tries -= 1
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  if (failure) {
    throw new Error(`Timed out waiting for opencode server at ${base}: ${failure}`)
  }

  throw new Error(`Timed out waiting for opencode server at ${base}`)
}

function emptyWorkspaceHtml() {
  return `<!doctype html><html><body style="margin:0;padding:12px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground)">Open a workspace folder to start opencode sidebar.</body></html>`
}

function failureHtml(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return `<!doctype html><html><body style="margin:0;padding:12px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-errorForeground)">Failed to start opencode sidebar.<br><br>${escapeHtml(message)}</body></html>`
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function createNonce() {
  return randomBytes(16).toString("base64")
}

function webviewCsp(cspSource: string, nonce: string) {
  const directives = [
    "default-src 'none'",
    `script-src ${cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-eval'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `img-src ${cspSource} https: data:`,
  ]
  return `<meta http-equiv="Content-Security-Policy" content="${directives.join("; ")};" />`
}

function webviewServerScript(local: string, nonce: string) {
  return `<script nonce="${nonce}">window.__OPENCODE_SERVER_URL__=${JSON.stringify(local)};</script>`
}
