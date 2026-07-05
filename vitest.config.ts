import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Frontend unit tests only — the Deno edge-function tests live in
// supabase/functions/tests/ and run with `npm run test:deno`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
