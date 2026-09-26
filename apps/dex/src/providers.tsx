import type { Deployment } from '@bucket/protocol-types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'

import { AppProvider } from '@/lib/client/app'
import { wagmiConfig } from '@/lib/client/wagmi'

export function Providers({ deployment, children }: { deployment: Deployment; children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 8_000, refetchOnWindowFocus: false } } }))
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AppProvider deployment={deployment}>{children}</AppProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
