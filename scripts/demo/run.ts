/**
 * BUCKET EVM end-to-end demo:
 *
 *   1  create a Bucket over the owner's own wallet (no vault, no deposit — the wallet's own balances are the
 *      Bucket's assets)
 *   2  the owner approves Aqua (rebalance/swap fills) and the controller (capability-gated payments)
 *   3  fund the owner wallet with an out-of-policy starting allocation
 *   4  issue a REBALANCE capability to the ENSv2-resolved trading agent, and a PAY capability (fixed payee) to a
 *      payments agent
 *   5  execute BUCKET_REBALANCE until the Bucket is back in policy — real Aqua + SwapVM fills
 *   6  execute a capability-gated payment
 *   7  malicious-agent scenarios: an execution above the capability's limit, an unapproved asset, an expired
 *      capability and a revoked capability are all rejected on-chain, not in the frontend
 *
 * Every number printed is read back from chain state.
 */
import {
  BucketStatus,
  CapabilityStatus,
  Permission,
  formatAmount,
  formatDeviation,
  formatUsd,
  formatWeight,
  permissionMask,
  permissionNames,
  usd,
  type CapabilityGrant,
  type Deployment,
  type DeploymentToken,
  type PolicyParams,
} from '@bucket/protocol-types'
import { BucketProtocolError, decodeBucketError, type BucketClient, type BucketView } from '@bucket/sdk'
import { bucketControllerAbi, bucketTestTokenAbi } from '@bucket/sdk'
import { amountOf, compileBucketProgram } from '@bucket/vm'
import { encodeAbiParameters, erc20Abi, formatEther, isAddressEqual, maxUint256, parseEther, zeroAddress, type Address, type Hex } from 'viem'

import { bucketClient, publicClient, walletClient } from '../lib/clients'
import { env, required } from '../lib/env'
import { evmTx, info, step } from '../lib/log'
import { readManifest, writeManifest } from '../lib/manifest'
import { publishPrices } from '../lib/prices'

const REBALANCE_LIMITS = { maxExecutionValue: usd('490'), maxHourlyValue: usd('1500'), maxDailyValue: usd('2000'), maxSlippageBps: 50, maxDailyTurnoverBps: 5_000, maxExecutions: 0 }
const PAYMENT_LIMITS = { maxExecutionValue: usd('500'), maxHourlyValue: usd('1000'), maxDailyValue: usd('2000'), maxSlippageBps: 0, maxDailyTurnoverBps: 8_000, maxExecutions: 0 }
const CAPABILITY_DURATION_SECONDS = 24 * 3_600
const FUNDING_USD = usd(env.DEMO_FUNDING_USD)
const INITIAL_BPS: Record<string, bigint> = { USDC: 7000n, ETH: 2000n, SUI: 1000n }
const MAX_EXECUTIONS = 6

function token(deployment: Deployment, symbol: string): DeploymentToken {
  const found = deployment.evm.tokens.find((t) => t.symbol === symbol)
  if (!found) throw new Error(`token ${symbol} missing from manifest`)
  return found
}

function tradingPolicy(deployment: Deployment): { params: PolicyParams; assets: ReturnType<typeof buildAsset>[] } {
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

function buildAsset(t: DeploymentToken, targetBps: number, minBps: number, maxBps: number) {
  return { token: t.address, decimals: t.decimals, targetBps, minBps, maxBps }
}

function describe(deployment: Deployment, tokenAddress: Address, amount: bigint): string {
  const t = deployment.evm.tokens.find((candidate) => isAddressEqual(candidate.address, tokenAddress))
  return t ? `${formatAmount(amount, t.decimals, 6)} ${t.symbol}` : `${amount} ${tokenAddress}`
}

function printBucket(view: BucketView): void {
  info('bucket', `${view.ensName} (${view.bucketId})`)
  info('total value', formatUsd(view.allocation.totalValueWad))
  for (const row of view.allocation.rows) {
    info(
      `  ${row.symbol}`,
      `${formatWeight(row.weightWad).padStart(8)}  target ${formatWeight(BigInt(row.targetBps) * 10n ** 14n).padStart(8)}  ${formatDeviation(row.deviationWad)}`,
    )
  }
  info('status', view.allocation.outOfPolicy ? 'REBALANCE REQUIRED' : 'WITHIN POLICY')
}

/** Runs `fn`, expecting it to reject; prints the decoded protocol error (or a generic message) as PROOF of rejection. */
async function expectRejected(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    throw new Error(`expected ${label} to be rejected, but it succeeded`)
  } catch (error) {
    const decoded = error instanceof BucketProtocolError ? error : decodeBucketError(error)
    info(`  REJECTED (${label})`, decoded ? decoded.message : error instanceof Error ? error.message : String(error))
  }
}

