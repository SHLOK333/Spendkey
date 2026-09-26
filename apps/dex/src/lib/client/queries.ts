import { CapabilityStatus, Permission, hasPermissions, type Capability, type EffectiveLimits } from '@bucket/protocol-types'
import type { SuiCapabilityView } from '@bucket/sdk'
import { valueOf } from '@bucket/vm'
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, isAddressEqual, type Address, type Hex } from 'viem'

import { useApp, useOwnerWallet } from './app'

export interface WalletAsset {
  readonly symbol: string
  readonly address: Address
  readonly decimals: number
  readonly balance: bigint
  readonly priceWad: bigint
  readonly valueWad: bigint
}

/** ERC-20 balances of the deployment's tokens in `owner`'s wallet, priced by the protocol's reference feed. */
export function useWalletAssets(owner: Address | null) {
  const { deployment, publicClient, bucket } = useApp()
  return useQuery({
    queryKey: ['wallet-assets', owner],
    enabled: !!owner,
    refetchInterval: 15_000,
    queryFn: async (): Promise<WalletAsset[]> => {
      return Promise.all(
        deployment.evm.tokens.map(async (t) => {
          const [balance, price] = await Promise.all([
            publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner!] }),
            bucket.evm.price(t.address).catch(() => ({ priceWad: 0n, updatedAt: 0n })),
          ])
          return { symbol: t.symbol, address: t.address, decimals: t.decimals, balance, priceWad: price.priceWad, valueWad: valueOf(balance, t.decimals, price.priceWad) }
        }),
      )
    },
  })
}

export interface IndexedEvent {
  readonly contract: 'controller' | 'capabilities' | 'authority'
  readonly eventName: string
  readonly args: Record<string, unknown>
  readonly txHash: string
  readonly blockNumber: string
  readonly logIndex: number
  readonly timestamp: number | null
}

export function useProtocolEvents() {
  return useQuery({
    queryKey: ['protocol-events'],
    refetchInterval: 20_000,
    staleTime: 15_000,
    queryFn: async (): Promise<IndexedEvent[]> => {
      const res = await fetch('/api/activity', { cache: 'no-store' })
      const body = (await res.json()) as { events?: IndexedEvent[]; error?: string }
      if (!res.ok || !body.events) throw new Error(body.error ?? 'activity unavailable')
      return body.events
    },
  })
}

export interface KnownBucket {
  readonly bucketId: Hex
  readonly holder: Address
  readonly label: string
}

/** Buckets discovered from on-chain `BucketCreated` events (plus the manifest, which the demo scripts maintain). */
export function useKnownBuckets() {
  const { deployment } = useApp()
  const events = useProtocolEvents()
  const fromManifest: KnownBucket[] = deployment.buckets
    .filter((b) => b.bucketId)
    .map((b) => ({ bucketId: b.bucketId as Hex, holder: b.holder as Address, label: b.ensName }))
  const fromChain: KnownBucket[] = (events.data ?? [])
    .filter((e) => e.eventName === 'BucketCreated')
    .map((e) => ({ bucketId: e.args.bucketId as Hex, holder: e.args.holder as Address, label: String(e.args.label ?? '') }))
  const all = [...fromManifest]
  for (const b of fromChain) if (!all.some((x) => x.bucketId === b.bucketId)) all.push(b)
  return { buckets: all, isLoading: events.isLoading }
}

export function useBucketView(bucketId: Hex | null) {
  const { bucket } = useApp()
  return useQuery({
    queryKey: ['bucket-view', bucketId],
    enabled: !!bucketId,
    refetchInterval: 15_000,
    queryFn: () => bucket.getBucket(bucketId!),
  })
}

export interface CapabilityRow {
  readonly id: Hex
  readonly capability: Capability
  readonly limits: EffectiveLimits | null
  readonly live: boolean
}

