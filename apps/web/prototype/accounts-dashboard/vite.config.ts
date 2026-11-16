// PROTOTYPE: serves the accounts-dashboard variants. Run `bun run prototype:accounts` from the repo root.
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5180, open: false },
})
