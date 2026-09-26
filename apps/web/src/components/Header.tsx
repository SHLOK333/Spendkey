import { ConnectButton } from '@mysten/dapp-kit-react/ui'

import { useApp } from '../lib/context'
import { shortHex } from '../lib/format'

export function Header() {
  const { config, evmWallet } = useApp()
  const fork = config.deployment.evm.network === 'sepolia-fork'
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="22" height="22">
            <path
              d="M8 10h16l-2.2 13.2a2 2 0 0 1-2 1.8h-7.6a2 2 0 0 1-2-1.8z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinejoin="round"
            />
            <path d="M11 15h10" stroke="var(--ens)" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </span>
        BUCKET
        <span className="brand-tag">programmable capital</span>
      </a>
      <div className="topbar-right">
        <a className="btn" href="#/judge" style={{ fontSize: 12 }}>
          For judges
        </a>
        <span className={`net ${fork ? 'net-fork' : ''}`} title={fork ? 'Local anvil fork of Sepolia' : 'Ethereum Sepolia'}>
          {fork ? 'LOCAL FORK · Sepolia' : 'Sepolia'}
        </span>
        {config.deployment.sui ? <span className="net">Sui {config.deployment.sui.network}</span> : null}
        {evmWallet.address ? (
          evmWallet.wrongChain ? (
            <button className="btn" onClick={() => void evmWallet.switchChain()}>
              Switch to Sepolia
            </button>
          ) : (
            <span className="wallet mono">EVM {shortHex(evmWallet.address)}</span>
          )
        ) : (
          <button className="btn" disabled={!evmWallet.available} onClick={() => void evmWallet.connect()}>
            {evmWallet.available ? 'Connect EVM' : 'No EVM wallet'}
          </button>
        )}
        <ConnectButton />
      </div>
    </header>
  )
}
