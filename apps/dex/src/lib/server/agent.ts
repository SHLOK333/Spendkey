
import { CapabilityStatus, BucketStatus, Permission, formatUsd, hasPermissions, type DeploymentToken } from '@bucket/protocol-types'
import { bucketControllerAbi, decodeBucketError, toReceipt, buildPayTx, type SuiCapabilityView } from '@bucket/sdk'
import { amountOf, planRebalance, valueOf } from '@bucket/vm'
import { verifyPersonalMessageSignature } from '@mysten/sui/verify'
import {
  erc20Abi,
  formatUnits,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  parseUnits,
  toBytes,
  type Address,
  type Hex,
} from 'viem'

import {
  approvalMessage,
  canonicalAction,
  type AgentAction,
  type Approval,
  type BlockedReason,
  type ExecutionResult,
  type PolicyCheck,
  type ValidationResult,
} from '@/lib/agent/schema'
import { explainError, explainMoveAbort } from '@/lib/errors'

import { loadDeployment } from './deployment'
import { evmAgentWallet, evmServer } from './evm'
import { suiAgentClient, suiAgentKeypair, suiServer } from './sui'

const ROLE_PAY = 0x10n
const SUI_TYPE = '0x2::sui::SUI'
const SUI_DECIMALS = 9
const DAY_MS = 86_400_000n

type Swap = Extract<AgentAction, { action: 'swap' }>
type Rebalance = Extract<AgentAction, { action: 'rebalance' }>
type Pay = Extract<AgentAction, { action: 'pay' }>
type SuiPay = Extract<AgentAction, { action: 'sui_pay' }>

