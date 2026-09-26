/**
 * Startup hook — called once by the API server (`server/index.ts`) on boot.
 * Refreshes the on-chain reference price feed every 30 minutes so demo swaps never
 * fail with BucketMathPriceStale.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { usd } from '@bucket/protocol-types'
import { bucketPriceFeedAbi } from '@bucket/sdk'
import { createPublicClient, createWalletClient, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import { sepoliaTransport } from './lib/server/rpc'

const REFRESH_INTERVAL_MS = 30 * 60 * 1_000

const PRICE_BY_SYMBOL: Record<string, string> = {
  USDC: process.env.PRICE_USDC ?? '1',
  ETH: process.env.PRICE_ETH ?? '2500',
  SUI: process.env.PRICE_SUI ?? '3.5',
  PEPE: process.env.PRICE_PEPE ?? '0.001',
  // Savings/payments Bucket assets (see `configure:extra-buckets`); explicit so the refresher never resets them to $1.
  DAI: process.env.PRICE_DAI ?? '1',
  WBTC: process.env.PRICE_WBTC ?? '60000',
  USDT: process.env.PRICE_USDT ?? '1',
  EURC: process.env.PRICE_EURC ?? '1.08',
}

async function refreshPrices(): Promise<void> {
  const rawKey = process.env.PRICE_REPORTER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY
  if (!rawKey || !isHex(rawKey) || rawKey.length !== 66) return

  const rpcUrl = process.env.SEPOLIA_RPC_URL
  if (!rpcUrl) return

  const root = path.resolve(process.cwd(), '../..')
  const deployment = JSON.parse(readFileSync(path.join(root, 'deployments', 'sepolia.json'), 'utf8')) as {
    evm: {
      contracts: { priceFeed: `0x${string}` }
      tokens: Array<{ symbol: string; address: `0x${string}` }>
    }
  }

  const tokens = deployment.evm.tokens.map((t) => t.address)
  const prices = deployment.evm.tokens.map((t) => usd(PRICE_BY_SYMBOL[t.symbol] ?? '1'))

  const account = privateKeyToAccount(rawKey as `0x${string}`)
  const transport = sepoliaTransport()
  const publicClient = createPublicClient({ chain: sepolia, transport })
  const walletClient = createWalletClient({ account, chain: sepolia, transport })

  const { request } = await publicClient.simulateContract({
    address: deployment.evm.contracts.priceFeed,
    abi: bucketPriceFeedAbi,
    functionName: 'setPrices',
    args: [tokens, prices],
    account,
  })
  const hash = await walletClient.writeContract(request)
  await publicClient.waitForTransactionReceipt({ hash })
  console.log(`[BUCKET] Price feed refreshed — tx ${hash}`)
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return

  try {
    await refreshPrices()
  } catch (e) {
    console.warn('[BUCKET] Initial price refresh skipped:', e instanceof Error ? e.message : String(e))
  }

  setInterval(() => {
    void refreshPrices().catch((e: unknown) => {
      console.warn('[BUCKET] Price refresh failed:', e instanceof Error ? e.message : String(e))
    })
  }, REFRESH_INTERVAL_MS)
}
