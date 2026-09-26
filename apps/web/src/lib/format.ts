import type { Deployment } from '@bucket/protocol-types'

export function shortHex(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 2 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`
}

export function evmTxUrl(deployment: Deployment, hash: string): string | null {
  return deployment.evm.explorer ? `${deployment.evm.explorer}/tx/${hash}` : null
}

export function evmAddressUrl(deployment: Deployment, address: string): string | null {
  return deployment.evm.explorer ? `${deployment.evm.explorer}/address/${address}` : null
}

/** "trading.shlok.eth" -> "TRADING" */
export function bucketTitle(ensName: string): string {
  return (ensName.split('.')[0] ?? ensName).toUpperCase()
}
