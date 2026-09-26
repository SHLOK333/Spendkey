
import { CAPABILITY_STATUS_LABEL, Permission, formatUsd, hasPermissions, permissionNames } from '@bucket/protocol-types'
import { formatUnits, isAddressEqual, type Hex } from 'viem'

import { agentIdentities } from './agent'
import { loadDeployment } from './deployment'
import { evmServer } from './evm'
import { protocolEvents } from './indexer'
import { suiServer } from './sui'

export type Selection = { network: 'sepolia'; bucketId: string } | { network: 'sui'; bucketObjectId: string }

/** Everything the LLM may know: balances, allocation, the agent's own authority and recent activity. No keys, no
 *  signing capability — only facts it needs to reason about the permitted task. */
export async function agentContext(selection: Selection): Promise<Record<string, unknown>> {
  const ids = agentIdentities()
  if (selection.network === 'sui') {
    const s = suiServer()
    if (!s) throw new Error('Sui not configured')
    const bucket = await s.reader.getBucket(selection.bucketObjectId)
    const caps = await s.reader.listCapabilities(bucket.objectId, bucket.capabilityNonce)
    const vault = await s.reader.vaultBalance(bucket.objectId, '0x2::sui::SUI')
    return {
      network: 'Sui Testnet',
      bucket: { objectId: bucket.objectId, name: bucket.name, owner: bucket.owner, status: bucket.status === 1 ? 'ACTIVE' : 'PAUSED' },
      custody: "On Sui, payments draw from the Bucket's Move vault, which only the owner's OwnerCap can withdraw.",
      vault: { SUI: formatUnits(vault, 9) },
      agentOperator: ids.sui,
      agentCapabilities: caps
        .filter((c) => c.operator === ids.sui)
        .map((c) => ({
          nonce: c.nonce.toString(),
          operatorName: c.operatorName,
          permissions: permissionNames(c.permissions),
          maxPerPaymentSui: formatUnits(c.limits.maxPerTx, 9),
          maxDailySui: formatUnits(c.limits.maxDailySpend, 9),
          payee: c.payee,
          validUntil: new Date(Number(c.validUntil) * 1000).toISOString(),
          status: c.status === 1 ? 'ACTIVE' : c.status === 2 ? 'REVOKED' : 'EXHAUSTED',
        })),
      supportedActions: ['sui_pay'],
    }
  }

  const d = loadDeployment()
  const { bucket } = evmServer()
  const bucketId = selection.bucketId as Hex
  const view = await bucket.getBucket(bucketId)
  const capIds = await bucket.evm.capabilitiesOf(bucketId)
  const caps = await Promise.all(capIds.map((id) => bucket.evm.getCapability(id).then((c) => ({ id, c }))))
  const events = (await protocolEvents()).events
    .filter((e) => e.eventName === 'ExecutionRecorded' && e.args.bucketId === bucketId)
    .slice(0, 5)
  const sym = (a: string) => d.evm.tokens.find((t) => isAddressEqual(t.address, a as `0x${string}`))
  return {
    network: 'Ethereum Sepolia',
    bucket: { bucketId, ensName: view.ensName, owner: view.owner, status: view.snapshot.status === 1 ? 'ACTIVE' : 'PAUSED' },
    custody: "Assets stay in the owner's wallet; the agent can only move them through Aqua/SwapVM within its capability.",
    ownerWallet: view.allocation.rows.map((r) => ({
      symbol: r.symbol,
      balance: formatUnits(r.balance, r.decimals),
      valueUsd: formatUsd(r.valueWad),
      weightPct: (Number(r.weightWad) / 1e16).toFixed(2),
      targetPct: (r.targetBps / 100).toFixed(2),
    })),
    totalValueUsd: formatUsd(view.allocation.totalValueWad),
    outOfPolicy: view.allocation.outOfPolicy,
    policyAssets: view.snapshot.assets.map((a) => sym(a.token)?.symbol ?? a.token),
    agentOperator: ids.evm,
    agentCapabilities: caps
      .filter(({ c }) => ids.evm && isAddressEqual(c.operator, ids.evm as `0x${string}`))
      .map(({ id, c }) => ({
        capabilityId: id,
        operatorName: `${c.operatorLabel}.${view.ensName}`,
        permissions: permissionNames(c.permissions),
        canSwap: hasPermissions(c.permissions, Permission.Swap),
        canRebalance: hasPermissions(c.permissions, Permission.Rebalance),
        canPay: hasPermissions(c.permissions, Permission.Pay),
        assets: view.snapshot.assets.filter((_, i) => (c.assetMask & (1 << i)) !== 0).map((a) => sym(a.token)?.symbol),
        maxPerExecutionUsd: formatUsd(c.limits.maxExecutionValue),
        maxDailyUsd: formatUsd(c.limits.maxDailyValue),
        validUntil: new Date(c.validUntil * 1000).toISOString(),
        status: CAPABILITY_STATUS_LABEL[c.status],
        payee: c.payee,
      })),
    recentExecutions: events.map((e) => {
      const r = e.args.receipt as Record<string, string>
      const out = sym(r.tokenOut ?? '')
      const inn = sym(r.tokenIn ?? '')
      return {
        tx: e.txHash,
        sold: out ? `${formatUnits(BigInt(r.amountOut ?? '0'), out.decimals)} ${out.symbol}` : null,
        received: inn && BigInt(r.amountIn ?? '0') > 0n ? `${formatUnits(BigInt(r.amountIn ?? '0'), inn.decimals)} ${inn.symbol}` : null,
      }
    }),
    supportedActions: ['swap', 'rebalance', 'pay'],
  }
}
