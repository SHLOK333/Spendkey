import type { EvmWallet } from '@bucket/sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createWalletClient, custom, getAddress, numberToHex, type Address, type EIP1193Provider } from 'viem'
import { sepolia } from 'viem/chains'

// ─── ERC-7715 execution permission layer ─────────────────────────────────────
//
// ERC-7715 is a wallet-level UX hint: we tell the wallet "I am about to execute
// within this scoped permission" so it can show a richer confirmation dialog.
// BUCKET capability validation still enforces ALL limits on-chain regardless —
// this layer NEVER bypasses BucketCapabilities.
//
// Most wallets (MetaMask, Rabby, …) don't yet support ERC-7715 and will reject
// `wallet_getSupportedExecutionPermissions` with an error. That is the normal
// path. We always fall back gracefully.

export interface BucketPermissionRequest {
  readonly chainId: number
  readonly bucketId: `0x${string}`
  readonly capabilityId: `0x${string}`
  readonly controllerAddress: `0x${string}`
  readonly expiryUnix: number
}

export type Erc7715Status = 'not-probed' | 'not-supported' | 'supported' | 'granted' | 'declined'

/**
 * Probe whether the provider declares ERC-7715 support.
 * Never throws — returns false on any error.
 */
export async function probeERC7715(provider: EIP1193Provider): Promise<boolean> {
  try {
    // ERC-7715 is not yet in viem's typed method list; cast to bypass the type guard.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (provider as any).request({ method: 'wallet_getSupportedExecutionPermissions' })
    return true
  } catch {
    return false
  }
}

/**
 * Request a scoped execution permission for a BUCKET rebalance via ERC-7715.
 *
 * Maps the BUCKET capability to a `contract-call` permission restricted to the
 * BucketController's `preTransferOut` function selector — the on-chain gate for
 * every rebalance execution.  If the wallet rejects or doesn't understand the
 * request, returns `null` (graceful fallback).
 *
 * BUCKET on-chain validation is unaffected by the return value.
 */
export async function requestBucketExecutionPermission(
  provider: EIP1193Provider,
  params: BucketPermissionRequest,
): Promise<`0x${string}` | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await (provider as any).request({
      method: 'wallet_requestExecutionPermissions',
      params: [
        {
          chainId: numberToHex(params.chainId),
          expiry: params.expiryUnix,
          permissions: [
            {
              // Map BUCKET capability to a contract-call permission scoped to
              // the controller + preTransferOut selector (0x...).  The `required`
              // flag is false so the wallet can grant a superset without error.
              type: 'contract-call',
              required: false,
              data: {
                address: params.controllerAddress,
                // preTransferOut(address,address,address,address,uint256,uint256,bytes32,bytes,bytes)
                functions: [{ functionName: 'preTransferOut' }],
              },
            },
          ],
          // Non-standard context so BUCKET-aware wallets can show Bucket-specific UI.
          context: {
            protocol: 'bucket',
            bucketId: params.bucketId,
            capabilityId: params.capabilityId,
          },
        },
      ],
    })) as { permissionContext?: `0x${string}` } | null
    return result?.permissionContext ?? null
  } catch {
    return null
  }
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

export interface EvmWalletState {
  readonly available: boolean
  readonly address: Address | null
  readonly chainId: number | null
  readonly wrongChain: boolean
  readonly wallet: EvmWallet | null
  readonly connect: () => Promise<void>
  readonly switchChain: () => Promise<void>
  readonly error: string | null
}

/** Minimal EIP-1193 wallet binding (MetaMask, Rabby, …). BUCKET targets Sepolia (chain 11155111). */
export function useEvmWallet(): EvmWalletState {
  // Read the injected provider once: some wallets expose `window.ethereum` as a getter returning a fresh object on
  // every access, which would otherwise re-run the effects below on every render.
  const [provider] = useState<EIP1193Provider | undefined>(() =>
    typeof window !== 'undefined' ? window.ethereum : undefined,
  )
  const [address, setAddress] = useState<Address | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!provider) return
    const onAccounts = (accounts: readonly string[]) => setAddress(accounts[0] ? getAddress(accounts[0]) : null)
    const onChain = (id: string) => setChainId(Number.parseInt(id, 16))
    // Injected providers vary widely (some throw synchronously for unsupported methods); probing must never crash
    // the app, so every call is guarded and failures surface as a wallet error instead.
    const probe = async () => {
      try {
        onAccounts(await provider.request({ method: 'eth_accounts' }))
        onChain(await provider.request({ method: 'eth_chainId' }))
      } catch (e) {
        setError(`EVM wallet unavailable: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    void probe()
    try {
      provider.on('accountsChanged', onAccounts)
      provider.on('chainChanged', onChain)
    } catch {
      return undefined
    }
    return () => {
      try {
        provider.removeListener('accountsChanged', onAccounts)
        provider.removeListener('chainChanged', onChain)
      } catch {
        // provider without listener support
      }
    }
  }, [provider])

  const connect = useCallback(async () => {
    if (!provider) {
      setError('No EVM wallet detected')
      return
    }
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      setAddress(accounts[0] ? getAddress(accounts[0]) : null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [provider])

  const switchChain = useCallback(async () => {
    if (!provider) return
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(sepolia.id) }] })
  }, [provider])

  const wallet = useMemo<EvmWallet | null>(() => {
    if (!provider || !address) return null
    return createWalletClient({ chain: sepolia, transport: custom(provider), account: address })
  }, [provider, address])

  return {
    available: Boolean(provider),
    address,
    chainId,
    wrongChain: chainId !== null && chainId !== sepolia.id,
    wallet,
    connect,
    switchChain,
    error,
  }
}
