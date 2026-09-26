/**
 * Provisions every Bucket in the ENSv2 hierarchy so all three are instantly usable — the two-path onboarding's
 * "pick a ready-made Bucket" option needs more than one live Bucket to choose from.
 *
 * For each of trading / savings / payments.<owner>.eth this script (idempotently):
 *   1  creates the Bucket vault over the owner's own wallet (self-custody — the wallet's balances are the assets)
 *   2  approves Aqua (fills) and the controller (capability-gated payments)
 *   3  ships the three Aqua token-pair strategies for that Bucket
 *   4  funds the owner wallet with an out-of-policy starting allocation (once; the three Buckets share the wallet)
 *   5  issues a REBALANCE capability (trading-agent) and a PAY capability (payments-agent) to the ENSv2 operator,
 *      re-issuing any that are missing, expired or revoked (a revoked/expired capability can't be revived)
 *
 * Prerequisite: `pnpm configure:ens` (each Bucket name must own a subregistry holding `exec`, or `issue()` reverts
 * with OperatorNameNotRegistered). Unlike `pnpm demo`, this script never revokes what it issues — it leaves every
 * Bucket in a ready, in-policy-capable state. Every value is read back from chain.
 */
import {
  CapabilityStatus,
  permissionMask,
  permissionNames,
  usd,
  type Capability,
  type CapabilityGrant,
  type Deployment,
  type DeploymentToken,
  type PolicyParams,
} from '@bucket/protocol-types'
import { bucketTestTokenAbi, type BucketClient } from '@bucket/sdk'
import { amountOf } from '@bucket/vm'
import { encodeAbiParameters, erc20Abi, formatEther, isAddressEqual, maxUint256, parseEther, zeroAddress, type Address, type Hex } from 'viem'

import { bucketClient, publicClient, walletClient } from '../lib/clients'
import { BUCKET_LABELS } from './ens'
import { env, required } from '../lib/env'
import { evmTx, info, step } from '../lib/log'
import { readManifest, writeManifest } from '../lib/manifest'
import { publishPrices } from '../lib/prices'

// These mirror the demo's policy so a Bucket set up here behaves identically to the one `pnpm demo` drives.
const REBALANCE_LIMITS = { maxExecutionValue: usd('490'), maxHourlyValue: usd('1500'), maxDailyValue: usd('2000'), maxSlippageBps: 50, maxDailyTurnoverBps: 5_000, maxExecutions: 0 }
const PAYMENT_LIMITS = { maxExecutionValue: usd('500'), maxHourlyValue: usd('1000'), maxDailyValue: usd('2000'), maxSlippageBps: 0, maxDailyTurnoverBps: 8_000, maxExecutions: 0 }
const CAPABILITY_DURATION_SECONDS = 24 * 3_600
const FUNDING_USD = usd(env.DEMO_FUNDING_USD)
const INITIAL_BPS: Record<string, bigint> = { USDC: 7000n, ETH: 2000n, SUI: 1000n }

function token(deployment: Deployment, symbol: string): DeploymentToken {
  const found = deployment.evm.tokens.find((t) => t.symbol === symbol)
  if (!found) throw new Error(`token ${symbol} missing from manifest`)
  return found
}

function buildAsset(t: DeploymentToken, targetBps: number, minBps: number, maxBps: number) {
  return { token: t.address, decimals: t.decimals, targetBps, minBps, maxBps }
}

function bucketPolicy(deployment: Deployment): { params: PolicyParams; assets: ReturnType<typeof buildAsset>[] } {
  const usdc = token(deployment, 'USDC')
  const eth = token(deployment, 'ETH')
  const sui = token(deployment, 'SUI')
  const delegable = permissionMask(['Rebalance', 'Swap', 'Pay', 'Delegate'])
  return {
    params: {
      rebalanceThresholdBps: 500,
      maxSlippageBps: 100,
      maxPriceAge: 3_600,
      auctionDuration: 300,
      venueMask: 1,
      maxDailyTurnoverBps: 8_000,
      delegablePermissions: delegable,
      maxExecutionValue: usd('1000'),
      maxHourlyValue: usd('3000'),
      maxDailyValue: usd('5000'),
    },
    assets: [buildAsset(usdc, 5000, 3000, 7000), buildAsset(eth, 3000, 1500, 4500), buildAsset(sui, 2000, 1000, 3000)],
  }
}