class Checks {
  readonly list: PolicyCheck[] = []
  private firstBlocked: BlockedReason | null = null
  add(id: string, label: string, ok: boolean, detail: string, blocked?: BlockedReason) {
    this.list.push({ id, label, ok, detail })
    if (!ok && !this.firstBlocked) this.firstBlocked = blocked ?? { title: 'Execution blocked', message: `${label}: ${detail}` }
  }
  get ok() {
    return this.list.every((c) => c.ok)
  }
  get blocked() {
    return this.firstBlocked
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const min = (...v: bigint[]) => v.reduce((a, b) => (a < b ? a : b))

function token(symbol: string): DeploymentToken {
  const d = loadDeployment()
  const s = symbol.replace(/^t/i, '').toUpperCase()
  const found = d.evm.tokens.find((t) => t.symbol.toUpperCase() === s)
  if (!found) throw new Error(`unknown asset ${symbol}`)
  return found
}

function symbolOf(address: string): { symbol: string; decimals: number } {
  const t = loadDeployment().evm.tokens.find((x) => isAddressEqual(x.address, address as Address))
  return t ? { symbol: t.symbol, decimals: t.decimals } : { symbol: short(address), decimals: 18 }
}

function explorerTx(hash: string): string {
  return `${loadDeployment().evm.explorer ?? 'https://sepolia.etherscan.io'}/tx/${hash}`
}

function suiExplorerTx(digest: string): string {
  return `${loadDeployment().sui?.explorer ?? 'https://suiscan.xyz/testnet'}/tx/${digest}`
}

async function evmDryRun(call: { functionName: string; args: readonly unknown[] }, account: Address): Promise<{ ok: true } | { ok: false; name: string | null; raw: string }> {
  const d = loadDeployment()
  const { publicClient } = evmServer()
  try {
    await publicClient.simulateContract({
      address: d.evm.contracts.controller,
      abi: bucketControllerAbi,
      functionName: call.functionName as never,
      args: call.args as never,
      account,
    })
    return { ok: true }
  } catch (error) {
    const decoded = decodeBucketError(error)
    return { ok: false, name: decoded?.errorName ?? null, raw: decoded?.message ?? (error instanceof Error ? error.message : String(error)) }
  }
}

function dryRunCheck(checks: Checks, fn: string, result: Awaited<ReturnType<typeof evmDryRun>>) {
  if (result.ok) {
    checks.add('dryrun', 'On-chain dry run', true, `${fn} accepted by the contracts (eth_call, nothing submitted)`)
    return
  }
  const e = explainError(result.name)
  checks.add('dryrun', 'On-chain dry run', false, result.name ? `${fn} reverts with ${result.name}` : result.raw.slice(0, 200), {
    title: e?.title ?? 'Execution blocked',
    message: e?.message ?? 'The contracts reject this action.',
    ...(result.name ? { errorName: result.name } : {}),
  })
}

// ================================================================================================= EVM validation

async function evmContext(action: Swap | Rebalance | Pay) {
  const { bucket } = evmServer()
  const agent = evmAgentWallet()
  const bucketId = action.bucketId as Hex
  const capabilityId = action.capabilityId as Hex
  const [capability, snapshot, epoch, now, limits, name] = await Promise.all([
    bucket.evm.getCapability(capabilityId),
    bucket.evm.loadBucket(bucketId),
    bucket.evm.epochOf(bucketId),
    bucket.evm.blockTimestamp(),
    bucket.evm.effectiveLimits(bucketId, capabilityId),
    bucket.evm.nameOf(bucketId),
  ])
  const bucketName = await bucket.ens.fullName(name.registry, name.label)
  const operatorName = `${capability.operatorLabel}.${bucketName}`
  return { bucket, agent, bucketId, capabilityId, capability, snapshot, epoch, now, limits, bucketName, operatorName }
}

function identityChecks(checks: Checks, ctx: Awaited<ReturnType<typeof evmContext>>, permission: number, permissionName: string) {
  const { capability: cap, agent, snapshot, epoch, now } = ctx
  checks.add(
    'operator',
    'Operator authorized',
    !!agent && isAddressEqual(cap.operator, agent.account.address),
    agent
      ? `${ctx.operatorName} → ${short(cap.operator)} (live ENSv2)${isAddressEqual(cap.operator, agent.account.address) ? '' : ` — agent is ${short(agent.account.address)}`}`
      : 'the agent operator key is not configured on the server',
    { title: 'Execution blocked', message: 'This operator is not authorized for this Bucket.' },
  )
  const n = Number(now)
  const problems: string[] = []
  if (cap.status !== CapabilityStatus.Active) problems.push(cap.status === CapabilityStatus.Revoked ? 'revoked' : 'not active')
  if (n < cap.validAfter) problems.push('not valid yet')
  if (n > cap.validUntil) problems.push('expired')
  if (cap.epoch !== epoch) problems.push('revoked by kill switch')
  if (cap.policyVersion !== snapshot.policyVersion) problems.push('policy changed since issuance')
  if (snapshot.status !== BucketStatus.Active) problems.push('Bucket paused')
  checks.add(
    'capability',
    'Capability active',
    problems.length === 0,
    problems.length === 0 ? `expires ${new Date(cap.validUntil * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : problems.join(', '),
    {
      title: 'Execution blocked',
      message: problems.includes('revoked') || problems.includes('revoked by kill switch')
        ? 'This operator is no longer authorized for this Bucket.'
        : `This capability is ${problems.join(', ')}.`,
    },
  )
  checks.add('permission', `${permissionName} permitted`, hasPermissions(cap.permissions, permission), hasPermissions(cap.permissions, permission) ? 'granted by the capability' : `the capability does not grant ${permissionName}`, {
    title: 'Execution blocked',
    message: `This capability does not allow ${permissionName.toLowerCase()} actions.`,
  })
}

function assetCheck(checks: Checks, ctx: Awaited<ReturnType<typeof evmContext>>, tokens: DeploymentToken[]) {
  const missing = tokens.filter((t) => {
    const i = ctx.snapshot.assets.findIndex((a) => isAddressEqual(a.token, t.address))
    return i < 0 || (ctx.capability.assetMask & (1 << i)) === 0
  })
  checks.add('asset', 'Asset allowed', missing.length === 0, missing.length === 0 ? tokens.map((t) => t.symbol).join(' → ') + ' in policy and capability' : `${missing.map((t) => t.symbol).join(', ')} not allowed`, {
    title: 'Execution blocked',
    message: `${missing.map((t) => t.symbol).join(', ')} is not allowed for this capability.`,
  })
}

function limitChecks(checks: Checks, ctx: Awaited<ReturnType<typeof evmContext>>, value: bigint) {
  const { limits } = ctx
  checks.add('limit', 'Execution limit', value <= limits.maxExecutionValue, `${formatUsd(value)} ${value <= limits.maxExecutionValue ? "≤" : ">"} ${formatUsd(limits.maxExecutionValue)}`, {
    title: 'Execution blocked',
    message: 'This action exceeds your Bucket limit.',
    requested: formatUsd(value),
    allowed: formatUsd(limits.maxExecutionValue),
  })
  const remaining = min(limits.remainingHourlyValue, limits.remainingDailyValue, limits.remainingTurnoverValue)
  checks.add('velocity', 'Velocity limit', value <= remaining, `${formatUsd(value)} ${value <= remaining ? "≤" : ">"} ${formatUsd(remaining)} remaining`, {
    title: 'Execution blocked',
    message: 'This would exceed the remaining hourly/daily limit.',
    requested: formatUsd(value),
    allowed: formatUsd(remaining),
  })
}

async function walletChecks(checks: Checks, ctx: Awaited<ReturnType<typeof evmContext>>, t: DeploymentToken, amount: bigint, spender: Address, spenderName: string) {
  const asset = ctx.snapshot.assets.find((a) => isAddressEqual(a.token, t.address))
  const balance = asset?.balance ?? 0n
  checks.add('balance', 'Wallet balance', balance >= amount, `${formatUnits(balance, t.decimals)} ${t.symbol} in the owner's wallet`, {
    title: 'Execution blocked',
    message: 'Your wallet does not have enough of the required asset.',
    requested: `${formatUnits(amount, t.decimals)} ${t.symbol}`,
    allowed: `${formatUnits(balance, t.decimals)} ${t.symbol}`,
  })
  const allowance = await ctx.bucket.evm.publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: 'allowance', args: [ctx.snapshot.holder, spender] })
  checks.add('allowance', `Wallet approval (${spenderName})`, allowance >= amount, allowance >= amount ? 'the owner approved this spender; revoking it stops all execution' : `owner approved only ${formatUnits(allowance, t.decimals)} ${t.symbol}`, {
    title: 'Execution blocked',
    message: `Your wallet has not approved ${spenderName} for ${t.symbol}.`,
  })
}

