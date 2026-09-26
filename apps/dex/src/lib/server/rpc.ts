import { fallback, http, type Transport } from 'viem'

import { serverEnv } from './env'

/**
 * Read-only Sepolia RPC resilience.
 *
 * A single provider (e.g. Alchemy free tier) is easily rate-limited (HTTP 429) once the SPA polls balances,
 * bucket views and capabilities. We therefore front the configured endpoint with a few keyless public Sepolia
 * RPCs: server-side viem clients use a `fallback` transport, and the `/api/rpc` proxy walks the same list on
 * 429/5xx. Transactions are still signed and broadcast by the user's own wallet — this only spreads reads.
 */
const PUBLIC_SEPOLIA_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
  'https://1rpc.io/sepolia',
] as const

function isLocal(url: string): boolean {
  return url.includes('127.0.0.1') || url.includes('localhost')
}

/** The configured endpoint first, then public fallbacks — unless we're pointed at a local fork. */
export function sepoliaRpcUrls(): string[] {
  const primary = serverEnv.sepoliaRpcUrl()
  if (isLocal(primary)) return [primary]
  return [primary, ...PUBLIC_SEPOLIA_RPCS.filter((u) => u !== primary)]
}

/** A viem transport that retries each endpoint, then fails over to the next. Batches JSON-RPC to cut request count. */
export function sepoliaTransport(): Transport {
  const urls = sepoliaRpcUrls()
  return fallback(
    urls.map((url) => http(url, { batch: true, retryCount: 2, retryDelay: 300, timeout: 15_000 })),
    { rank: false, retryCount: 1 },
  )
}

/**
 * Strip RPC endpoint URLs (which embed the provider API key) out of any error text before it can reach the
 * browser. viem includes the full request URL in its error messages, so an un-redacted `error.message` returned
 * from an API handler would leak the key. Never return raw provider errors to the client without this.
 */
export function redactRpc(text: string): string {
  let out = text
  for (const url of sepoliaRpcUrls()) if (url) out = out.split(url).join('the RPC endpoint')
  // Generic catch-all for keyed provider URLs, in case the configured list changes.
  out = out.replace(/https?:\/\/[^\s"']*\/v2\/[A-Za-z0-9_-]+/g, 'the RPC endpoint')
  out = out.replace(/https?:\/\/[^\s"']*(alchemy|infura|drpc|publicnode|ankr|1rpc)[^\s"']*/gi, 'the RPC endpoint')
  return out
}

/** Extract a safe, client-facing message from an unknown error. */
export function safeErrorMessage(error: unknown): string {
  return redactRpc(error instanceof Error ? error.message : String(error))
}