/** A capability we should replace: absent on-chain, revoked/exhausted, or already past its validity window. */
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
  await publishPrices(deployment)

  const { params, assets } = bucketPolicy(deployment)
  const orderAbiType = { type: 'tuple', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] } as const
  const pairs: [Address, Address][] = [
    [assets[0]!.token as Address, assets[1]!.token as Address],
    [assets[0]!.token as Address, assets[2]!.token as Address],
    [assets[1]!.token as Address, assets[2]!.token as Address],
  ]

  for (const label of BUCKET_LABELS) {
    step(`Bucket "${label}" — ${label}.${deployment.ens.ownerName}`)

    // 1 — vault (deterministic bucketId over the owner-owned ENSv2 name)
    //
    // Protocol invariant: `assetClaim[holder][token]` binds each of a wallet's tokens to a single Bucket
    // (BucketController._claimAssets), and `holder == msg.sender == the ENSv2 name owner`. All three names here are
    // owned by the same wallet, so only the first Bucket can claim USDC/ETH/SUI — the rest revert with
    // AssetClaimedByBucket. A second, third… Bucket therefore needs its own holder wallet (its own ENSv2 name).
    // We skip (rather than fail) so this stays an idempotent "keep every existing Bucket healthy" tool.
    let entry = deployment.buckets.find((b) => b.label === label)
    let bucketId = entry?.bucketId as Hex | undefined
    if (!entry || !bucketId) {
      const strategyExpiry = Math.floor(Date.now() / 1_000) + 365 * 24 * 3_600
      try {
        const created = await client.createBucket({ wallet: owner, registry: ownerRegistry, label, strategyExpiry, params, assets })
        bucketId = created.bucketId
        entry = { label, ensName: `${label}.${deployment.ens.ownerName}`, bucketId, holder: owner.account.address, capabilities: [] }
        deployment.buckets.push(entry)
        writeManifest(deployment)
        info('created', `${bucketId} (${evmTx(deployment, created.evmTx)})`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes('AssetClaimedByBucket')) {
          info('skip', `${label}: this wallet's assets are already claimed by another Bucket (one Bucket per wallet)`)
          continue
        }
        throw error
      }
    } else {
      info('vault', `exists: ${bucketId}`)
    }

    // 2 — approvals (idempotent: ensureAllowance is a no-op when already max)
    for (const a of assets) await client.evm.ensureAllowance(owner, a.token, deployment.evm.contracts.aqua, maxUint256)
    await client.evm.ensureAllowance(owner, token(deployment, 'USDC').address, deployment.evm.contracts.controller, maxUint256)

    // 3 — Aqua strategies per token pair (orderHash is bucket-specific, so ship for each Bucket)
    for (const [tokenX, tokenY] of pairs) {
      const { order, orderHash } = await client.evm.strategyOrder(bucketId, tokenX, tokenY)
      const { tokensCount } = await client.evm.aquaBalance(owner.account.address, orderHash, tokenX)
      if (tokensCount === 0) {
        const strategyBytes = encodeAbiParameters([orderAbiType], [[order.maker, order.traits, order.data]])
        await client.evm.shipAqua(owner, strategyBytes, [tokenX, tokenY], [10n ** 30n, 10n ** 30n])
        info('strategy', `shipped ${tokenX.slice(0, 8)}…/${tokenY.slice(0, 8)}…`)
      }
    }

    // 4 — funding (the three Buckets share the owner wallet, so this fires once and later Buckets see it funded)
    const snapshot = await client.evm.loadBucket(bucketId)
    if (snapshot.assets.every((a) => a.balance === 0n)) {
      for (const a of snapshot.assets) {
        const symbol = deployment.evm.tokens.find((t) => isAddressEqual(t.address, a.token))?.symbol ?? ''
        const valueWad = (FUNDING_USD * (INITIAL_BPS[symbol] ?? 0n)) / 10_000n
        const amount = amountOf(valueWad, a.decimals, a.priceWad, 'floor')
        if (amount === 0n) continue
        const minted = await client.evm.write(deployer, { address: a.token, abi: bucketTestTokenAbi, functionName: 'mint', args: [owner.account.address, amount] })
        info(`fund ${symbol}`, `${amount} (${evmTx(deployment, minted.transactionHash)})`)
      }
    } else {
      info('funding', 'owner wallet already funded')
    }

    // 5 — capabilities (issue or re-issue REBALANCE + PAY to the ENSv2 operator under this Bucket)
    const now = Math.floor(Date.now() / 1_000)
    const validUntil = now + CAPABILITY_DURATION_SECONDS
    const opLabel = env.ENS_OPERATOR_LABEL

    const grants: Array<{ manifestLabel: string; nonce: string; grant: CapabilityGrant }> = [
      {
        manifestLabel: 'trading-agent',
        nonce: '1',
        grant: { operatorLabel: opLabel, permissions: permissionMask(['Rebalance']), assetMask: 0b111, venueMask: 1, validAfter: now, validUntil, payee: zeroAddress, limits: REBALANCE_LIMITS },
      },
      {
        manifestLabel: 'payments-agent',
        nonce: '2',
        grant: { operatorLabel: opLabel, permissions: permissionMask(['Pay']), assetMask: 0b001, venueMask: 1, validAfter: now, validUntil, payee: operator.account.address, limits: PAYMENT_LIMITS },
      },
    ]

    for (const { manifestLabel, nonce, grant } of grants) {
      let cap = entry.capabilities.find((c) => c.label === manifestLabel)
      const onChain = cap?.capabilityId ? await client.evm.getCapability(cap.capabilityId).catch(() => null) : null
      if (cap && isStale(onChain, now)) {
        entry.capabilities = entry.capabilities.filter((c) => c.label !== manifestLabel)
        writeManifest(deployment)
        cap = undefined
      }
      if (!cap) {
        const issued = await client.evm.issueCapability(owner, bucketId, grant)
        entry.capabilities.push({ label: manifestLabel, nonce, capabilityId: issued.value.capabilityId, operatorLabel: opLabel, operatorAddress: operator.account.address, permissions: grant.permissions })
        writeManifest(deployment)
        info(`capability ${manifestLabel}`, `${issued.value.capabilityId} [${permissionNames(grant.permissions).join(',')}] (${evmTx(deployment, issued.hash)})`)
      } else {
        info(`capability ${manifestLabel}`, `active: ${cap.capabilityId}`)
      }
    }
  }

  // Operator gas + test-token float so the one agent can act as Aqua taker on any of the three Buckets.
  const gas = await evmClient.getBalance({ address: operator.account.address })
  if (gas < parseEther('0.01')) {
    const hash = await deployer.sendTransaction({ to: operator.account.address, value: parseEther('0.02') })
    await evmClient.waitForTransactionReceipt({ hash })
    info('operator gas', `funded 0.02 ETH (had ${formatEther(gas)})`)
  }
  const operatorFunds: [Address, bigint][] = [
    [token(deployment, 'ETH').address as Address, 2n * 10n ** 18n],
    [token(deployment, 'SUI').address as Address, 500n * 10n ** 9n],
  ]
  for (const [tokenAddr, needed] of operatorFunds) {
    const bal = await evmClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [operator.account.address] })
    if (bal < needed) {
      await client.evm.write(deployer, { address: tokenAddr, abi: bucketTestTokenAbi, functionName: 'mint', args: [operator.account.address, needed] })
      info('operator tokens', 'minted tETH/tSUI for fill coverage')
    }
  }

  step('Done')
  for (const b of deployment.buckets) {
    info(b.ensName, `${b.bucketId} — ${b.capabilities.length} capability(ies)`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
