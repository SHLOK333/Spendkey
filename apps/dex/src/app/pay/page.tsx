import { formatUsd } from '@bucket/protocol-types'
import { useQuery } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useState } from 'react'
import { isAddressEqual } from 'viem'

import { ActionFlow } from '@/components/execution'
import { DelegatedAuthority, SelfCustodyPanel } from '@/components/self-custody'
import { Button } from '@/components/ui/button'
import { PageHero } from '@/components/ui/data-table'
import { Dialog } from '@/components/ui/dialog'
import { DoodleSend } from '@/components/ui/doodles'
import { Card, EmptyState, Identity, Input, Label, Row, Skeleton, Spinner } from '@/components/ui/primitives'
import type { AgentAction } from '@/lib/agent/schema'
import { useApp } from '@/lib/client/app'
import { useSelectedBucket } from '@/lib/client/bucket-selection'
import { useAgentStatus, useBucketView, useWalletAssets } from '@/lib/client/queries'
import { relativeExpiry, shortAddr, tokenAmount } from '@/lib/utils'

function EvmPay() {
  const { deployment } = useApp()
  const sel = useSelectedBucket()
  const view = useBucketView(sel.bucketId)
  const wallet = useWalletAssets(sel.holder)
  const [amount, setAmount] = useState('25')
  const [review, setReview] = useState<AgentAction | null>(null)
  if (sel.isLoading || view.isLoading) return <Skeleton className="h-96" />
  if (!sel.bucketId) return <EmptyState title="No Bucket yet" />
  const cap = sel.payCaps[0]
  if (!cap) {
    return (
      <EmptyState title="No payment authority" action={sel.isOwner ? <Button asChild variant="primary"><Link to="/buckets/new?purpose=payments">Create a Payments permission</Link></Button> : null}>
        The agent has no PAY capability on this Bucket.
      </EmptyState>
    )
  }
  const assets = view.data?.snapshot.assets ?? []
  const i = assets.findIndex((_, idx) => (cap.capability.assetMask & (1 << idx)) !== 0)
  const token = deployment.evm.tokens.find((t) => assets[i] && isAddressEqual(t.address, assets[i].token))
  const bal = wallet.data?.find((w) => w.symbol === token?.symbol)
  const remaining = cap.limits ? [cap.limits.remainingDailyValue, cap.limits.remainingHourlyValue].reduce((a, b) => (a < b ? a : b)) : null
  const operatorName = `${cap.capability.operatorLabel}.${view.data?.ensName ?? ''}`
  return (
    <div className="space-y-8">
      <PageHero
        title="Pay"
        subtitle="Payments run under a fixed-payee capability — the operator can only send to the address you locked in, within your daily and per-payment limits. Funds move straight from your wallet."
        art={<DoodleSend width={132} height={132} />}
        stats={[
          { label: 'Per payment', value: formatUsd(cap.capability.limits.maxExecutionValue) },
          { label: 'Remaining now', value: remaining !== null ? formatUsd(remaining) : '—' },
        ]}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,480px)_1fr] lg:justify-center">
      <Card className="p-5">
        <div className="mb-4 text-base font-semibold">Send Payment</div>
        <Label>From</Label>
        <div className="mb-4 rounded-xl bg-panel-2 px-4 py-3">
          <Identity name={`${view.data?.ensName ?? ''} (your wallet)`} address={sel.holder} />
        </div>
        <Label hint="fixed by the capability">To</Label>
        <div className="mb-4 rounded-xl bg-panel-2 px-4 py-3 font-mono text-sm">{cap.capability.payee}</div>
        <Label hint={bal ? `wallet: ${tokenAmount(bal.balance, bal.decimals, 4)} ${bal.symbol}` : undefined}>Amount</Label>
        <div className="mb-4 flex items-center gap-2 rounded-xl bg-panel-2 px-4">
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} className="h-14 flex-1 bg-transparent text-3xl font-semibold tabular outline-none" />
          <span className="font-semibold text-muted">{token?.symbol}</span>
        </div>
        <Row label="Execute using">
          <span className="font-medium">Payments Agent</span> <span className="text-xs text-muted">{operatorName}</span>
        </Row>
        <Row label="Bucket limit">{formatUsd(cap.capability.limits.maxExecutionValue)} / payment</Row>
        <Row label="Remaining now">{remaining !== null ? formatUsd(remaining) : '—'}</Row>
        <Button
          variant="primary"
          size="lg"
          className="mt-4 w-full"
          disabled={!token || !(Number(amount) > 0)}
          onClick={() => token && setReview({ action: 'pay', network: 'sepolia', bucketId: sel.bucketId!, capabilityId: cap.id, symbol: token.symbol, amount })}
        >
          Review Payment
        </Button>
      </Card>
      <SelfCustodyPanel>
        <DelegatedAuthority
          operatorName={operatorName}
          operatorAddress={cap.capability.operator}
          perExecution={formatUsd(cap.capability.limits.maxExecutionValue)}
          perDay={formatUsd(cap.capability.limits.maxDailyValue)}
          expires={relativeExpiry(cap.capability.validUntil)}
        />
      </SelfCustodyPanel>
      <Dialog open={!!review} onOpenChange={(o) => !o && setReview(null)} title="Review payment">
        {review ? <ActionFlow action={review} onClose={() => setReview(null)} /> : null}
      </Dialog>
      </div>
    </div>
  )
}


export default function PayPage() {
  return <EvmPay />
}
