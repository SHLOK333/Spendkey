import type { Deployment } from '@bucket/protocol-types'
import { createDAppKit, DAppKitProvider } from '@mysten/dapp-kit-react'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'

import { AppProvider } from '@/lib/client/app'
import { wagmiConfig } from '@/lib/client/wagmi'

export function Providers({ deployment, children }: { deployment: Deployment; children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 8_000, refetchOnWindowFocus: false } } }))
  const [dAppKit] = useState(() => {
    const network = deployment.sui?.network ?? 'testnet'
    return createDAppKit({
      networks: [network],
      defaultNetwork: network,
      createClient: () => new SuiGrpcClient({ network, baseUrl: `https://fullnode.${network}.sui.io:443` }),
    })
  })
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <DAppKitProvider dAppKit={dAppKit}>
          <AppProvider deployment={deployment}>{children}</AppProvider>
        </DAppKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
