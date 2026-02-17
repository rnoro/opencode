// @refresh reload
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { Platform, PlatformProvider } from "@/context/platform"
import { vscodeFetch, getVscodeApi } from "@/lib/vscode-fetch"
import { VscodeWebSocket } from "@/lib/vscode-websocket"
import pkg from "../package.json"

declare global {
  interface Window {
    __OPENCODE_SERVER_URL__?: string
  }
}

const vscode = getVscodeApi()

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

  getDefaultServerUrl() {
    return window.__OPENCODE_SERVER_URL__ ?? null
  },

  setDefaultServerUrl() {},
}

const root = document.getElementById("root")

if (root instanceof HTMLElement) {
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface defaultUrl={window.__OPENCODE_SERVER_URL__} isSidecar />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
