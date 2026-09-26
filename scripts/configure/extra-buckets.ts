/**
 * Adds two more ready-made Buckets — savings and payments — so the "pick a ready-made Bucket" onboarding path has
 * a real choice, WITHOUT needing extra wallets.
 *
 * The protocol binds each of a wallet's tokens to a single Bucket (`assetClaim[holder][token]`), so a second Bucket
 * over the same wallet must use a DISJOINT token set. The demo stack ships only USDC/ETH/SUI (claimed by trading)
 * and PEPE (reserved for the unapproved-asset rejection scenario), so this script deploys fresh mock ERC-20s and
 * builds each new Bucket over its own pair — all still owned by the one owner wallet.
 *
 *   savings.<owner>.eth   DAI / WBTC   (conservative store-of-value)
 *   payments.<owner>.eth  USDT / EURC  (stablecoin rails)
 *
 * Idempotent: existing tokens (by symbol) and Buckets (by label) are reused. Prerequisite: `pnpm configure:ens`
 * (each name must own a subregistry holding `exec`). Rebalance-only capabilities are issued to the shared operator.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CapabilityStatus,
  permissionMask,
  usd,
  type Capability,
  type CapabilityGrant,
  type Deployment,
  type DeploymentToken,
  type PolicyParams,
} from '@bucket/protocol-types'
import { bucketPriceFeedAbi, bucketTestTokenAbi, type BucketClient } from '@bucket/sdk'
import { amountOf } from '@bucket/vm'
import { encodeAbiParameters, isAddressEqual, maxUint256, parseEther, zeroAddress, type Address, type Hex } from 'viem'

import { bucketClient, publicClient, walletClient } from '../lib/clients'
import { BUCKET_LABELS } from './ens'
import { env, required, ROOT } from '../lib/env'
import { evmTx, info, step } from '../lib/log'
import { readManifest, writeManifest } from '../lib/manifest'

const REBALANCE_LIMITS = { maxExecutionValue: usd('490'), maxHourlyValue: usd('1500'), maxDailyValue: usd('2000'), maxSlippageBps: 50, maxDailyTurnoverBps: 5_000, maxExecutions: 0 }
const CAPABILITY_DURATION_SECONDS = 24 * 3_600
const FUNDING_USD = usd('1000')

/** Fresh mock assets, disjoint from the trading Bucket's USDC/ETH/SUI. Owner = deployer so the deployer can mint. */
const NEW_TOKENS: ReadonlyArray<{ symbol: string; name: string; decimals: number; priceUsd: string }> = [
  { symbol: 'DAI', name: 'Bucket DAI', decimals: 18, priceUsd: '1' },
  { symbol: 'WBTC', name: 'Bucket WBTC', decimals: 8, priceUsd: '60000' },
  { symbol: 'USDT', name: 'Bucket USDT', decimals: 6, priceUsd: '1' },
  { symbol: 'EURC', name: 'Bucket EURC', decimals: 6, priceUsd: '1.08' },
]

interface BucketSpec {
  readonly label: (typeof BUCKET_LABELS)[number]
  /** [base, quote] symbols; base is the asset the Bucket starts 100% in (so it opens out of policy → a real rebalance). */
  readonly assets: readonly [string, string]
  readonly targets: readonly [number, number]
  readonly bands: readonly [[number, number], [number, number]]
}

const NEW_BUCKETS: readonly BucketSpec[] = [
  { label: 'savings', assets: ['DAI', 'WBTC'], targets: [6000, 4000], bands: [[4000, 8000], [2000, 6000]] },
  { label: 'payments', assets: ['USDT', 'EURC'], targets: [6000, 4000], bands: [[4000, 8000], [2000, 6000]] },
]

function token(deployment: Deployment, symbol: string): DeploymentToken {
  const found = deployment.evm.tokens.find((t) => t.symbol === symbol)
  if (!found) throw new Error(`token ${symbol} missing from manifest`)
  return found
}

function isStale(cap: Capability | null, now: number): boolean {
  if (!cap) return true
  if (cap.status !== CapabilityStatus.Active) return true
  return cap.validUntil <= now
}