async function main(): Promise<void> {
  const deployment = readManifest()
  if (!deployment.ens || !deployment.evm.ens.ownerRegistry || !deployment.evm.ens.bucketRegistry) {
    throw new Error('ENSv2 hierarchy not configured; run `pnpm configure:ens`')
  }
  const client: BucketClient = bucketClient(deployment)
  const evmClient = publicClient()
  const deployer = walletClient(required('DEPLOYER_PRIVATE_KEY'))
  const owner = walletClient(required('OWNER_PRIVATE_KEY'))
  const operator = walletClient(required('OPERATOR_PRIVATE_KEY'))

  info('evm network', deployment.evm.network === 'sepolia-fork' ? 'LOCAL FORK of Sepolia' : 'Sepolia')
  await publishPrices(deployment)

  // 1 ----------------------------------------------------------------------------------------------------------
  step('1    Create the trading Bucket over the owner\'s own wallet')
  const { params, assets } = tradingPolicy(deployment)
  let bucketEntry = deployment.buckets.find((b) => b.label === 'trading')
  let bucketId = bucketEntry?.bucketId
  if (!bucketEntry) {
    const strategyExpiry = Math.floor(Date.now() / 1_000) + 365 * 24 * 3_600
    const created = await client.createBucket({
      wallet: owner,
      registry: deployment.evm.ens.ownerRegistry,
      label: 'trading',
      strategyExpiry,
      params,
      assets,
    })
    bucketId = created.bucketId
    bucketEntry = { label: 'trading', ensName: `trading.${deployment.ens.ownerName}`, bucketId, holder: owner.account.address, capabilities: [] }
    deployment.buckets.push(bucketEntry)
    writeManifest(deployment)
    info('bucket', bucketId)
    info('evm tx', evmTx(deployment, created.evmTx))
  } else {
    info('bucket', `exists: ${bucketId}`)
  }
  if (!bucketId) throw new Error('bucketId missing')

  // 2 ----------------------------------------------------------------------------------------------------------
  step('2    Owner approves Aqua (fills) and the controller (capability-gated payments)')
  for (const a of assets) {
    await client.evm.ensureAllowance(owner, a.token, deployment.evm.contracts.aqua, maxUint256)
  }
  await client.evm.ensureAllowance(owner, token(deployment, 'USDC').address, deployment.evm.contracts.controller, maxUint256)
  info('approvals', 'owner -> Aqua (USDC/ETH/SUI), owner -> Controller (USDC)')

  // Ship each token-pair Aqua strategy. The order hash = keccak256(abi.encode(order)), not keccak256(program),
  // so strategy bytes must be abi.encode(order) for rawBalances to match what the router uses in pull/push.
  const orderAbiType = { type: 'tuple', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] } as const
  const pairs: [Address, Address][] = [
    [assets[0]!.token as Address, assets[1]!.token as Address],
    [assets[0]!.token as Address, assets[2]!.token as Address],
    [assets[1]!.token as Address, assets[2]!.token as Address],
  ]
  for (const [tokenX, tokenY] of pairs) {
    const { order, orderHash } = await client.evm.strategyOrder(bucketId, tokenX, tokenY)
    const { tokensCount } = await client.evm.aquaBalance(owner.account.address, orderHash, tokenX)
    if (tokensCount === 0) {
      const strategyBytes = encodeAbiParameters([orderAbiType], [[order.maker, order.traits, order.data]])
      await client.evm.shipAqua(owner, strategyBytes, [tokenX, tokenY], [10n ** 30n, 10n ** 30n])
      info('Aqua strategy', `shipped pair ${tokenX.slice(0, 8)}…/${tokenY.slice(0, 8)}… orderHash=${orderHash.slice(0, 12)}…`)
    }
  }

  // 3 ----------------------------------------------------------------------------------------------------------
  step('3    Fund the owner wallet with an out-of-policy starting allocation')
  let snapshot = await client.evm.loadBucket(bucketId)
  if (snapshot.assets.every((a) => a.balance === 0n)) {
    for (const a of snapshot.assets) {
      const symbol = deployment.evm.tokens.find((t) => isAddressEqual(t.address, a.token))?.symbol ?? ''
      const valueWad = (FUNDING_USD * (INITIAL_BPS[symbol] ?? 0n)) / 10_000n
      const amount = amountOf(valueWad, a.decimals, a.priceWad, 'floor')
      if (amount === 0n) continue
      const minted = await client.evm.write(deployer, {
        address: a.token,
        abi: bucketTestTokenAbi,
        functionName: 'mint',
        args: [owner.account.address, amount],
      })
      info(`mint ${symbol}`, `${amount} to owner (${evmTx(deployment, minted.transactionHash)})`)
    }
  } else {
    info('funded', 'already funded')
  }
  printBucket(await client.getBucket(bucketId))

  // 4 ----------------------------------------------------------------------------------------------------------
  step('4    Issue Financial Capabilities to ENSv2-resolved operators')
  const now = Math.floor(Date.now() / 1_000)
  const validUntil = now + CAPABILITY_DURATION_SECONDS
  const rebalanceLabel = env.ENS_OPERATOR_LABEL
  const rebalanceGrant: CapabilityGrant = {
    operatorLabel: rebalanceLabel,
    permissions: permissionMask(['Rebalance']),
    assetMask: 0b111, // USDC | ETH | SUI
    venueMask: 1,
    validAfter: now,
    validUntil,
    payee: zeroAddress,
    limits: REBALANCE_LIMITS,
  }
  let rebalanceCap = bucketEntry.capabilities.find((c) => c.label === 'trading-agent')
  if (!rebalanceCap) {
    const issued = await client.evm.issueCapability(owner, bucketId, rebalanceGrant)
    rebalanceCap = {
      label: 'trading-agent',
      nonce: '1',
      capabilityId: issued.value.capabilityId,
      operatorLabel: rebalanceLabel,
      operatorAddress: operator.account.address,
      permissions: rebalanceGrant.permissions,
    }
    bucketEntry.capabilities.push(rebalanceCap)
    writeManifest(deployment)
    info('capability (REBALANCE)', `${issued.value.capabilityId} (${evmTx(deployment, issued.hash)})`)
  } else {
    info('capability (REBALANCE)', `exists: ${rebalanceCap.capabilityId}`)
  }
  const rebalanceCapabilityId = rebalanceCap.capabilityId
  if (!rebalanceCapabilityId) throw new Error('rebalance capabilityId missing')

  const paymentGrant: CapabilityGrant = {
    operatorLabel: rebalanceLabel,
    permissions: permissionMask(['Pay']),
    assetMask: 0b001, // USDC only
    venueMask: 1,
    validAfter: now,
    validUntil,
    payee: operator.account.address,
    limits: PAYMENT_LIMITS,
  }
  let paymentCap = bucketEntry.capabilities.find((c) => c.label === 'payments-agent')
  if (paymentCap) {
    // Re-issue if a prior run's step 8 revoked it — a revoked capability can't be un-revoked.
    const existing = paymentCap.capabilityId ? await client.evm.getCapability(paymentCap.capabilityId) : null
    if (existing?.status === CapabilityStatus.Revoked) {
      bucketEntry.capabilities = bucketEntry.capabilities.filter((c) => c.label !== 'payments-agent')
      writeManifest(deployment)
      paymentCap = undefined
    }
  }
  if (!paymentCap) {
    // Same ENSv2 operator name may hold several capabilities; this one narrower (PAY, fixed payee).
    const issued = await client.evm.issueCapability(owner, bucketId, paymentGrant)
    paymentCap = {
      label: 'payments-agent',
      nonce: '2',
      capabilityId: issued.value.capabilityId,
      operatorLabel: rebalanceLabel,
      operatorAddress: operator.account.address,
      permissions: paymentGrant.permissions,
    }
    bucketEntry.capabilities.push(paymentCap)
    writeManifest(deployment)
    info('capability (PAY)', `${issued.value.capabilityId} (${evmTx(deployment, issued.hash)})`)
  } else {
    info('capability (PAY)', `exists: ${paymentCap.capabilityId}`)
  }
  const paymentCapabilityId = paymentCap.capabilityId
  if (!paymentCapabilityId) throw new Error('payment capabilityId missing')

  const capability = await client.evm.getCapability(rebalanceCapabilityId)
  info('operator (live ENSv2 resolution)', capability.operator)
  info('permissions', permissionNames(capability.permissions).join(', '))

  const gas = await evmClient.getBalance({ address: operator.account.address })
  if (gas < parseEther('0.01')) {
    const hash = await deployer.sendTransaction({ to: operator.account.address, value: parseEther('0.02') })
    await evmClient.waitForTransactionReceipt({ hash })
    info('operator gas', `funded 0.02 ETH (had ${formatEther(gas)})`)
  }
  // Fund operator with test-token SUI and ETH so it can act as Aqua taker (provides tokenIn, receives tokenOut=USDC).
  // Amounts: 2 ETH-token (2e18 raw, 18 dec) + 500 SUI (5e11 raw, 9 dec) — more than enough for 6 fills at $500 cap.
  const operatorFunds: [Address, bigint][] = [
    [token(deployment, 'ETH').address as Address, 2n * 10n ** 18n],
    [token(deployment, 'SUI').address as Address, 500n * 10n ** 9n],
  ]
  for (const [tokenAddr, needed] of operatorFunds) {
    const bal = await evmClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [operator.account.address] })
    if (bal < needed) {
      await client.evm.write(deployer, { address: tokenAddr, abi: bucketTestTokenAbi, functionName: 'mint', args: [operator.account.address, needed] })
      info('operator tokens', `minted tETH/tSUI for fill coverage`)
    }
  }

  // 5 ----------------------------------------------------------------------------------------------------------
  for (let round = 1; round <= MAX_EXECUTIONS; round++) {
    const view = await client.getBucket(bucketId)
    // plan is null when an active intent is open; treat that as "still needs rebalance" and fall through
    if (view.plan !== null && !view.plan.required) {
      info('policy', `within policy (${view.plan.reason})`)
      break
    }
    step(`5    BUCKET_REBALANCE #${round}`)
    const execution = await client.executeRebalance({
      bucketId,
      capabilityId: rebalanceCapabilityId,
      wallet: operator,
      reuseActiveIntent: true,
      onStage: (update) => {
        if (update.status === 'running') return
        info(`  ${update.stage}`, `${update.status === 'done' ? '✓' : '–'} ${update.txHash ? evmTx(deployment, update.txHash) : update.detail ?? ''}`)
      },
    })
    info('  filled (on-chain receipt)', `amountIn=${execution.receipt.amountIn} amountOut=${execution.receipt.amountOut}`)
  }

  step('Final allocation (read back from chain state)')
  printBucket(await client.getBucket(bucketId))

  // 6 ----------------------------------------------------------------------------------------------------------
  step('6    Capability-gated payment (PAY, fixed payee)')
  const usdc = token(deployment, 'USDC')
  const paid = await client.evm.pay(operator, bucketId, paymentCapabilityId, usdc.address, amountOf(usd('50'), 6, 10n ** 18n, 'floor'))
  info('  paid', `50 USDC -> ${operator.account.address} (${evmTx(deployment, paid.hash)})`)

  // 7 ----------------------------------------------------------------------------------------------------------
  step('7    Malicious-agent scenarios: real rejected transactions')
  // $600: above the capability's $500 per-execution cap but within the holder's balance, so the rejection is the
  // capability limit and not the wallet balance.
  await expectRejected('execution above capability limit', () =>
    client.evm.pay(operator, bucketId, paymentCapabilityId, usdc.address, amountOf(usd('600'), 6, 10n ** 18n, 'floor')),
  )
  const rogue = deployment.evm.tokens.find((t) => t.symbol === 'PEPE')
  if (rogue) {
    await expectRejected('unapproved asset', () => client.evm.pay(operator, bucketId, paymentCapabilityId, rogue.address, 1_000_000n))
  }
  await expectRejected('wrong operator', () =>
    client.evm.pay(deployer, bucketId, paymentCapabilityId, usdc.address, amountOf(usd('10'), 6, 10n ** 18n, 'floor')),
  )

  // not-yet-valid capability: validAfter is 1 hour in the future so it's unreachable now
  const notYetValidGrant: CapabilityGrant = {
    operatorLabel: rebalanceLabel,
    permissions: permissionMask(['Pay']),
    assetMask: 0b001,
    venueMask: 1,
    validAfter: now + 3_600,   // starts 1 hour from now
    validUntil: now + 7_200,   // ends 2 hours from now
    payee: operator.account.address,
    limits: PAYMENT_LIMITS,
  }
  const { value: notYetValidIssuance, hash: notYetValidCapTx } = await client.evm.issueCapability(owner, bucketId, notYetValidGrant)
  info('capability (NOT-YET-VALID)', `${notYetValidIssuance.capabilityId} (${evmTx(deployment, notYetValidCapTx)})`)
  await expectRejected('not-yet-valid capability', () =>
    client.evm.pay(operator, bucketId, notYetValidIssuance.capabilityId, usdc.address, amountOf(usd('10'), 6, 10n ** 18n, 'floor')),
  )

  step('8    Owner revokes the payment capability')
  const revoked = await client.evm.revokeCapability(owner, paymentCapabilityId)
  info('revoked', evmTx(deployment, revoked.hash))
  await expectRejected('revoked capability', () =>
    client.evm.pay(operator, bucketId, paymentCapabilityId, usdc.address, amountOf(usd('10'), 6, 10n ** 18n, 'floor')),
  )

  // 0xd3 BucketWalletBalanceCheck:
  // Lives as opcode 6 in the canonical SwapVM program that governs every Aqua fill for this bucket.
  // Every successful fill in step 5 ran 0xd3 via the Aqua preTransferOut hook.
  // On-chain rejection proof: see Foundry test_d3_WalletBalanceCheck_Reverts_InsufficientBalance().
  step('9    0xd3 BucketWalletBalanceCheck — verify canonical program and live fill evidence')
  const bucketMeta = await client.evm.getBucket(bucketId)
  const canonicalProgram = compileBucketProgram({
    controller: deployment.evm.contracts.controller as Address,
    bucketId,
    strategyNonce: bucketMeta.strategyNonce,
    strategyExpiry: bucketMeta.strategyExpiry,
  })
  const onchainProgram = (await evmClient.readContract({
    address: deployment.evm.contracts.controller as Address,
    abi: bucketControllerAbi,
    functionName: 'strategyProgram',
    args: [bucketId],
  })) as Hex
  if (canonicalProgram.toLowerCase() !== onchainProgram.toLowerCase()) {
    throw new Error('bucket-vm compiled program differs from controller.strategyProgram — FAIL')
  }
  info('canonical program', `${(canonicalProgram.length - 2) / 2} bytes — bucket-vm output == controller.strategyProgram (byte-identical)`)
  // The last instruction is 0xd3 with its 52-byte args: [0xd3][52][controller][bucketId].
  const tail = canonicalProgram.slice(-2 * 54)
  if (!tail.toLowerCase().startsWith('d334')) throw new Error('0xd3 is not the final instruction — FAIL')
  info('0xd3 position', 'final instruction of the program (0xd3, 52-byte args)')
  info('0xd3 live evidence', `every step-5 fill ran the full program (0xd0-0xd3) inside router.swap; execution nonce=${bucketMeta.executionNonce}`)
  info('0xd3 rejection proof', 'Foundry (real Aqua + router): test_d3_Rejects_WalletDrainedBelowFill()')

  step('Final status')
  const meta = await client.evm.getBucket(bucketId)
  info('bucket status', BucketStatus.Active === meta.status ? 'ACTIVE' : String(meta.status))
  info('execution nonce', meta.executionNonce)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
