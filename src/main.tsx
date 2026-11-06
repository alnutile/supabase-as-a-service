import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'
import { registerServiceWorker } from './lib/pwa'
import { setBackend } from './lib/data'
import { localBackend } from './lib/data/local'
import { supabaseBackend } from './lib/data/supabase'
import { isLocalMode } from './lib/mode'
import './index.css'

// The hosted build talks to Supabase; the local build (VITE_BACKEND=local) talks
// to the second-brain server on this machine (local/server.ts, SQLite).
setBackend(isLocalMode ? localBackend : supabaseBackend)

// Register the service worker in production only (avoids caching interfering with
// the Vite dev server). This is what lets the browser offer to install the app.
if (import.meta.env.PROD) registerServiceWorker()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
