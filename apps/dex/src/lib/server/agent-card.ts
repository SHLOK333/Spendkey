/**
 * ERC-8004 (Trustless Agents) identity for BUCKET operator agents, published as an A2A-style **AgentCard**.
 *
 * ERC-8004 makes an agent verifiable by binding a human-readable identity (here, the agent's ENSv2 name, e.g.
 * `exec.trading.<owner>.eth`) to a machine-readable capability manifest. We build that manifest from LIVE chain
 * state — the agent's currently-executable BUCKET capabilities — so the card can never claim authority the chain
 * doesn't grant:
 *
 *   - `registrations[]`  binds the ENS name + CAIP-10 operator address (the on-chain identity).
 *   - `trustModels`      declares HOW to trust it: the ENSv2 name resolves to the operator, and every skill is
 *                        gated by an on-chain capability that the owner can revoke at any time.
 *   - `skills[]`         one entry per granted permission (swap / rebalance / pay) on a LIVE capability (active,
 *                        current epoch + policy version, unexpired), carrying the capabilityId, allowed assets and
 *                        USD limits a counterparty can independently verify on-chain.
 *
 * The card is data, not authority: BUCKET + the chain remain the source of truth on every execution.
 */
import { CapabilityStatus, Permission, formatUsd, hasPermissions } from '@bucket/protocol-types'
import { isAddressEqual, type Address, type Hex } from 'viem'

import { agentIdentities } from './agent'
import { loadDeployment } from './deployment'
import { evmServer } from './evm'

const A2A_PROTOCOL_VERSION = '0.3.0'

interface CapabilitySkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: string[]
  readonly 'x-bucket-capability': Record<string, unknown>
}

const SKILL_META: Record<'swap' | 'rebalance' | 'pay', { name: string; description: string }> = {
  swap: { name: 'Token swap', description: 'Swaps between the Bucket policy assets through 1inch Aqua / BUCKET SwapVM, within capability limits.' },
  rebalance: { name: 'Portfolio rebalance', description: 'Rebalances the Bucket back inside its policy bands; BUCKET picks the overweight→underweight leg.' },
  pay: { name: 'Payment', description: 'Pays the capability\'s fixed payee from the owner wallet, within per-execution and daily limits.' },
}

/** Build the ERC-8004 AgentCard for one EVM Bucket agent from live chain state. */
export async function buildAgentCard(bucketId: string, origin: string): Promise<Record<string, unknown>> {
  const d = loadDeployment()
  const { bucket } = evmServer()
  const operator = agentIdentities().evm
  const id = bucketId as Hex

  const [view, capIds, epoch, snapshot, now] = await Promise.all([
    bucket.getBucket(id),
    bucket.evm.capabilitiesOf(id),
    bucket.evm.epochOf(id),
    bucket.evm.loadBucket(id),
    bucket.evm.blockTimestamp(),
  ])
  const symbolOf = (a: string) => d.evm.tokens.find((t) => isAddressEqual(t.address, a as Address))?.symbol ?? a
  const ensName = view.ensName
  const chainId = d.evm.chainId

  const skills: CapabilitySkill[] = []
  let operatorName = ensName
  for (const capId of capIds) {
    const cap = await bucket.evm.getCapability(capId)
    if (!operator || !isAddressEqual(cap.operator, operator as Address)) continue
    // A capability is executable only when active, on the current epoch + policy version, and within its validity
    // window — exactly the check the client and the chain apply. Anything else must not appear as an offered skill.
    const live =
      cap.status === CapabilityStatus.Active &&
      cap.epoch === epoch &&
      cap.policyVersion === snapshot.policyVersion &&
      Number(now) <= cap.validUntil &&
      Number(now) >= cap.validAfter
    if (!live) continue
    operatorName = `${cap.operatorLabel}.${ensName}`
    const assets = view.snapshot.assets.filter((_, i) => (cap.assetMask & (1 << i)) !== 0).map((a) => symbolOf(a.token))
    const base = {
      capabilityId: capId,
      operatorName,
      assets,
      maxPerExecutionUsd: formatUsd(cap.limits.maxExecutionValue),
      maxDailyUsd: formatUsd(cap.limits.maxDailyValue),
      validUntil: new Date(cap.validUntil * 1000).toISOString(),
      status: 'ACTIVE',
    }
    const add = (kind: 'swap' | 'rebalance' | 'pay', extra: Record<string, unknown> = {}) =>
      skills.push({
        id: `${kind}:${capId}`,
        name: SKILL_META[kind].name,
        description: SKILL_META[kind].description,
        tags: ['defi', kind, 'bucket', 'erc-8004'],
        'x-bucket-capability': { ...base, ...extra },
      })
    if (hasPermissions(cap.permissions, Permission.Swap)) add('swap')
    if (hasPermissions(cap.permissions, Permission.Rebalance)) add('rebalance')
    if (hasPermissions(cap.permissions, Permission.Pay)) add('pay', { payee: cap.payee })
  }

  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: `${operatorName} — BUCKET agent`,
    description:
      `Autonomous BUCKET operator for ${ensName}. Assets stay in the owner's self-custodial wallet; every action is ` +
      `bounded on-chain by an ENSv2-authorized capability the owner can revoke at any time.`,
    url: `${origin}/agents`,
    version: '1.0.0',
    provider: { organization: 'BUCKET Protocol', url: origin },
    // ERC-8004 identity binding: the ENS name + CAIP-10 on-chain address of the agent operator.
    registrations: operator
      ? [{ agentId: `eip155:${chainId}:${operator}`, agentAddress: operator, ensName: operatorName, chainId }]
      : [],
    // How a counterparty establishes trust without trusting us: resolve the ENS name, then verify each skill's
    // capability on-chain (status, operator, limits, expiry) against the BUCKET controller.
    trustModels: ['ens-identity', 'onchain-capability'],
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['application/json'],
    skills,
    'x-bucket': {
      standard: 'ERC-8004',
      bucketId,
      ensName,
      owner: view.owner,
      status: view.snapshot.status === 1 ? 'ACTIVE' : 'PAUSED',
      network: 'sepolia',
      custody: "Assets stay in the owner's wallet; the agent can only move them through Aqua/SwapVM within its capability.",
      controller: d.evm.contracts.controller,
      registry: d.evm.ens?.ownerRegistry ?? null,
      verify: `${origin}/api/agent/card?bucketId=${bucketId}`,
    },
  }
}

/** Build cards for every EVM Bucket in the deployment manifest. */
export async function buildAgentCards(origin: string): Promise<Array<Record<string, unknown>>> {
  const d = loadDeployment()
  const ids = d.buckets.filter((b) => b.bucketId).map((b) => b.bucketId as string)
  return Promise.all(ids.map((id) => buildAgentCard(id, origin)))
}
