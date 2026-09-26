/**
 * Publishes reference prices for the Bucket test assets to `BucketReferencePriceFeed`.
 * Prices come from configuration (PRICE_USDC / PRICE_ETH / PRICE_SUI, decimal USD strings), never from the UI.
 */
import { bucketPriceFeedAbi } from '@bucket/sdk'
import { usd, type Deployment } from '@bucket/protocol-types'

import { publicClient, walletClient } from './clients'
import { env, required } from './env'
import { evmTx, info, step } from './log'

const PRICE_BY_SYMBOL: Record<string, string> = {
  USDC: env.PRICE_USDC,
  ETH: env.PRICE_ETH,
  SUI: env.PRICE_SUI,
  PEPE: env.PRICE_PEPE,
  // Assets minted by `configure:extra-buckets` for the savings/payments Buckets.
  DAI: '1',
  WBTC: '60000',
  USDT: '1',
  EURC: '1.08',
}

export async function publishPrices(deployment: Deployment): Promise<void> {
  const reporterKey = env.PRICE_REPORTER_PRIVATE_KEY ?? required('DEPLOYER_PRIVATE_KEY')
  const wallet = walletClient(reporterKey)
  const client = publicClient()

  const tokens = deployment.evm.tokens.map((t) => t.address)
  const prices = deployment.evm.tokens.map((t) => {
    const price = PRICE_BY_SYMBOL[t.symbol]
    if (!price) throw new Error(`no configured price for ${t.symbol}`)
    return usd(price)
  })

  step('Publishing reference prices')
  const { request } = await client.simulateContract({
    address: deployment.evm.contracts.priceFeed,
    abi: bucketPriceFeedAbi,
    functionName: 'setPrices',
    args: [tokens, prices],
    account: wallet.account,
  })
  const hash = await wallet.writeContract(request)
  await client.waitForTransactionReceipt({ hash })
  deployment.evm.tokens.forEach((t, i) => info(t.symbol, `$${PRICE_BY_SYMBOL[t.symbol]} (${prices[i]} wad)`))
  info('tx', evmTx(deployment, hash))
}

