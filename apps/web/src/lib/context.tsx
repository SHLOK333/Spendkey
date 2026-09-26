import type { SuiBucketClient, SuiExecutor } from '@bucket/sdk'
import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { createClients, createSuiBucketClient, walletSuiExecutor, type Clients } from './clients'
import type { AppConfig } from './config'
import { useEvmWallet, type EvmWalletState } from './evmWallet'

interface AppContextValue {
  readonly config: AppConfig
  readonly clients: Clients
  readonly evmWallet: EvmWalletState
  readonly suiAddress: string | null
  readonly suiExecutor: SuiExecutor | null
  /** The Sui-native stack, built from the connected Sui wallet. `null` until one is connected. */
  readonly suiBucket: SuiBucketClient | null
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const clients = useMemo(() => createClients(config), [config])
  const evmWallet = useEvmWallet()
  const dAppKit = useDAppKit()
  const suiAccount = useCurrentAccount()
  const suiExecutor = useMemo(
    () => (suiAccount && clients.suiClient ? walletSuiExecutor(dAppKit, clients.suiClient) : null),
    [suiAccount, clients.suiClient, dAppKit],
  )
  const suiBucket = useMemo(
    () => (suiExecutor ? createSuiBucketClient(config.deployment, clients.suiClient, suiExecutor) : null),
    [config.deployment, clients.suiClient, suiExecutor],
  )
  const value = useMemo(
    () => ({ config, clients, evmWallet, suiAddress: suiAccount?.address ?? null, suiExecutor, suiBucket }),
    [config, clients, evmWallet, suiAccount, suiExecutor, suiBucket],
  )
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp outside AppProvider')
  return value
}