async function validateSwap(action: Swap): Promise<ValidationResult> {
  const ctx = await evmContext(action)
  const checks = new Checks()
  const sell = token(action.sellSymbol)
  const buy = token(action.buySymbol)
  const amountOut = parseUnits(action.sellAmount, sell.decimals)
  identityChecks(checks, ctx, Permission.Swap, 'Swap')
  assetCheck(checks, ctx, [sell, buy])

  const assetOut = ctx.snapshot.assets.find((a) => isAddressEqual(a.token, sell.address))
  const value = assetOut ? valueOf(amountOut, assetOut.decimals, assetOut.priceWad, 'ceil') : 0n
  limitChecks(checks, ctx, value)
  await walletChecks(checks, ctx, sell, amountOut, loadDeployment().evm.contracts.aqua, 'Aqua')

  let quote: ValidationResult['quote'] = null
  try {
    const preview = await ctx.bucket.previewSwap({ bucketId: ctx.bucketId, capabilityId: ctx.capabilityId, tokenOut: sell.address, tokenIn: buy.address, amountOut })
    const f = preview.fill
    checks.add('program', 'SwapVM policy (0xd1 quote, 0xd2 limits, band)', f.ok, f.ok ? `post-trade allocation stays inside policy bands` : String(f.failure), {
      title: explainError(f.failure)?.title ?? 'Execution blocked',
      message: explainError(f.failure)?.message ?? `Rejected by the Bucket program (${f.failure}).`,
      ...(f.failure ? { errorName: f.failure } : {}),
    })
    quote = {
      sell: { symbol: sell.symbol, amount: formatUnits(f.amountOut, sell.decimals) },
      buy: { symbol: buy.symbol, amount: formatUnits(f.amountIn, buy.decimals) },
      valueUsd: formatUsd(f.valueOut),
      route: 'Aqua / SwapVM (BUCKET program 0xd0 → 0xd3)',
    }
  } catch (error) {
    const name = /PriceStale/.test(String(error)) ? 'BucketMathPriceStale' : null
    checks.add('program', 'SwapVM policy', false, name ?? String(error).slice(0, 160), {
      title: explainError(name)?.title ?? 'Execution blocked',
      message: explainError(name)?.message ?? 'The Bucket program cannot price this trade.',
    })
  }
  if (ctx.agent) {
    dryRunCheck(checks, 'openSwapIntent', await evmDryRun({ functionName: 'openSwapIntent', args: [ctx.bucketId, ctx.capabilityId, sell.address, buy.address, amountOut] }, ctx.agent.account.address))
  }
  return result(action, checks, quote, ctx)
}

