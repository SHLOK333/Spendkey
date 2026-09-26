import { useAppKit } from '@reown/appkit/react'
import { Wallet } from 'lucide-react'
import { sepolia } from 'viem/chains'
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi'

import { Button } from '@/components/ui/button'
import { reownEnabled } from '@/lib/client/wagmi'
import { shortAddr } from '@/lib/utils'

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

/** Wallet connection for the EVM (Sepolia) environment. */
export function ConnectWallet() {
  return reownEnabled ? <ReownConnect /> : <InjectedConnect />
}
