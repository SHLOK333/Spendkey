import { formatUsd } from '@bucket/protocol-types'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, Bot, ChevronDown, Info, User } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { formatUnits, isAddressEqual, parseUnits, type Address } from 'viem'

import { ActionFlow } from '@/components/execution'
import { DelegatedAuthority, SelfCustodyPanel } from '@/components/self-custody'
import { Button } from '@/components/ui/button'
import { TokenGlyph } from '@/components/ui/data-table'
import { Dialog } from '@/components/ui/dialog'
import { EmptyState, Row, Segmented, Skeleton, Spinner } from '@/components/ui/primitives'
import { RecentActivity } from '@/components/activity'
import type { AgentAction } from '@/lib/agent/schema'
import { useApp, useOwnerWallet } from '@/lib/client/app'
import { useSelectedBucket } from '@/lib/client/bucket-selection'
import { useBucketView, useWalletAssets } from '@/lib/client/queries'
import { explainError } from '@/lib/errors'
import { relativeExpiry, tokenAmount } from '@/lib/utils'
import { cn } from '@/lib/utils'

function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function TokenPill({ value, options, onChange }: { value: string; options: string[]; onChange: (s: string) => void }) {
  return (
    <div className="relative shrink-0">
      <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2">
        <TokenGlyph symbol={value} size={26} />
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-full border border-white/10 bg-white/[0.07] py-2 pl-10 pr-9 text-base font-bold text-fg outline-none cursor-pointer hover:bg-white/[0.12] transition-colors"
      >
        {options.map((o) => (
          <option key={o} value={o} style={{ background: '#16171d' }}>
            {o}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    </div>
  )
}

function SuiTradeNotice() {
  return (
    <EmptyState title="Swaps run on Ethereum Sepolia" action={<Button asChild variant="primary"><Link to="/pay">Go to Payments</Link></Button>}>
      The Sui BUCKET layer handles payments and delegation — swaps route through Ethereum Sepolia.
    </EmptyState>
  )
}

export default function TradePage() {
  const { network, bucket, deployment } = useApp()
  const { address } = useOwnerWallet()
  const sel = useSelectedBucket()
  const view = useBucketView(sel.bucketId)
  const wallet = useWalletAssets((sel.holder as Address) ?? address)
  const [mode, setMode] = useState<'agent' | 'me'>('agent')
  const [capId, setCapId] = useState<string>('')
  const [sell, setSell] = useState('USDC')
  const [buy, setBuy] = useState('ETH')
  const [amount, setAmount] = useState('180')
  const [review, setReview] = useState<AgentAction | null>(null)

  const symbols = useMemo(
    () =>
      (view.data?.snapshot.assets ?? [])
        .map((a) => deployment.evm.tokens.find((t) => isAddressEqual(t.address, a.token))?.symbol)
        .filter((s): s is string => !!s),
    [view.data, deployment],
  )
  const cap = sel.swapCaps.find((c) => c.id === capId) ?? sel.swapCaps[0] ?? null
  const sellToken = deployment.evm.tokens.find((t) => t.symbol === sell)
  const buyToken = deployment.evm.tokens.find((t) => t.symbol === buy)
  const debounced = useDebounced(amount)
  const amountOut = useMemo(() => {
    try {
      return sellToken && Number(debounced) > 0 ? parseUnits(debounced, sellToken.decimals) : 0n
    } catch {
      return 0n
    }
  }, [debounced, sellToken])

  const quote = useQuery({
    queryKey: ['swap-preview', sel.bucketId, cap?.id, sell, buy, amountOut.toString()],
    enabled: !!sel.bucketId && !!cap && !!sellToken && !!buyToken && amountOut > 0n && sell !== buy,
    refetchInterval: 20_000,
    queryFn: () => bucket.previewSwap({ bucketId: sel.bucketId!, capabilityId: cap!.id, tokenOut: sellToken!.address, tokenIn: buyToken!.address, amountOut }),
  })

  if (network === 'sui') return <SuiTradeNotice />

  const sellBalance = wallet.data?.find((w) => w.symbol === sell)
  const buyBalance = wallet.data?.find((w) => w.symbol === buy)
  const fill = quote.data?.fill
  const rate =
    fill && fill.amountOut > 0n && sellToken && buyToken
      ? Number(formatUnits(fill.amountIn, buyToken.decimals)) / Number(formatUnits(fill.amountOut, sellToken.decimals))
      : null
  const blocked = fill && !fill.ok ? explainError(fill.failure) : null

  const action: AgentAction | null =
    sel.bucketId && cap && Number(amount) > 0 && sell !== buy
      ? { action: 'swap', network: 'sepolia', bucketId: sel.bucketId, capabilityId: cap.id, sellSymbol: sell, buySymbol: buy, sellAmount: amount }
      : null

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,480px)_1fr] lg:justify-center">
      {/* ── Left: Swap form ── */}
      <div>
        {/* Mode toggle */}
        <div className="mb-4 flex items-center justify-between">
          <span className="text-lg font-semibold">Swap</span>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'me', label: <span className="inline-flex items-center gap-1.5"><User className="h-3.5 w-3.5" /> Me</span> },
              { value: 'agent', label: <span className="inline-flex items-center gap-1.5"><Bot className="h-3.5 w-3.5" /> Agent</span> },
            ]}
          />
        </div>

        {mode === 'me' ? (
          <div className="rounded-3xl border border-line bg-panel p-6 text-sm text-muted">
            <div className="mb-2 font-semibold text-fg">Direct swaps aren&apos;t a BUCKET operation</div>
            A Bucket grants execution to an <span className="text-fg">operator</span> — the owner can&apos;t be their own operator.
            To trade under limits you control, use{' '}
            <button className="text-accent underline cursor-pointer" onClick={() => setMode('agent')}>Agent mode</button>.
            <div className="mt-4 rounded-xl border border-line bg-panel-2 p-3 font-mono text-xs text-faint">
              Agent → BUCKET policy → SwapVM (0xd0–0xd3) → your wallet
            </div>
          </div>
        ) : sel.isLoading || view.isLoading ? (
          <Skeleton className="h-80 rounded-3xl" />
        ) : !sel.bucketId ? (
          <EmptyState title="No Bucket yet">Create a Bucket to start trading.</EmptyState>
        ) : sel.swapCaps.length === 0 ? (
          <div className="rounded-3xl border border-line bg-panel p-6 text-sm">
            <div className="font-semibold">No trading authority</div>
            <div className="mt-1 text-muted">Grant a Swap capability with the limits you want. Funds stay in your wallet.</div>
            <Button asChild variant="primary" className="mt-4">
              <Link to="/buckets/new?purpose=trading">Grant authority</Link>
            </Button>
          </div>
        ) : (
          <div className="rounded-3xl border border-line bg-panel p-2">
            {/* Sell box */}
            <div className="rounded-2xl bg-panel-2 p-5">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-sm font-medium text-muted">Sell</span>
                {sellBalance ? (
                  <button
                    className="text-xs text-muted hover:text-fg transition-colors cursor-pointer"
                    onClick={() => setAmount(formatUnits(sellBalance.balance, sellBalance.decimals))}
                  >
                    Balance: {tokenAmount(sellBalance.balance, sellBalance.decimals, 4)} · <span className="text-accent">Max</span>
                  </button>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                  inputMode="decimal"
                  placeholder="0"
                  className="min-w-0 flex-1 bg-transparent text-5xl font-bold tabular outline-none placeholder:text-faint/40 text-fg"
                />
                <TokenPill value={sell} options={symbols} onChange={(v) => { setSell(v); if (v === buy) setBuy(sell) }} />
              </div>
              <div className="mt-3 text-sm text-muted">
                {fill ? formatUsd(fill.valueOut) : amount && Number(amount) > 0 ? <span className="text-faint/60">—</span> : null}
              </div>
            </div>

            {/* Swap direction button */}
            <div className="relative z-10 -my-4 flex justify-center">
              <button
                onClick={() => { const tmp = sell; setSell(buy); setBuy(tmp) }}
                className="grid h-12 w-12 place-items-center rounded-2xl border-4 border-panel bg-panel-3 text-muted hover:text-fg hover:bg-panel-2 transition-colors cursor-pointer"
                aria-label="Flip tokens"
              >
                <ArrowDown className="h-5 w-5" />
              </button>
            </div>

            {/* Buy box */}
            <div className="rounded-2xl bg-panel-2 p-5">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-sm font-medium text-muted">Buy</span>
                {buyBalance ? (
                  <span className="text-xs text-muted">Balance: {tokenAmount(buyBalance.balance, buyBalance.decimals, 4)}</span>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1 text-5xl font-bold tabular text-muted">
                  {quote.isFetching && !fill ? (
                    <Spinner className="h-7 w-7 mt-1" />
                  ) : fill && buyToken ? (
                    <span className="text-fg">{tokenAmount(fill.amountIn, buyToken.decimals, 6)}</span>
                  ) : (
                    <span className="text-faint/40">0</span>
                  )}
                </div>
                <TokenPill value={buy} options={symbols} onChange={(v) => { setBuy(v); if (v === sell) setSell(buy) }} />
              </div>
              <div className="mt-3 text-sm text-muted">
                {fill && buyToken ? formatUsd(fill.valueOut) : null}
              </div>
            </div>

            {/* Rate + route info */}
            {(rate ?? blocked) ? (
              <div className="mt-1 px-1 py-2">
                {blocked ? (
                  <div className="flex items-center gap-2 rounded-xl border border-danger/20 bg-danger/5 px-3 py-2.5 text-sm">
                    <Info className="h-4 w-4 shrink-0 text-danger" />
                    <span className="font-medium text-danger">{blocked.title}</span>
                    <span className="text-muted">{blocked.message}</span>
                  </div>
                ) : rate ? (
                  <div className="flex items-center justify-between px-2 py-1 text-xs text-muted">
                    <span>1 {sell} = {rate.toPrecision(5)} {buy}</span>
                    <span className="flex items-center gap-1 text-faint">
                      Aqua / SwapVM · BUCKET 0xd0–0xd3
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* CTA */}
            <Button
              variant="primary"
              className={cn(
                'mt-1 w-full rounded-2xl text-base font-bold',
                'h-14 text-[15px]',
                !action && 'opacity-60',
              )}
              disabled={!action}
              onClick={() => setReview(action)}
            >
              {!sel.bucketId ? 'Select a Bucket' : !amount || Number(amount) === 0 ? 'Enter an amount' : sell === buy ? 'Select different tokens' : 'Review Swap'}
            </Button>

            {!sel.isOwner ? (
              <p className="mt-2 text-center text-xs text-warn px-2 pb-1">
                Connect the wallet that owns this Bucket to approve swaps.
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* ── Right: Authority + activity ── */}
      <div className="space-y-4">
        <SelfCustodyPanel network="sepolia">
          <div className="mb-3">
            <div className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Wallet balance</div>
            {(wallet.data ?? []).filter((w) => symbols.includes(w.symbol)).map((w) => (
              <Row key={w.symbol} label={w.symbol}>
                {tokenAmount(w.balance, w.decimals, 4)} <span className="text-xs text-muted">({formatUsd(w.valueWad)})</span>
              </Row>
            ))}
          </div>
          {cap ? (
            <DelegatedAuthority
              network="sepolia"
              operatorName={`${cap.capability.operatorLabel}.${view.data?.ensName ?? ''}`}
              operatorAddress={cap.capability.operator}
              perExecution={formatUsd(cap.capability.limits.maxExecutionValue)}
              perDay={formatUsd(cap.capability.limits.maxDailyValue)}
              expires={relativeExpiry(cap.capability.validUntil)}
            />
          ) : null}
        </SelfCustodyPanel>
        <RecentActivity limit={4} />
      </div>

      <Dialog open={!!review} onOpenChange={(o) => !o && setReview(null)} title="Review swap" description="Checked against your Bucket's live on-chain authority.">
        {review ? <ActionFlow action={review} onClose={() => setReview(null)} /> : null}
      </Dialog>
    </div>
  )
}