async function validateRebalance(action: Rebalance): Promise<ValidationResult> {
  const ctx = await evmContext(action)
  const checks = new Checks()
  identityChecks(checks, ctx, Permission.Rebalance, 'Rebalance')
  const plan = planRebalance(ctx.snapshot, ctx.limits, ctx.capability.assetMask, ctx.now)
  let quote: ValidationResult['quote'] = null
  if (!plan.required) {
    const e = explainError(plan.reason === 'PriceStale' ? 'BucketMathPriceStale' : plan.reason)
    checks.add('program', 'Rebalance required', false, plan.reason, { title: e?.title ?? 'Nothing to do', message: e?.message ?? plan.reason })
  } else {
    const out = ctx.snapshot.assets[plan.outIndex]!
    const inn = ctx.snapshot.assets[plan.inIndex]!
    const outToken = symbolOf(out.token)
    const inToken = symbolOf(inn.token)
    checks.add('program', 'Rebalance required', true, `sell overweight ${outToken.symbol}, buy underweight ${inToken.symbol}`)
    limitChecks(checks, ctx, plan.tradeValue)
    await walletChecks(checks, ctx, token(outToken.symbol), plan.budgetOut, loadDeployment().evm.contracts.aqua, 'Aqua')
    quote = {
      sell: { symbol: outToken.symbol, amount: formatUnits(plan.budgetOut, outToken.decimals) },
      buy: { symbol: inToken.symbol, amount: formatUnits(amountOf(plan.tradeValue, inn.decimals, inn.priceWad, 'floor'), inToken.decimals) },
      valueUsd: formatUsd(plan.tradeValue),
      route: 'Aqua / SwapVM (BUCKET program 0xd0 → 0xd3)',
    }
    if (ctx.agent && ctx.snapshot.activeIntent === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      dryRunCheck(checks, 'openRebalanceIntent', await evmDryRun({ functionName: 'openRebalanceIntent', args: [ctx.bucketId, ctx.capabilityId] }, ctx.agent.account.address))
    }
  }
  return result(action, checks, quote, ctx)
}

async function validatePay(action: Pay): Promise<ValidationResult> {
  const ctx = await evmContext(action)
  const checks = new Checks()
  const t = token(action.symbol)
  const amount = parseUnits(action.amount, t.decimals)
  identityChecks(checks, ctx, Permission.Pay, 'Pay')
  assetCheck(checks, ctx, [t])
  const asset = ctx.snapshot.assets.find((a) => isAddressEqual(a.token, t.address))
  const value = asset ? valueOf(amount, asset.decimals, asset.priceWad, 'ceil') : 0n
  limitChecks(checks, ctx, value)
  await walletChecks(checks, ctx, t, amount, loadDeployment().evm.contracts.controller, 'BUCKET controller')
  if (ctx.agent) {
    dryRunCheck(checks, 'pay', await evmDryRun({ functionName: 'pay', args: [ctx.bucketId, ctx.capabilityId, t.address, amount] }, ctx.agent.account.address))
  }
  const quote = {
    sell: { symbol: t.symbol, amount: action.amount },
    buy: null,
    valueUsd: formatUsd(value),
    route: `Direct transfer: owner wallet → fixed payee ${short(ctx.capability.payee)}`,
  }
  return result(action, checks, quote, ctx)
}

