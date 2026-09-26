import type { Deployment, DeploymentToken } from '@bucket/protocol-types'
import { BucketClient, BucketEvm, EnsV2, type EvmWallet } from '@bucket/sdk'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { createPublicClient, http, isAddressEqual, type Address, type PublicClient } from 'viem'
import { sepolia } from 'viem/chains'
import { useConnection, useWalletClient } from 'wagmi'

interface AppValue {
  readonly deployment: Deployment
  readonly publicClient: PublicClient
  readonly bucket: BucketClient
}

const AppContext = createContext<AppValue | null>(null)

export function AppProvider({ deployment, children }: { deployment: Deployment; children: ReactNode }) {
  const value = useMemo<AppValue>(() => {
    const url = typeof window === 'undefined' ? 'http://localhost/api/rpc' : `${window.location.origin}/api/rpc`
    const publicClient = createPublicClient({ chain: sepolia, transport: http(url) }) as PublicClient
    const evm = new BucketEvm(publicClient, deployment.evm.contracts, BigInt(deployment.evm.startBlock))
    const ens = new EnsV2(publicClient, { rootRegistry: deployment.evm.ens.rootRegistry, ethRegistry: deployment.evm.ens.ethRegistry })
    return {
      deployment,
      publicClient,
      bucket: new BucketClient(evm, ens, deployment.evm.chainId),
    }
  }, [deployment])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppValue {
  const v = useContext(AppContext)
  if (!v) throw new Error('useApp outside AppProvider')
  return v
}

export function useTokens(): readonly DeploymentToken[] {
  return useApp().deployment.evm.tokens
}

export function useTokenOf(): (address: string) => DeploymentToken | undefined {
  const tokens = useTokens()
  return (address: string) => tokens.find((t) => isAddressEqual(t.address, address as Address))
}

/** The connected EVM wallet as an SDK signer (owner actions only: issue, revoke, pause, approve). */
export function useOwnerWallet(): { address: Address | null; wallet: EvmWallet | null; wrongChain: boolean } {
  const { address, chainId } = useConnection()
  const { data } = useWalletClient()
  return {
    address: address ?? null,
    wallet: (data as EvmWallet | undefined) ?? null,
    wrongChain: !!address && chainId !== sepolia.id,
  }
}
