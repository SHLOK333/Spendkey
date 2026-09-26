import type { Deployment } from '@bucket/protocol-types'

export function step(title: string): void {
  console.log(`\n== ${title}`)
}

export function info(label: string, value: unknown): void {
  console.log(`   ${label.padEnd(22)} ${String(value)}`)
}

export function evmTx(deployment: Deployment, hash: string): string {
  return deployment.evm.explorer ? `${deployment.evm.explorer}/tx/${hash}` : hash
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