function result(action: AgentAction, checks: Checks, quote: ValidationResult['quote'], ctx: Awaited<ReturnType<typeof evmContext>>): ValidationResult {
  return {
    ok: checks.ok,
    action,
    checks: checks.list,
    blocked: checks.ok ? null : checks.blocked,
    quote,
    operator: { address: ctx.capability.operator, name: ctx.operatorName },
    capabilityLabel: null,
  }
}

// ================================================================================================= Sui validation

async function suiContext(action: SuiPay) {
  const s = suiServer()
  if (!s || !s.sui.accessControlId || !s.sui.suinsObjectId) throw new Error('Sui deployment is not configured in the manifest')
  const keypair = suiAgentKeypair()
  const agent = keypair?.toSuiAddress() ?? null
  const bucket = await s.reader.getBucket(action.bucketObjectId)
  const caps = await s.reader.listCapabilities(action.bucketObjectId, bucket.capabilityNonce)
  const nowMs = BigInt(Date.now())
  const payCaps = caps.filter((c) => agent && c.operator === agent && hasPermissions(c.permissions, Permission.Pay))
  const cap: SuiCapabilityView | null =
    payCaps.find((c) => c.status === 1 && c.epoch === bucket.capabilityEpoch && c.policyVersion === bucket.policy.version && nowMs / 1000n <= c.validUntil) ??
    payCaps.at(-1) ??
    null
  let operatorCapId: string | null = null
  if (agent && cap) {
    const owned = await s.client.listOwnedObjects({ owner: agent, type: `${s.sui.packageId}::bucket::OperatorCap` })
    for (const o of owned.objects) {
      const oc = await s.reader.getOperatorCap(o.objectId)
      if (oc.bucketId === bucket.objectId && oc.capabilityNonce === cap.nonce) operatorCapId = o.objectId
    }
  }
  return { s, agent, bucket, cap, operatorCapId, nowMs }
}

