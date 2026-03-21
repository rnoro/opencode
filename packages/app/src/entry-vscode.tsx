// @refresh reload
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { Platform, PlatformProvider } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { vscodeFetch, getVscodeApi } from "@/lib/vscode-fetch"
import { VscodeWebSocket } from "@/lib/vscode-websocket"
import pkg from "../package.json"

declare global {
  interface Window {
    __OPENCODE_SERVER_URL__?: string
    __OPENCODE_WORKSPACE_KEY__?: string
  }
}

const vscode = getVscodeApi()
const WORKSPACE_KEY = "opencode.workspace"
const ROUTE_KEY = "opencode.route"

const platform: Platform = {
  platform: "web",
  runtime: "vscode",
  version: pkg.version,
  fetch: vscodeFetch as typeof fetch,
  WebSocket: VscodeWebSocket as unknown as typeof WebSocket,

  openLink(url: string) {
    vscode.postMessage({ type: "open-external", url })
  },

  back() {},
  forward() {},

  async restart() {
    vscode.postMessage({ type: "restart" })
  },

  async notify() {},

  getDefaultServer() {
    const server = window.__OPENCODE_SERVER_URL__
    if (!server) return Promise.resolve(null)
    return Promise.resolve(ServerConnection.Key.make(server))
  },

  setDefaultServer() {},
}

function normalizeRoute() {
  const workspace = window.__OPENCODE_WORKSPACE_KEY__ ?? ""
  const state = vscode.getState<Record<string, unknown>>() ?? {}
  const savedWorkspace = typeof state[WORKSPACE_KEY] === "string" ? state[WORKSPACE_KEY] : ""
  const savedRoute = typeof state[ROUTE_KEY] === "string" ? state[ROUTE_KEY] : ""
  const localRoute = savedWorkspace === workspace && savedRoute.startsWith("/") ? savedRoute : ""
  const route = localRoute || "/"
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (current !== route) {
    window.history.replaceState(null, "", route)
  }

  const write = () => {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`
    const prev = vscode.getState<Record<string, unknown>>() ?? {}
    vscode.setState({ ...prev, [WORKSPACE_KEY]: workspace, [ROUTE_KEY]: next })
    vscode.postMessage({ type: "route:set", route: next })
  }

  const push = window.history.pushState.bind(window.history)
  window.history.pushState = ((...args) => {
    push(...args)
    write()
  }) as History["pushState"]

  const replace = window.history.replaceState.bind(window.history)
  window.history.replaceState = ((...args) => {
    replace(...args)
    write()
  }) as History["replaceState"]

  window.addEventListener("popstate", write)
  window.addEventListener("hashchange", write)

  if (!localRoute) {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (!msg || msg.type !== "route:init") return
      if (typeof msg.route !== "string") return
      if (!msg.route.startsWith("/")) return
      const path = `${window.location.pathname}${window.location.search}${window.location.hash}`
      if (path !== "/") return
      window.history.replaceState(null, "", msg.route)
      write()
      window.removeEventListener("message", handler)
    }
    window.addEventListener("message", handler)
    vscode.postMessage({ type: "route:get" })
  }

  write()
}

normalizeRoute()

const root = document.getElementById("root")

if (root instanceof HTMLElement) {
  const url = window.__OPENCODE_SERVER_URL__
  const server = url
    ? ({
        type: "http",
        http: {
          url,
        },
      } satisfies ServerConnection.Http)
    : undefined

  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={server ? ServerConnection.key(server) : ServerConnection.Key.make("")}
            servers={server ? [server] : []}
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
