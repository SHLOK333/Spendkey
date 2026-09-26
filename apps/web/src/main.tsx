import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { ErrorBoundary } from './components/ErrorBoundary'
import { Header } from './components/Header'
import { ErrorBox, Spinner } from './components/primitives'
import { loadConfig, type AppConfig } from './lib/config'
import { AppProvider } from './lib/context'
import { BucketPage } from './pages/BucketPage'
import { Dashboard } from './pages/Dashboard'
import { JudgePage } from './pages/JudgePage'
import './styles.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 4_000 } } })

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

function Routes() {
  const hash = useHashRoute()
  const match = /^#\/bucket\/(0x[0-9a-fA-F]{64})$/.exec(hash)
  if (match?.[1]) return <BucketPage bucketId={match[1] as `0x${string}`} />
  if (hash === '#/judge') return <JudgePage />
  return <Dashboard />
}

function Footer() {
  return (
    <footer className="footer">
      <span>ENSv2 = authority · Aqua = shared liquidity · SwapVM = programmable execution</span>
      <span>Powered by SwapVM — © Degensoft Ltd 2025</span>
    </footer>
  )
}

function App({ config }: { config: AppConfig }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppProvider config={config}>
        <Header />
        <ErrorBoundary>
          <Routes />
        </ErrorBoundary>
        <Footer />
      </AppProvider>
    </QueryClientProvider>
  )
}

function Boot() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    loadConfig().then(setConfig, setError)
  }, [])
  if (error) {
    return (
      <main className="page">
        <ErrorBox error={error} />
      </main>
    )
  }
  return config ? (
    <App config={config} />
  ) : (
    <main className="page">
      <Spinner />
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
)