async function main(): Promise<void> {
  const deployment = readManifest()
  if (!deployment.ens || !deployment.evm.ens.ownerRegistry) {
    throw new Error('ENSv2 hierarchy not configured; run `pnpm configure:ens` first')
  }
  const client: BucketClient = bucketClient(deployment)
  const evmClient = publicClient()
  const deployer = walletClient(required('DEPLOYER_PRIVATE_KEY'))
  const owner = walletClient(required('OWNER_PRIVATE_KEY'))
  const operator = walletClient(required('OPERATOR_PRIVATE_KEY'))
  const ownerRegistry = deployment.evm.ens.ownerRegistry as Address

  info('evm network', deployment.evm.network === 'sepolia-fork' ? 'LOCAL FORK of Sepolia' : 'Sepolia')

  // 1 — deploy any missing mock tokens (owner = deployer for mint rights)
  step('Deploying fresh mock assets')
  const artifact = JSON.parse(readFileSync(join(ROOT, 'contracts', 'evm', 'out', 'BucketTestToken.sol', 'BucketTestToken.json'), 'utf8')) as {
    abi: readonly unknown[]
    bytecode: { object: Hex }
  }
  let tokensAdded = false
  for (const spec of NEW_TOKENS) {
    if (deployment.evm.tokens.some((t) => t.symbol === spec.symbol)) {
      info(spec.symbol, `exists: ${token(deployment, spec.symbol).address}`)
      continue
    }
    const hash = await deployer.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [spec.name, spec.symbol, spec.decimals, deployer.account.address],
    })
    const receipt = await evmClient.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress) throw new Error(`deploy of ${spec.symbol} produced no contract address`)
    deployment.evm.tokens.push({ symbol: spec.symbol, address: receipt.contractAddress, decimals: spec.decimals, suiType: '' })
    tokensAdded = true
    info(spec.symbol, `deployed ${receipt.contractAddress} (${evmTx(deployment, hash)})`)
  }
  if (tokensAdded) writeManifest(deployment)

  // 2 — publish prices for the new tokens (rebalance reads the feed; stale/zero price would revert)
  step('Publishing prices for new assets')
  const priceReporter = env.PRICE_REPORTER_PRIVATE_KEY ? walletClient(env.PRICE_REPORTER_PRIVATE_KEY) : deployer
  const newAddrs = NEW_TOKENS.map((s) => token(deployment, s.symbol).address as Address)
  const newPrices = NEW_TOKENS.map((s) => usd(s.priceUsd))
  await client.evm.write(priceReporter, {
    address: deployment.evm.contracts.priceFeed,
    abi: bucketPriceFeedAbi,
    functionName: 'setPrices',
    args: [newAddrs, newPrices],
  })
  for (const s of NEW_TOKENS) info(s.symbol, `$${s.priceUsd}`)

  // 3 — build each new Bucket
  const orderAbiType = { type: 'tuple', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] } as const
  for (const spec of NEW_BUCKETS) {
    step(`Bucket "${spec.label}" — ${spec.assets.join('/')}`)
    const base = token(deployment, spec.assets[0])
    const quote = token(deployment, spec.assets[1])
    const assets = [
      { token: base.address, decimals: base.decimals, targetBps: spec.targets[0], minBps: spec.bands[0][0], maxBps: spec.bands[0][1] },
      { token: quote.address, decimals: quote.decimals, targetBps: spec.targets[1], minBps: spec.bands[1][0], maxBps: spec.bands[1][1] },
    ]
    const params: PolicyParams = {
      rebalanceThresholdBps: 500,
      maxSlippageBps: 100,
      maxPriceAge: 3_600,
      auctionDuration: 300,
      venueMask: 1,
      maxDailyTurnoverBps: 8_000,
      delegablePermissions: permissionMask(['Rebalance', 'Swap', 'Delegate']),
      maxExecutionValue: usd('1000'),
      maxHourlyValue: usd('3000'),
      maxDailyValue: usd('5000'),
    }

    // vault
    let entry = deployment.buckets.find((b) => b.label === spec.label)
    let bucketId = entry?.bucketId as Hex | undefined
    if (!entry || !bucketId) {
      const strategyExpiry = Math.floor(Date.now() / 1_000) + 365 * 24 * 3_600
      const created = await client.createBucket({ wallet: owner, registry: ownerRegistry, label: spec.label, strategyExpiry, params, assets })
      bucketId = created.bucketId
      entry = { label: spec.label, ensName: `${spec.label}.${deployment.ens.ownerName}`, bucketId, holder: owner.account.address, capabilities: [] }
      deployment.buckets.push(entry)
      writeManifest(deployment)
      info('created', `${bucketId} (${evmTx(deployment, created.evmTx)})`)
    } else {
      info('vault', `exists: ${bucketId}`)
    }

    // approvals (owner → Aqua for both assets)
    await client.evm.ensureAllowance(owner, base.address, deployment.evm.contracts.aqua, maxUint256)
    await client.evm.ensureAllowance(owner, quote.address, deployment.evm.contracts.aqua, maxUint256)

    // Aqua strategy for the single pair
    {
      const { order, orderHash } = await client.evm.strategyOrder(bucketId, base.address, quote.address)
      const { tokensCount } = await client.evm.aquaBalance(owner.account.address, orderHash, base.address)
      if (tokensCount === 0) {
        const strategyBytes = encodeAbiParameters([orderAbiType], [[order.maker, order.traits, order.data]])
        await client.evm.shipAqua(owner, strategyBytes, [base.address, quote.address], [10n ** 30n, 10n ** 30n])
        info('strategy', `shipped ${spec.assets[0]}/${spec.assets[1]}`)
      }
    }

    // funding: owner starts 100% in base → out of policy vs the target split, so there is a real rebalance to run
    const snapshot = await client.evm.loadBucket(bucketId)
    if (snapshot.assets.every((a) => a.balance === 0n)) {
      const { priceWad } = await client.evm.price(base.address).catch(() => ({ priceWad: 0n }))
      const amount = amountOf(FUNDING_USD, base.decimals, priceWad, 'floor')
      if (amount > 0n) {
        const minted = await client.evm.write(deployer, { address: base.address, abi: bucketTestTokenAbi, functionName: 'mint', args: [owner.account.address, amount] })
        info(`fund ${spec.assets[0]}`, `${amount} (${evmTx(deployment, minted.transactionHash)})`)
      }
    } else {
      info('funding', 'owner wallet already funded')
    }

    // operator float: it acts as Aqua taker, supplying `quote` (tokenOut to the Bucket) on each fill
    {
      const { priceWad } = await client.evm.price(quote.address).catch(() => ({ priceWad: 0n }))
      const needed = amountOf(FUNDING_USD, quote.decimals, priceWad, 'floor') // covers a full base→quote rotation
      const bal = await evmClient.readContract({ address: quote.address, abi: bucketTestTokenAbi, functionName: 'balanceOf', args: [operator.account.address] })
      if (bal < needed && needed > 0n) {
        await client.evm.write(deployer, { address: quote.address, abi: bucketTestTokenAbi, functionName: 'mint', args: [operator.account.address, needed] })
        info(`operator ${spec.assets[1]}`, `minted ${needed} for fill coverage`)
      }
    }

    // rebalance capability to the shared ENSv2 operator (exec.<label>.<owner>.eth)
    const now = Math.floor(Date.now() / 1_000)
    const grant: CapabilityGrant = {
      operatorLabel: env.ENS_OPERATOR_LABEL,
      permissions: permissionMask(['Rebalance']),
      assetMask: 0b11,
      venueMask: 1,
      validAfter: now,
      validUntil: now + CAPABILITY_DURATION_SECONDS,
      payee: zeroAddress,
      limits: REBALANCE_LIMITS,
    }
    let cap = entry.capabilities.find((c) => c.label === 'trading-agent')
    const onChain = cap?.capabilityId ? await client.evm.getCapability(cap.capabilityId).catch(() => null) : null
    if (cap && isStale(onChain, now)) {
      entry.capabilities = entry.capabilities.filter((c) => c.label !== 'trading-agent')
      writeManifest(deployment)
      cap = undefined
    }
    if (!cap) {
      const issued = await client.evm.issueCapability(owner, bucketId, grant)
      entry.capabilities.push({ label: 'trading-agent', nonce: '1', capabilityId: issued.value.capabilityId, operatorLabel: env.ENS_OPERATOR_LABEL, operatorAddress: operator.account.address, permissions: grant.permissions })
      writeManifest(deployment)
      info('capability REBALANCE', `${issued.value.capabilityId} (${evmTx(deployment, issued.hash)})`)
    } else {
      info('capability REBALANCE', `active: ${cap.capabilityId}`)
    }
  }

  // operator gas
  const gas = await evmClient.getBalance({ address: operator.account.address })
  if (gas < parseEther('0.01')) {
    const hash = await deployer.sendTransaction({ to: operator.account.address, value: parseEther('0.02') })
    await evmClient.waitForTransactionReceipt({ hash })
    info('operator gas', 'funded 0.02 ETH')
  }

  step('Done')
  for (const b of deployment.buckets) info(b.ensName, `${b.bucketId} — ${b.capabilities.length} capability(ies)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
