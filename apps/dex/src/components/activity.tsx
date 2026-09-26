import { Permission, hasPermissions } from '@bucket/protocol-types'
import { ArrowRight, Ban, Bot, CheckCircle2, CreditCard, FilePlus2, KeyRound, Repeat, Settings2, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { isAddressEqual, type Address } from 'viem'

import { Card, CardHeader, Skeleton, TxLink } from '@/components/ui/primitives'
import { useApp, useTokenOf } from '@/lib/client/app'
import { useAgentStatus, useKnownBuckets, useProtocolEvents, type IndexedEvent } from '@/lib/client/queries'
import { shortAddr, timeAgo, tokenAmount } from '@/lib/utils'

export type ActivityCategory = 'swaps' | 'payments' | 'agent' | 'buckets' | 'capabilities' | 'revocations'

export interface ActivityItem {
  readonly key: string
  readonly categories: ActivityCategory[]
  readonly icon: ReactNode
  readonly title: string
  readonly body: ReactNode
  readonly who: string | null
  readonly bucketId: string | null
  readonly txHash: string
  readonly timestamp: number | null
}

const EXECUTION_KIND: Record<number, string> = { 1: 'Rebalance', 2: 'Swap', 3: 'Payment' }

export function useActivityItems(): { items: ActivityItem[]; isLoading: boolean; error: unknown } {
  const events = useProtocolEvents()
  const tokenOf = useTokenOf()
  const agent = useAgentStatus()
  const agentOp = agent.data?.evmOperator ?? null

  const amount = (token: unknown, value: unknown) => {
    const t = tokenOf(String(token ?? ''))
    return t ? `${tokenAmount(BigInt(String(value ?? '0')), t.decimals, 6)} ${t.symbol}` : String(value)
  }

  const items: ActivityItem[] = []
  for (const e of events.data ?? []) {
    const base = { key: `${e.txHash}-${e.logIndex}`, txHash: e.txHash, timestamp: e.timestamp, bucketId: (e.args.bucketId as string) ?? null }
    const item = describe(e, base, amount, agentOp)
    if (item) items.push(item)
  }
  return { items, isLoading: events.isLoading, error: events.error }
}

function describe(
  e: IndexedEvent,
  base: Pick<ActivityItem, 'key' | 'txHash' | 'timestamp' | 'bucketId'>,
  amount: (token: unknown, value: unknown) => string,
  agentOp: string | null,
): ActivityItem | null {
  const a = e.args
  switch (e.eventName) {
    case 'ExecutionRecorded': {
      const r = a.receipt as Record<string, unknown>
      const kind = Number(r.kind)
      const operator = String(r.operator ?? '')
      const byAgent = !!agentOp && !!operator && isAddressEqual(operator as Address, agentOp as Address)
      const isPay = kind === 3
      return {
        ...base,
        categories: [isPay ? 'payments' : 'swaps', ...(byAgent ? (['agent'] as const) : [])],
        icon: byAgent ? <Bot className="h-4 w-4" /> : isPay ? <CreditCard className="h-4 w-4" /> : <Repeat className="h-4 w-4" />,
        title: byAgent ? `Agent execution · ${EXECUTION_KIND[kind] ?? 'Execution'}` : (EXECUTION_KIND[kind] ?? 'Execution'),
        body: isPay ? (
          <span>
            {amount(r.tokenOut, r.amountOut)} <ArrowRight className="inline h-3 w-3" /> <span className="font-mono text-xs">{shortAddr(String(r.recipient))}</span>
          </span>
        ) : (
          <span>
            {amount(r.tokenOut, r.amountOut)} <ArrowRight className="inline h-3 w-3" /> {amount(r.tokenIn, r.amountIn)}
          </span>
        ),
        who: operator,
      }
    }
    case 'BucketCreated':
      return { ...base, categories: ['buckets'], icon: <FilePlus2 className="h-4 w-4" />, title: 'Bucket created', body: <span>{String(a.label)}</span>, who: String(a.holder) }
    case 'CapabilityIssued': {
      const perms = Number(a.permissions)
      const what = [hasPermissions(perms, Permission.Swap) && 'Swap', hasPermissions(perms, Permission.Rebalance) && 'Rebalance', hasPermissions(perms, Permission.Pay) && 'Pay']
        .filter(Boolean)
        .join(' · ')
      return {
        ...base,
        categories: ['capabilities'],
        icon: <KeyRound className="h-4 w-4" />,
        title: a.parentId && !/^0x0+$/.test(String(a.parentId)) ? 'Capability delegated' : 'Capability granted',
        body: <span>{what || 'Permission'} → {String(a.operatorLabel)}</span>,
        who: String(a.operator),
      }
    }
    case 'CapabilityRevoked':
      return { ...base, categories: ['revocations', 'capabilities'], icon: <Ban className="h-4 w-4" />, title: 'Capability revoked', body: <span className="font-mono text-xs">{shortAddr(String(a.capabilityId), 10, 6)}</span>, who: String(a.by) }
    case 'CapabilityEpochAdvanced':
      return { ...base, categories: ['revocations'], icon: <ShieldAlert className="h-4 w-4" />, title: 'All authority revoked (kill switch)', body: <span>epoch {String(a.epoch)}</span>, who: String(a.by) }
    case 'CapabilityExhausted':
      return { ...base, categories: ['capabilities'], icon: <CheckCircle2 className="h-4 w-4" />, title: 'Capability used up', body: <span>{String(a.executions)} executions</span>, who: null }
    case 'BucketPolicyUpdated':
      return { ...base, categories: ['buckets'], icon: <Settings2 className="h-4 w-4" />, title: 'Policy updated', body: <span>version {String(a.policyVersion)}</span>, who: null }
    case 'BucketStatusUpdated':
      return { ...base, categories: ['buckets'], icon: <Settings2 className="h-4 w-4" />, title: Number(a.status) === 2 ? 'Bucket paused' : Number(a.status) === 1 ? 'Bucket resumed' : 'Bucket closed', body: null, who: String(a.by) }
    case 'GuardianAuthorized':
    case 'GuardianRevoked':
      return { ...base, categories: ['capabilities'], icon: <ShieldAlert className="h-4 w-4" />, title: e.eventName === 'GuardianAuthorized' ? 'Guardian added' : 'Guardian removed', body: null, who: String(a.guardian ?? '') }
    default:
      return null
  }
}

export function ActivityRow({ item, bucketLabel }: { item: ActivityItem; bucketLabel: string | null }) {
  const { deployment } = useApp()
  const explorer = deployment.evm.explorer ?? 'https://sepolia.etherscan.io'
  return (
    <div className="flex items-start gap-3 border-t border-line px-5 py-3.5 first:border-t-0">
      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-panel-3 text-muted">{item.icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="truncate text-sm font-medium">{item.title}</div>
          <div className="shrink-0 text-xs text-faint">{timeAgo(item.timestamp)}</div>
        </div>
        {item.body ? <div className="mt-0.5 text-sm tabular text-fg">{item.body}</div> : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {item.who ? <span className="font-mono">{shortAddr(item.who)}</span> : null}
          {bucketLabel ? <span>{bucketLabel}</span> : null}
          <span>Sepolia</span>
          <TxLink href={`${explorer}/tx/${item.txHash}`} />
        </div>
      </div>
    </div>
  )
}

export function RecentActivity({ limit = 5 }: { limit?: number }) {
  const { items, isLoading } = useActivityItems()
  const { buckets } = useKnownBuckets()
  const label = (id: string | null) => buckets.find((b) => b.bucketId === id)?.label ?? null
  return (
    <Card>
      <CardHeader title="Recent activity" action={<Link to="/activity" className="text-xs text-brand">All activity</Link>} />
      <div className="mt-3 pb-1">
        {isLoading ? (
          <div className="space-y-2 px-5 pb-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : items.length === 0 ? (
          <div className="px-5 pb-5 text-sm text-muted">No protocol activity yet.</div>
        ) : (
          items.slice(0, limit).map((i) => <ActivityRow key={i.key} item={i} bucketLabel={label(i.bucketId)} />)
        )}
      </div>
    </Card>
  )
}