async function validateSuiPay(action: SuiPay): Promise<ValidationResult> {
  const ctx = await suiContext(action)
  const { s, agent, bucket, cap, nowMs } = ctx
  const checks = new Checks()
  const amount = parseUnits(action.amount, SUI_DECIMALS)

  let resolvedName: string | null = null
  if (cap?.operatorName.endsWith('.sui')) {
    try {
      const target = await s.reader.resolveSuinsPrincipal(s.sui.suinsObjectId!, cap.operatorName)
      resolvedName = target === agent ? cap.operatorName : null
    } catch {
      resolvedName = null
    }
  }
  checks.add('operator', 'Operator identity', !!agent && !!cap, agent ? (cap ? `${cap.operatorName} → ${short(agent)}${resolvedName ? ' (live SuiNS)' : ''}` : `no PAY capability names ${short(agent)}`) : 'the Sui agent key is not configured on the server', {
    title: 'Execution blocked',
    message: 'This operator has no payment authority on this Bucket.',
  })
  const role = agent ? await s.reader.hasRole(s.sui.accessControlId!, bucket.objectId, agent, ROLE_PAY) : false
  checks.add('role', 'EAC ROLE_PAY', role, role ? 'granted on this Bucket (Move-enforced)' : 'not granted or revoked', {
    title: 'Execution blocked',
    message: 'This operator is no longer authorized for this Bucket (EAC role revoked).',
  })
  if (cap) {
    const problems: string[] = []
    if (cap.status !== 1) problems.push(cap.status === 2 ? 'revoked' : 'not active')
    if (cap.epoch !== bucket.capabilityEpoch) problems.push('revoked by kill switch')
    if (cap.policyVersion !== bucket.policy.version) problems.push('policy changed since issuance')
    if (nowMs / 1000n > cap.validUntil) problems.push('expired')
    if (bucket.status !== 1) problems.push('Bucket paused')
    checks.add('capability', 'Capability active', problems.length === 0, problems.length === 0 ? `expires ${new Date(Number(cap.validUntil) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : problems.join(', '), {
      title: 'Execution blocked',
      message: problems.includes('revoked') ? 'This operator is no longer authorized for this Bucket.' : `This capability is ${problems.join(', ')}.`,
    })
    checks.add('limit', 'Execution limit', amount <= cap.limits.maxPerTx, `${formatUnits(amount, 9)} ${amount <= cap.limits.maxPerTx ? "≤" : ">"} ${formatUnits(cap.limits.maxPerTx, 9)} SUI`, {
      title: 'Execution blocked',
      message: 'This payment exceeds your Bucket limit.',
      requested: `${formatUnits(amount, 9)} SUI`,
      allowed: `${formatUnits(cap.limits.maxPerTx, 9)} SUI`,
    })
    const today = nowMs / DAY_MS
    const spentToday = cap.usage.dayWindow === today ? cap.usage.dayValue : 0n
    const remaining = cap.limits.maxDailySpend - spentToday
    checks.add('velocity', 'Daily limit', amount <= remaining, `${formatUnits(remaining, 9)} SUI remaining today`, {
      title: 'Execution blocked',
      message: 'This would exceed the daily limit.',
      requested: `${formatUnits(amount, 9)} SUI`,
      allowed: `${formatUnits(remaining, 9)} SUI`,
    })
  }
  const vault = await s.reader.vaultBalance(bucket.objectId, SUI_TYPE)
  checks.add('balance', 'Bucket vault balance', vault >= amount, `${formatUnits(vault, 9)} SUI in the Bucket's Move vault`, {
    title: 'Execution blocked',
    message: "The Bucket's vault does not hold enough SUI.",
  })
  checks.add('opcap', 'OperatorCap held by agent', !!ctx.operatorCapId, ctx.operatorCapId ? short(ctx.operatorCapId) : 'the agent holds no OperatorCap for this capability', {
    title: 'Execution blocked',
    message: 'The agent does not hold an OperatorCap for this Bucket.',
  })

  if (agent && cap && ctx.operatorCapId) {
    const tx = buildPayTx({
      packageId: s.sui.packageId,
      bucketObjectId: bucket.objectId,
      accessControlId: s.sui.accessControlId!,
      operatorCapId: ctx.operatorCapId,
      coinType: SUI_TYPE,
      recipient: cap.payee,
      amount,
      deadline: nowMs / 1000n + 600n,
    })
    tx.setSender(agent)
    const sim = await s.client.simulateTransaction({ transaction: tx })
    if (sim.$kind === 'Transaction' && sim.Transaction.status.success) {
      checks.add('dryrun', 'Move dry run', true, 'bucket::pay accepted by Move (simulated, nothing submitted)')
    } else {
      const status = JSON.stringify(sim.$kind === 'Transaction' ? sim.Transaction.status : sim.FailedTransaction.status)
      const e = explainMoveAbort(status)
      checks.add('dryrun', 'Move dry run', false, e ? `${e.module}::abort ${e.code}` : status.slice(0, 200), {
        title: e?.title ?? 'Execution blocked',
        message: e?.message ?? 'Move rejects this payment.',
        ...(e ? { errorName: `${e.module}::${e.code}` } : {}),
      })
    }
  }
  return {
    ok: checks.ok,
    action,
    checks: checks.list,
    blocked: checks.ok ? null : checks.blocked,
    quote: { sell: { symbol: 'SUI', amount: action.amount }, buy: null, valueUsd: null, route: `Move vault → fixed payee ${cap ? short(cap.payee) : '?'}` },
    operator: { address: agent ?? '', name: cap?.operatorName ?? null },
    capabilityLabel: cap ? `nonce ${cap.nonce}` : null,
  }
}

