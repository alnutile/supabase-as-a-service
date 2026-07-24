import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'
import { registerServiceWorker } from './lib/pwa'
import './index.css'

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
