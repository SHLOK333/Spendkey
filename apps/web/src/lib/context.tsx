import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { createClients, type Clients } from './clients'
import type { AppConfig } from './config'
import { useEvmWallet, type EvmWalletState } from './evmWallet'

interface AppContextValue {
  readonly config: AppConfig
  readonly clients: Clients
  readonly evmWallet: EvmWalletState
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const clients = useMemo(() => createClients(config), [config])
  const evmWallet = useEvmWallet()
  const value = useMemo(() => ({ config, clients, evmWallet }), [config, clients, evmWallet])
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp outside AppProvider')
  return value
}