export async function validateAction(action: AgentAction): Promise<ValidationResult> {
  switch (action.action) {
    case 'swap':
      return validateSwap(action)
    case 'rebalance':
      return validateRebalance(action)
    case 'pay':
      return validatePay(action)
    case 'sui_pay':
      return validateSuiPay(action)
  }
}

// ================================================================================================= approval

/** Only the Bucket owner may make the agent act: an off-chain signature over this exact action (copilot) or over a
 *  time-boxed autonomous session. The chain still enforces every limit; this stops third parties from spending the
 *  agent's authority. */
export async function verifyApproval(action: AgentAction, approval: Approval): Promise<void> {
  if (approval.expires < Math.floor(Date.now() / 1000)) throw new Error('approval expired')

  if (action.action === 'sui_pay') {
    const s = suiServer()
    if (!s) throw new Error('Sui not configured')
    const bucket = await s.reader.getBucket(action.bucketObjectId)
    // `session-all` binds the owner address, not a single Bucket, so one signature covers every Bucket the owner holds.
    const target = approval.scope === 'session-all' ? bucket.owner : action.bucketObjectId
    const message = approvalMessage({ scope: approval.scope, target, actionHash: keccak256(toBytes(canonicalAction(action))), expires: approval.expires })
    const pk = await verifyPersonalMessageSignature(new TextEncoder().encode(message), approval.signature)
    if (pk.toSuiAddress() !== bucket.owner) throw new Error('approval was not signed by the Bucket owner')
    return
  }

  const { bucket, publicClient } = evmServer()
  const snapshot = await bucket.evm.loadBucket(action.bucketId as Hex)
  // A `session-all` signature is over the owner address and reused for every Bucket; each execution is still bound
  // to the true holder (checked here) and to that Bucket's on-chain capability (checked in executeAction).
  const target = approval.scope === 'session-all' ? (approval.signer as Address) : (action.bucketId as string)
  const message = approvalMessage({ scope: approval.scope, target, actionHash: keccak256(toBytes(canonicalAction(action))), expires: approval.expires })
  if (!isAddressEqual(approval.signer as Address, snapshot.holder)) throw new Error('approval was not signed by the Bucket owner')
  const valid = await publicClient.verifyMessage({ address: snapshot.holder, message, signature: approval.signature as Hex })
  if (!valid) throw new Error('invalid approval signature')
}

// ================================================================================================= execution

async function walletAfter(bucketId: Hex): Promise<ExecutionResult['walletAfter']> {
  const snapshot = await evmServer().bucket.evm.loadBucket(bucketId)
  return snapshot.assets.map((a) => {
    const t = symbolOf(a.token)
    return { symbol: t.symbol, amount: formatUnits(a.balance, t.decimals) }
  })
}

export class BlockedError extends Error {
  constructor(readonly validation: ValidationResult) {
    super(validation.blocked?.message ?? 'blocked by BUCKET')
  }
}

