import { parseDeployment, type Deployment } from '@bucket/protocol-types'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { App } from './App'
import { Providers } from './providers'

import './app/globals.css'

function Fatal({ message }: { message: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
      <div>
        <h1 style={{ fontSize: 18, fontWeight: 700 }}>BUCKET could not start</h1>
        <p style={{ marginTop: 8, color: '#9297a6', maxWidth: 420 }}>{message}</p>
      </div>
    </div>
  )
}

async function boot() {
  const root = createRoot(document.getElementById('root')!)
  let deployment: Deployment
  try {
    const res = await fetch('/api/deployment', { cache: 'no-store' })
    if (!res.ok) throw new Error(`deployment manifest unavailable (HTTP ${res.status})`)
    deployment = parseDeployment(await res.json())
  } catch (error) {
    root.render(<Fatal message={`Could not load the deployment manifest. Is the API server running? ${error instanceof Error ? error.message : String(error)}`} />)
    return
  }
  root.render(
    <StrictMode>
      <BrowserRouter>
        <Providers deployment={deployment}>
          <App />
        </Providers>
      </BrowserRouter>
    </StrictMode>,
  )
}

void boot()
