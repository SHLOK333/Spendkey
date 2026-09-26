import { useAppKit } from '@reown/appkit/react'
import { Wallet } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { sepolia } from 'viem/chains'
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi'

import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/client/app'
import { reownEnabled } from '@/lib/client/wagmi'
import { shortAddr } from '@/lib/utils'

// The Sui dApp Kit UI registers web components and touches `window` at import time, so it is loaded lazily
// (never during initial render / server-side prerender concerns don't apply in this SPA).
const SuiConnectButton = lazy(() => import('@mysten/dapp-kit-react/ui').then((m) => ({ default: m.ConnectButton })))

function ReownConnect() {
  const { open } = useAppKit()
  const { address } = useConnection()
  return (
    <Button variant={address ? 'secondary' : 'primary'} onClick={() => void open()}>
      <Wallet className="h-4 w-4" /> {address ? shortAddr(address) : 'Connect Wallet'}
    </Button>
  )
}

function InjectedConnect() {
  const { address } = useConnection()
  const connectors = useConnectors()
  const { connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  if (address) {
    return (
      <Button variant="secondary" onClick={() => disconnect()} title="Disconnect">
        <Wallet className="h-4 w-4" /> {shortAddr(address)}
      </Button>
    )
  }
  const injected = connectors[0]
  return (
    <Button variant="primary" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected, chainId: sepolia.id })}>
      <Wallet className="h-4 w-4" /> {injected ? 'Connect Wallet' : 'No wallet found'}
    </Button>
  )
}

export function WrongChainNotice() {
  const { address, chainId } = useConnection()
  const { switchChain } = useSwitchChain()
  if (!address || chainId === sepolia.id) return null
  return (
    <div className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-center text-xs text-warn">
      Your wallet is on another network. BUCKET on EVM runs on Ethereum Sepolia.{' '}
      <button className="underline cursor-pointer" onClick={() => switchChain({ chainId: sepolia.id })}>
        Switch to Sepolia
      </button>
    </div>
  )
}

/** Wallet connection for the active protocol environment. */
export function ConnectWallet() {
  const { network } = useApp()
  if (network === 'sui')
    return (
      <Suspense fallback={<Button variant="secondary" disabled>Sui wallet…</Button>}>
        <SuiConnectButton />
      </Suspense>
    )
  return reownEnabled ? <ReownConnect /> : <InjectedConnect />
}
