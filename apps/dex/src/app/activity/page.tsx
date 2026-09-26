import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { ActivityRow, useActivityItems, type ActivityCategory } from '@/components/activity'
import { FilterBar, PageHero } from '@/components/ui/data-table'
import { DoodleEmpty, DoodlePulse } from '@/components/ui/doodles'
import { Card, EmptyState, Skeleton } from '@/components/ui/primitives'
import { useApp } from '@/lib/client/app'
import { useKnownBuckets } from '@/lib/client/queries'

const FILTERS: Array<{ value: 'all' | ActivityCategory; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'swaps', label: 'Swaps' },
  { value: 'payments', label: 'Payments' },
  { value: 'agent', label: 'Agent executions' },
  { value: 'buckets', label: 'Buckets' },
  { value: 'capabilities', label: 'Capability changes' },
  { value: 'revocations', label: 'Revocations' },
]

export default function ActivityPage() {
  const { network, deployment } = useApp()
  const { items, isLoading, error } = useActivityItems()
  const { buckets } = useKnownBuckets()
  const [filter, setFilter] = useState<'all' | ActivityCategory>('all')
  const label = (id: string | null) => buckets.find((b) => b.bucketId === id)?.label ?? null
  const shown = filter === 'all' ? items : items.filter((i) => i.categories.includes(filter))

  if (network === 'sui') {
    const sb = deployment.suiBuckets[0]
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={<DoodlePulse width={96} height={96} />}
          title="Sui activity lives on the Bucket object"
          action={
            sb ? (
              <a className="inline-flex items-center gap-1 text-sm text-brand" href={`${deployment.sui?.explorer}/object/${sb.objectId}`} target="_blank" rel="noreferrer">
                Open {sb.name} on Suiscan <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null
          }
        >
          Every Sui payment, grant and revocation mutates the shared Bucket object; its transaction history is the Sui activity feed. Executions you run here link directly to their Move transaction.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHero
        title="Activity"
        subtitle="Every swap, payment, grant and revocation — read straight from BucketController, BucketCapabilities and BucketAuthority events on Sepolia."
        art={<DoodlePulse width={132} height={132} />}
        stats={[{ label: 'Events', value: isLoading ? '…' : String(items.length) }]}
      />

      <FilterBar value={filter} onChange={(v) => setFilter(v as 'all' | ActivityCategory)} options={FILTERS} />

      {error ? <div className="text-sm text-danger">Could not load activity: {String(error instanceof Error ? error.message : error)}</div> : null}
      <Card>
        {isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <div className="text-xs text-muted">Indexing protocol events from Sepolia…</div>
          </div>
        ) : shown.length === 0 ? (
          <div className="p-8">
            <EmptyState icon={<DoodleEmpty width={80} height={80} />} title={filter === 'all' ? 'Nothing here yet' : 'No matching activity'}>
              {filter === 'all' ? 'Run a swap or payment, or grant a capability — it will show up here.' : 'No events match this filter yet.'}
            </EmptyState>
          </div>
        ) : (
          shown.map((i) => <ActivityRow key={i.key} item={i} bucketLabel={label(i.bucketId)} />)
        )}
      </Card>
    </div>
  )
}