/** Re-validates, then executes with the agent operator's own key. Returns amounts from the on-chain receipt. */
export async function executeAction(action: AgentAction): Promise<{ validation: ValidationResult; result: ExecutionResult }> {
  const validation = await validateAction(action)
  if (!validation.ok) throw new BlockedError(validation)

  if (action.action === 'sui_pay') {
    const ctx = await suiContext(action)
    const agent = suiAgentClient()
    if (!agent || !ctx.cap || !ctx.operatorCapId) throw new Error('Sui agent not ready')
    const amount = parseUnits(action.amount, SUI_DECIMALS)
    const paid = await agent.client.pay({
      packageId: ctx.s.sui.packageId,
      bucketObjectId: ctx.bucket.objectId,
      accessControlId: ctx.s.sui.accessControlId!,
      operatorCapId: ctx.operatorCapId,
      coinType: SUI_TYPE,
      recipient: ctx.cap.payee,
      amount,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    })
    const tx = await ctx.s.client.getTransaction({ digest: paid.digest, include: { balanceChanges: true } })
    const done = tx.$kind === 'Transaction' ? tx.Transaction : tx.FailedTransaction
    const received = done.balanceChanges?.find((b) => b.address === ctx.cap!.payee && b.coinType.endsWith('::sui::SUI') && BigInt(b.amount) > 0n)
    const vaultAfter = await ctx.s.reader.vaultBalance(ctx.bucket.objectId, SUI_TYPE)
    return {
      validation,
      result: {
        network: 'sui',
        kind: 'sui_pay',
        transactions: [{ label: 'bucket::pay', hash: paid.digest, url: suiExplorerTx(paid.digest) }],
        actual: {
          sold: { symbol: 'SUI', amount: formatUnits(received ? BigInt(received.amount) : amount, SUI_DECIMALS) },
          bought: null,
          recipient: ctx.cap.payee,
        },
        walletAfter: [{ symbol: 'SUI (Bucket vault)', amount: formatUnits(vaultAfter, SUI_DECIMALS) }],
      },
    }
  }

  const wallet = evmAgentWallet()
  if (!wallet) throw new Error('EVM agent key not configured')
  const { bucket } = evmServer()
  const bucketId = action.bucketId as Hex
  const capabilityId = action.capabilityId as Hex

  if (action.action === 'pay') {
    const t = token(action.symbol)
    const paid = await bucket.evm.pay(wallet, bucketId, capabilityId, t.address, parseUnits(action.amount, t.decimals))
    const [event] = parseEventLogs({ abi: bucketControllerAbi, eventName: 'ExecutionRecorded', logs: paid.receipt.logs })
    const r = event ? toReceipt(event.args.receipt as Parameters<typeof toReceipt>[0]) : null
    const out = r ? symbolOf(r.tokenOut) : null
    return {
      validation,
      result: {
        network: 'sepolia',
        kind: 'pay',
        transactions: [{ label: 'pay', hash: paid.hash, url: explorerTx(paid.hash) }],
        actual: {
          sold: r && out ? { symbol: out.symbol, amount: formatUnits(r.amountOut, out.decimals) } : null,
          bought: null,
          recipient: r?.recipient ?? null,
        },
        walletAfter: await walletAfter(bucketId),
      },
    }
  }

  const executed =
    action.action === 'swap'
      ? await bucket.executeSwap({
          bucketId,
          capabilityId,
          wallet,
          tokenOut: token(action.sellSymbol).address,
          tokenIn: token(action.buySymbol).address,
          amountOut: parseUnits(action.sellAmount, token(action.sellSymbol).decimals),
        })
      : await bucket.executeRebalance({ bucketId, capabilityId, wallet, reuseActiveIntent: true })
  const r = executed.receipt
  const out = symbolOf(r.tokenOut)
  const inn = symbolOf(r.tokenIn)
  return {
    validation,
    result: {
      network: 'sepolia',
      kind: action.action,
      transactions: [
        ...(executed.openTx ? [{ label: 'open intent', hash: executed.openTx, url: explorerTx(executed.openTx) }] : []),
        { label: 'Aqua + SwapVM fill', hash: executed.fillTx, url: explorerTx(executed.fillTx) },
      ],
      actual: {
        sold: { symbol: out.symbol, amount: formatUnits(r.amountOut, out.decimals) },
        bought: { symbol: inn.symbol, amount: formatUnits(r.amountIn, inn.decimals) },
        recipient: null,
      },
      walletAfter: await walletAfter(bucketId),
    },
  }
}

export function agentIdentities() {
  const evm = evmAgentWallet()
  const sui = suiAgentKeypair()
  return { evm: evm?.account.address ?? null, sui: sui?.toSuiAddress() ?? null }
}