export function useCapabilities(bucketId: Hex | null) {
  const { bucket } = useApp()
  return useQuery({
    queryKey: ['capabilities', bucketId],
    enabled: !!bucketId,
    refetchInterval: 20_000,
    queryFn: async (): Promise<CapabilityRow[]> => {
      const ids = await bucket.evm.capabilitiesOf(bucketId!)
      const [epoch, snapshot, now] = await Promise.all([bucket.evm.epochOf(bucketId!), bucket.evm.loadBucket(bucketId!), bucket.evm.blockTimestamp()])
      const rows = await Promise.all(
        ids.map(async (id) => {
          const capability = await bucket.evm.getCapability(id)
          const live =
            capability.status === CapabilityStatus.Active &&
            capability.epoch === epoch &&
            capability.policyVersion === snapshot.policyVersion &&
            Number(now) <= capability.validUntil &&
            Number(now) >= capability.validAfter
          const limits = live ? await bucket.evm.effectiveLimits(bucketId!, id).catch(() => null) : null
          return { id, capability, limits, live }
        }),
      )
      return rows.reverse()
    },
  })
}

export interface OwnerAgentBucket {
  readonly bucketId: Hex
  readonly holder: Address
  readonly ensName: string
  readonly agentCaps: CapabilityRow[]
  readonly swapCaps: CapabilityRow[]
  readonly rebalanceCaps: CapabilityRow[]
  readonly payCaps: CapabilityRow[]
}

/**
 * Every EVM Bucket the connected wallet owns, each with the agent operator's live capabilities on it. This is what
 * binds all of the owner's agents (trading, savings, payments) to a single chat: the chat reasons over all of them
 * and one owner-signed session authorizes execution across the whole set.
 */
export function useOwnerAgentBuckets() {
  const { address } = useOwnerWallet()
  const { bucket } = useApp()
  const { buckets, isLoading } = useKnownBuckets()
  const agent = useAgentStatus()
  const operator = agent.data?.evmOperator ?? null
  const owned = address ? buckets.filter((b) => isAddressEqual(b.holder, address)) : []
  const ids = owned.map((b) => b.bucketId)
  const q = useQuery({
    queryKey: ['owner-agent-buckets', ids, operator],
    enabled: ids.length > 0,
    refetchInterval: 20_000,
    queryFn: async (): Promise<OwnerAgentBucket[]> =>
      Promise.all(
        owned.map(async (b) => {
          const [view, capIds, epoch, snapshot, now] = await Promise.all([
            bucket.getBucket(b.bucketId),
            bucket.evm.capabilitiesOf(b.bucketId),
            bucket.evm.epochOf(b.bucketId),
            bucket.evm.loadBucket(b.bucketId),
            bucket.evm.blockTimestamp(),
          ])
          const rows: CapabilityRow[] = await Promise.all(
            capIds.map(async (id) => {
              const capability = await bucket.evm.getCapability(id)
              const live =
                capability.status === CapabilityStatus.Active &&
                capability.epoch === epoch &&
                capability.policyVersion === snapshot.policyVersion &&
                Number(now) <= capability.validUntil &&
                Number(now) >= capability.validAfter
              const limits = live ? await bucket.evm.effectiveLimits(b.bucketId, id).catch(() => null) : null
              return { id, capability, limits, live }
            }),
          )
          const agentCaps = rows.filter((r) => r.live && operator && isAddressEqual(r.capability.operator, operator as Address))
          return {
            bucketId: b.bucketId,
            holder: b.holder,
            ensName: view.ensName,
            agentCaps,
            swapCaps: agentCaps.filter((c) => hasPermissions(c.capability.permissions, Permission.Swap)),
            rebalanceCaps: agentCaps.filter((c) => hasPermissions(c.capability.permissions, Permission.Rebalance)),
            payCaps: agentCaps.filter((c) => hasPermissions(c.capability.permissions, Permission.Pay)),
          }
        }),
      ),
  })
  return { buckets: q.data ?? [], isLoading: isLoading || q.isLoading, isOwner: !!address && owned.length > 0 }
}

