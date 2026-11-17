import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { daemonProxy } from "./daemon-proxy.ts"

export default defineConfig({
  plugins: [react(), daemonProxy()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { sourcemap: true },
})
