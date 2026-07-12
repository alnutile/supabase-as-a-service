import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Excalidraw (the Planner / Whiteboards editor) reads `process.env.IS_PREACT`
  // at module init — Vite doesn't shim `process.env`, so define it or the bundle
  // throws "process is not defined" the moment the editor mounts. It's a large
  // dep, so it's loaded via React.lazy in App.tsx (kept out of the initial chunk).
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  server: {
    port: 5173,
    host: true,
  },
})