export interface AgentCardSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: string[]
  readonly 'x-bucket-capability': {
    readonly capabilityId: string
    readonly operatorName: string
    readonly assets: string[]
    readonly maxPerExecutionUsd: string
    readonly maxDailyUsd: string
    readonly validUntil: string
    readonly status: string
    readonly payee?: string
  }
}

export interface AgentCard {
  readonly protocolVersion: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly registrations: Array<{ agentId: string; agentAddress: string; ensName: string; chainId: number }>
  readonly trustModels: string[]
  readonly skills: AgentCardSkill[]
  readonly 'x-bucket': {
    readonly standard: string
    readonly bucketId: string
    readonly ensName: string
    readonly owner: string
    readonly status: string
    readonly network: string
    readonly custody: string
    readonly controller: string
    readonly registry: string | null
    readonly verify: string
  }
}

/** ERC-8004 AgentCards for every EVM Bucket agent in the deployment (identity + on-chain-verifiable capabilities). */
export function useAgentCards() {
  return useQuery({
    queryKey: ['agent-cards'],
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async (): Promise<AgentCard[]> => {
      const res = await fetch('/api/agent/card', { cache: 'no-store' })
      const body = (await res.json()) as { cards?: AgentCard[]; error?: string }
      if (!res.ok || !body.cards) throw new Error(body.error ?? 'agent cards unavailable')
      return body.cards
    },
  })
}

export interface AgentStatus {
  readonly evmOperator: Address | null
  readonly evmOperatorGasEth: string | null
  readonly suiOperator: string | null
  readonly ai: { configured: boolean; source: 'byok' | 'server' | null; model: string | null }
}

export function useAgentStatus() {
  return useQuery({
    queryKey: ['agent-status'],
    refetchInterval: 30_000,
    queryFn: async (): Promise<AgentStatus> => (await fetch('/api/agent/status', { cache: 'no-store' })).json() as Promise<AgentStatus>,
  })
}

export interface SuiBucketData {
  readonly state: Awaited<ReturnType<NonNullable<ReturnType<typeof useApp>['suiReader']>['getBucket']>>
  readonly vaultSui: bigint
  readonly capabilities: Array<SuiCapabilityView & { hasRolePay: boolean }>
}

export function useSuiBucket(objectId: string | null) {
  const { suiReader, deployment } = useApp()
  return useQuery({
    queryKey: ['sui-bucket', objectId],
    enabled: !!objectId && !!suiReader,
    refetchInterval: 15_000,
    queryFn: async (): Promise<SuiBucketData> => {
      const state = await suiReader!.getBucket(objectId!)
      const [vaultSui, caps] = await Promise.all([
        suiReader!.vaultBalance(objectId!, '0x2::sui::SUI'),
        suiReader!.listCapabilities(objectId!, state.capabilityNonce),
      ])
      const ac = deployment.sui?.accessControlId
      const capabilities = await Promise.all(
        caps.map(async (c) => ({ ...c, hasRolePay: ac ? await suiReader!.hasRole(ac, objectId!, c.operator, 0x10n) : false })),
      )
      return { state, vaultSui, capabilities: capabilities.reverse() }
    },
  })
}

export function useSuiBalance(address: string | null) {
  const { suiClient } = useApp()
  return useQuery({
    queryKey: ['sui-balance', address],
    enabled: !!address && !!suiClient,
    refetchInterval: 15_000,
    queryFn: async () => {
      const res = await suiClient!.getBalance({ owner: address!, coinType: '0x2::sui::SUI' })
      return BigInt(res.balance.balance)
    },
  })
}

export function isOwner(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.startsWith('0x') && a.length === 42 && b.length === 42 ? isAddressEqual(a as Address, b as Address) : a.toLowerCase() === b.toLowerCase()
}
