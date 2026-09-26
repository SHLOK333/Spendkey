import { formatUsd } from '@bucket/protocol-types'
import { useCurrentAccount } from '@mysten/dapp-kit-react'
import { Link } from 'react-router-dom'
import { isAddressEqual } from 'viem'

import { capabilityState } from '@/components/capability-card'
import { Button } from '@/components/ui/button'
import { PageHero, TableRow, TableShell, TokenGlyph } from '@/components/ui/data-table'
import { DoodleEmpty, DoodleWallet } from '@/components/ui/doodles'
import { EmptyState, Skeleton } from '@/components/ui/primitives'
import { useApp, useOwnerWallet } from '@/lib/client/app'
import { useCapabilities, useKnownBuckets, useSuiBalance, useSuiBucket, useWalletAssets } from '@/lib/client/queries'
import { tokenAmount } from '@/lib/utils'

function EvmPortfolio() {
  const { address } = useOwnerWallet()
  const { buckets } = useKnownBuckets()
  const mine = address ? buckets.filter((b) => isAddressEqual(b.holder, address)) : []
  const wallet = useWalletAssets(address)
  const caps = useCapabilities(mine[0]?.bucketId ?? null)
  if (!address)
    return (
      <EmptyState icon={<DoodleWallet width={96} height={96} />} title="Connect your wallet">
        Your portfolio is your wallet. Connect it to see balances and the authority you have delegated.
      </EmptyState>
    )
  if (wallet.isLoading) return <Skeleton className="h-96 rounded-2xl" />
  const assets = (wallet.data ?? []).filter((a) => a.balance > 0n)
  const total = (wallet.data ?? []).reduce((s, a) => s + a.valueWad, 0n)
  const live = (caps.data ?? []).filter((r) => capabilityState(r).active)
  const delegated = live.reduce((s, r) => s + r.capability.limits.maxDailyValue, 0n)
  const operators = new Set(live.map((r) => r.capability.operator.toLowerCase()))
  const pct = (v: bigint) => (total > 0n ? `${((Number(v) / Number(total)) * 100).toFixed(1)}%` : '—')

  return (
    <div className="space-y-8">
      <PageHero
        title="Portfolio"
        subtitle="Everything is held in your own wallet — BUCKET never takes custody. Priced by BUCKET's reference feed on Sepolia (test tokens)."
        art={<DoodleWallet width={132} height={132} />}
        stats={[
          { label: 'Total wallet value', value: formatUsd(total) },
          { label: 'Delegated / day', value: formatUsd(delegated) },
        ]}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: 'Active Buckets', value: String(mine.length), note: 'ENSv2-bound permissions' },
          { label: 'Active Agents', value: String(operators.size), note: `${live.length} live capabilit${live.length === 1 ? 'y' : 'ies'}` },
          { label: 'Delegated authority', value: formatUsd(delegated), note: 'Daily limits — not funds. Nothing leaves your wallet.' },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-line bg-panel p-5">
            <div className="text-xs text-muted">{s.label}</div>
            <div className="mt-1 text-2xl font-semibold tabular">{s.value}</div>
            <div className="mt-1 text-xs text-faint">{s.note}</div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="text-sm font-semibold">Wallet assets</div>
        {assets.length === 0 ? (
          <EmptyState icon={<DoodleEmpty width={88} height={88} />} title="No test-token balances">
            Fund this wallet with Sepolia test tokens to see holdings here.
          </EmptyState>
        ) : (
          <TableShell
            header={
              <>
                <div>Asset</div>
                <div>Balance</div>
                <div>Value</div>
                <div>Allocation</div>
                <div />
              </>
            }
          >
            {assets.map((a) => (
              <TableRow
                key={a.symbol}
                chevron={false}
                leading={
                  <div className="flex items-center gap-3">
                    <TokenGlyph symbol={a.symbol} />
                    <div>
                      <div className="font-semibold text-fg">{a.symbol}</div>
                      <div className="text-xs text-muted">Sepolia</div>
                    </div>
                  </div>
                }
                cells={[
                  { label: 'Balance', value: tokenAmount(a.balance, a.decimals, 4) },
                  { label: 'Value', value: <span className="text-fg">{formatUsd(a.valueWad)}</span> },
                  { label: 'Allocation', value: <span className="text-accent">{pct(a.valueWad)}</span> },
                ]}
              />
            ))}
          </TableShell>
        )}
      </div>
    </div>
  )
}

function SuiPortfolio() {
  const { deployment } = useApp()
  const account = useCurrentAccount()
  const balance = useSuiBalance(account?.address ?? null)
  const sb = deployment.suiBuckets[0]
  const bucket = useSuiBucket(sb?.objectId ?? null)
  const live = (bucket.data?.capabilities ?? []).filter((c) => c.status === 1 && Number(c.validUntil) * 1000 > Date.now())
  const rows = [
    { symbol: 'SUI', label: 'Wallet SUI', value: account ? (balance.data !== undefined ? tokenAmount(balance.data, 9, 4) : '…') : 'Connect wallet', note: 'In your wallet' },
    { symbol: 'SUI', label: 'Bucket vault', value: bucket.data ? tokenAmount(bucket.data.vaultSui, 9, 4) : '…', note: 'Move vault — only your OwnerCap can withdraw' },
  ]
  return (
    <div className="space-y-8">
      <PageHero
        title="Portfolio"
        subtitle="Your SUI stays with you. The Bucket vault is a Move object only your OwnerCap can withdraw."
        art={<DoodleWallet width={132} height={132} />}
        stats={[
          { label: 'Buckets', value: String(deployment.suiBuckets.length) },
          { label: 'Active agents', value: String(new Set(live.filter((c) => c.hasRolePay).map((c) => c.operator)).size) },
        ]}
      />
      <TableShell>
        {rows.map((r) => (
          <TableRow
            key={r.label}
            chevron={false}
            leading={
              <div className="flex items-center gap-3">
                <TokenGlyph symbol={r.symbol} />
                <div>
                  <div className="font-semibold text-fg">{r.label}</div>
                  <div className="text-xs text-muted">{r.note}</div>
                </div>
              </div>
            }
            cells={[{ label: 'Amount', value: <span className="text-fg">{r.value} SUI</span> }]}
          />
        ))}
      </TableShell>
      <div className="flex gap-3">
        <Button asChild variant="primary">
          <Link to="/pay">Pay</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/buckets/new">Delegate</Link>
        </Button>
      </div>
    </div>
  )
}

export default function PortfolioPage() {
  const { network } = useApp()
  return <div className="mx-auto max-w-5xl">{network === 'sui' ? <SuiPortfolio /> : <EvmPortfolio />}</div>
}
