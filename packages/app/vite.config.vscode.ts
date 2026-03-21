import { defineConfig } from "vite"
import desktopPlugin from "./vite"
import path from "path"

export default defineConfig({
  plugins: [desktopPlugin] as any,
  build: {
    target: "esnext",
    outDir: path.resolve(__dirname, "../../sdks/vscode/dist/webview"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "index-vscode.html"),
    },
  },
})
