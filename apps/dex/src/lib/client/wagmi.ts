import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { sepolia as appKitSepolia } from '@reown/appkit/networks'
import { createAppKit } from '@reown/appkit/react'
import { createConfig, http, type Config } from 'wagmi'
import { sepolia } from 'wagmi/chains'
import { injected } from '@wagmi/core'

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID?.trim() || null

// Reads go through the app's allowlisted proxy so the RPC key never reaches the browser; the connected wallet signs
// and broadcasts transactions itself.
const transports = { [sepolia.id]: http('/api/rpc') }

/** True when a Reown (WalletConnect) project id is configured; otherwise only injected wallets are offered. */
export const reownEnabled = projectId !== null

function build(): Config {
  if (!projectId) {
    return createConfig({ chains: [sepolia], connectors: [injected()], transports, ssr: false })
  }
  const adapter = new WagmiAdapter({ networks: [appKitSepolia], projectId, transports, ssr: false })
  if (typeof window !== 'undefined') {
    createAppKit({
      // WagmiAdapter's optional `namespace` trips exactOptionalPropertyTypes against ChainAdapter; same runtime shape.
      adapters: [adapter as unknown as NonNullable<Parameters<typeof createAppKit>[0]['adapters']>[number]],
      networks: [appKitSepolia],
      projectId,
      metadata: {
        name: 'BUCKET',
        description: 'Trade, pay and automate — without giving up custody.',
        url: window.location.origin,
        icons: [],
      },
      themeMode: 'dark',
      features: { analytics: false, email: false, socials: false },
    })
  }
  return adapter.wagmiConfig as Config
}

export const wagmiConfig = build()
