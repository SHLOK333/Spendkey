import { BucketStatus, Permission, formatUsd, hasPermissions } from '@bucket/protocol-types'
import { Bot, KeyRound, Lock, Plus, ShieldAlert, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useMemo, useState } from 'react'
import { erc20Abi, isAddressEqual, maxUint256, type Address, type Hex } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import { useReadContracts } from 'wagmi'

import { capabilityState, capabilityTitle } from '@/components/capability-card'
import { ConfirmTx, type TxOutcome } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { FilterBar, PageHero, SectionHeader, TableRow, TableShell } from '@/components/ui/data-table'
import { Dialog } from '@/components/ui/dialog'
import { DoodleEmpty, DoodleVault } from '@/components/ui/doodles'
import { Badge, Card, CardHeader, EmptyState, Identity, Mono, Row, Skeleton, StatusDot } from '@/components/ui/primitives'
import { useApp, useOwnerWallet } from '@/lib/client/app'
import { useBucketView, useCapabilities, useKnownBuckets, useSuiBucket, type CapabilityRow } from '@/lib/client/queries'
import { useSuiOwner } from '@/lib/client/sui'
import { dateLabel, relativeExpiry, shortAddr, tokenAmount } from '@/lib/utils'

function permissionLabels(permissions: number): string[] {
  return [
    hasPermissions(permissions, Permission.Swap) && 'Swap',
    hasPermissions(permissions, Permission.Rebalance) && 'Rebalance',
    hasPermissions(permissions, Permission.Pay) && 'Pay',
  ].filter((x): x is string => !!x)
}

function OperatorAvatar() {
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/12 text-accent">
      <Bot className="h-[18px] w-[18px]" />
    </span>
  )
}

function OwnershipExplainer({ network }: { network: 'sepolia' | 'sui' }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex items-start gap-3 rounded-xl border border-line bg-panel p-4">
        <Wallet className="mt-0.5 h-5 w-5 text-accent" />
        <div>
          <div className="text-sm font-semibold">Wallet = ownership</div>
          <div className="text-sm text-muted">{network === 'sui' ? 'Your keys and your OwnerCap. On Sui, payment funds sit in the Bucket vault only you can withdraw.' : 'Your assets and your keys. Nothing is deposited anywhere.'}</div>
        </div>
      </div>
      <div className="flex items-start gap-3 rounded-xl border border-line bg-panel p-4">
        <KeyRound className="mt-0.5 h-5 w-5 text-brand" />
        <div>
          <div className="text-sm font-semibold">Bucket = financial permission</div>
          <div className="text-sm text-muted">Who may act, on which assets, how much, until when. Revocable at any time.</div>
        </div>
      </div>
    </div>
  )
}

function useTxUrl() {
  const { deployment } = useApp()
  return (hash: string) => `${deployment.evm.explorer ?? 'https://sepolia.etherscan.io'}/tx/${hash}`
}

function ApprovalsCard({ bucketId, holder, isOwner }: { bucketId: Hex; holder: Address; isOwner: boolean }) {
  const { deployment, bucket } = useApp()
  const { wallet } = useOwnerWallet()
  const view = useBucketView(bucketId)
  const txUrl = useTxUrl()
  const qc = useQueryClient()
  const [revoke, setRevoke] = useState<{ token: Address; symbol: string; spender: Address; spenderName: string } | null>(null)
  const assets = view.data?.snapshot.assets ?? []
  const spenders = [
    { address: deployment.evm.contracts.aqua, name: 'Aqua (swaps)' },
    { address: deployment.evm.contracts.controller, name: 'BUCKET controller (payments)' },
  ]
  const calls = assets.flatMap((a) => spenders.map((s) => ({ address: a.token, abi: erc20Abi, functionName: 'allowance' as const, args: [holder, s.address] as const })))
  const allowances = useReadContracts({ contracts: calls, query: { enabled: calls.length > 0, refetchInterval: 20_000 } })
  const symbolOf = (t: string) => deployment.evm.tokens.find((x) => isAddressEqual(x.address, t as Address))?.symbol ?? shortAddr(t)
  return (
    <Card>
      <CardHeader title="Wallet approvals" subtitle="The only way BUCKET-routed execution can touch your tokens. Revoke to stop everything, instantly." />
      <div className="px-5 pb-4 pt-2">
        {assets.map((a, i) =>
          spenders.map((s, j) => {
            const res = allowances.data?.[i * spenders.length + j]
            const value = res?.status === 'success' ? (res.result as bigint) : null
            return (
              <div key={`${a.token}-${s.address}`} className="flex items-center justify-between gap-3 border-t border-line py-2 text-sm first:border-t-0">
                <div>
                  <span className="font-medium">{symbolOf(a.token)}</span> <span className="text-muted">→ {s.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular text-muted">{value === null ? '…' : value === 0n ? 'none' : value >= maxUint256 / 2n ? 'unlimited' : 'limited'}</span>
                  {isOwner && value ? (
                    <Button size="sm" variant="danger" onClick={() => setRevoke({ token: a.token, symbol: symbolOf(a.token), spender: s.address, spenderName: s.name })}>
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          }),
        )}
      </div>
      <ConfirmTx
        open={!!revoke}
        onOpenChange={(o) => !o && setRevoke(null)}
        title={`Revoke ${revoke?.symbol} approval`}
        confirmLabel="Revoke approval"
        destructive
        run={async (): Promise<TxOutcome[]> => {
          if (!wallet || !revoke) throw new Error('Connect the owner wallet')
          const r = await bucket.evm.write(wallet, { address: revoke.token, abi: erc20Abi, functionName: 'approve', args: [revoke.spender, 0n] })
          return [{ label: 'approve(0)', url: txUrl(r.transactionHash) }]
        }}
        onDone={() => void qc.invalidateQueries()}
      >
        {revoke?.spenderName} will no longer be able to move your {revoke?.symbol}. Every operator depending on it stops working until you approve
        again. Your tokens do not move.
      </ConfirmTx>
    </Card>
  )
}

function EvmBucket({ bucketId }: { bucketId: Hex }) {
  const { bucket, deployment } = useApp()
  const { address, wallet } = useOwnerWallet()
  const view = useBucketView(bucketId)
  const caps = useCapabilities(bucketId)
  const qc = useQueryClient()
  const txUrl = useTxUrl()
  const [revoke, setRevoke] = useState<CapabilityRow | null>(null)
  const [manage, setManage] = useState<CapabilityRow | null>(null)
  const [danger, setDanger] = useState<'pause' | 'resume' | 'killswitch' | null>(null)

  const [filter, setFilter] = useState('all')

  const v = view.data
  const rows = useMemo(() => caps.data ?? [], [caps.data])
  const active = useMemo(() => rows.filter((r) => capabilityState(r).active), [rows])
  const inactive = useMemo(() => rows.filter((r) => !capabilityState(r).active), [rows])
  const totalDaily = useMemo(() => active.reduce((s, r) => s + r.capability.limits.maxDailyValue, 0n), [active])

  if (view.isLoading) return <Skeleton className="h-64 rounded-2xl" />
  if (!v) return null
  const isOwner = !!address && isAddressEqual(address, v.snapshot.holder)
  const paused = v.snapshot.status === BucketStatus.Paused
  const shown = filter === 'active' ? active : filter === 'inactive' ? inactive : rows

  return (
    <div className="space-y-5 rounded-2xl border border-line bg-panel/40 p-5 md:p-6">
      <SectionHeader
        title={
          <span className="flex items-center gap-3">
            {v.ensName}
            <Badge tone={paused ? 'amber' : 'green'}>
              <StatusDot active={!paused} /> {paused ? 'Paused' : 'Active'}
            </Badge>
          </span>
        }
        subtitle={
          <>
            Owner <Identity className="inline-block align-middle" name={null} address={v.owner} /> · policy v{v.snapshot.policyVersion} · every limit
            enforced on-chain
          </>
        }
        stats={[
          { label: 'Active authority', value: String(active.length) },
          { label: 'Total / day', value: formatUsd(totalDaily) },
        ]}
      />

      {isOwner ? (
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="primary" size="sm">
            <Link to="/buckets/new">
              <Plus className="h-4 w-4" /> Grant permission
            </Link>
          </Button>
          {paused ? (
            <Button size="sm" onClick={() => setDanger('resume')}>
              Resume
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setDanger('pause')}>
              Pause Bucket
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={() => setDanger('killswitch')}>
            <ShieldAlert className="h-4 w-4" /> Revoke all
          </Button>
        </div>
      ) : (
        <Badge>Read-only — connect the owner wallet to manage</Badge>
      )}

      <div className="space-y-3">
        <FilterBar
          label="Permissions"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${rows.length}` },
            { value: 'active', label: `Active ${active.length}` },
            { value: 'inactive', label: `Inactive ${inactive.length}` },
          ]}
        />
        {caps.isLoading ? (
          <Skeleton className="h-48 rounded-2xl" />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<DoodleEmpty width={88} height={88} />}
            title="No permissions here"
            action={isOwner ? <Button asChild variant="primary"><Link to="/buckets/new">Grant permission</Link></Button> : null}
          >
            No operator can execute anything on this Bucket right now.
          </EmptyState>
        ) : (
          <TableShell>
            {shown.map((r) => {
              const c = r.capability
              const state = capabilityState(r)
              return (
                <TableRow
                  key={r.id}
                  chevron={false}
                  stacked
                  leading={
                    <div className="flex items-center gap-3">
                      <OperatorAvatar />
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-fg">{`${c.operatorLabel}.${v.ensName}`}</div>
                        <div className="flex items-center gap-1.5 text-xs text-muted">
                          <StatusDot active={state.active} /> {capabilityTitle(c.permissions)} · {state.label}
                        </div>
                      </div>
                    </div>
                  }
                  cells={[
                    {
                      label: 'Permissions',
                      value: (
                        <span className="flex flex-wrap gap-1">
                          {permissionLabels(c.permissions).map((p) => (
                            <Badge key={p}>{p}</Badge>
                          ))}
                        </span>
                      ),
                    },
                    {
                      label: 'Max / execution',
                      value: (
                        <span className="font-semibold text-accent underline decoration-accent/40 decoration-dotted underline-offset-4">
                          {formatUsd(c.limits.maxExecutionValue)}
                        </span>
                      ),
                    },
                    { label: 'Expires', value: state.label === 'Expired' ? 'expired' : relativeExpiry(c.validUntil) },
                  ]}
                  trailing={
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setManage(r)}>
                        Manage
                      </Button>
                      {isOwner && state.active ? (
                        <Button size="sm" variant="danger" onClick={() => setRevoke(r)}>
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  }
                />
              )
            })}
          </TableShell>
        )}
      </div>

      <ApprovalsCard bucketId={bucketId} holder={v.snapshot.holder} isOwner={isOwner} />

      <Dialog open={!!manage} onOpenChange={(o) => !o && setManage(null)} title="Capability details">
        {manage ? (
          <div className="text-sm">
            <Row label="Capability">
              <Mono>{shortAddr(manage.id, 10, 8)}</Mono>
            </Row>
            <Row label="Operator (ENSv2)">{`${manage.capability.operatorLabel}.${v.ensName}`}</Row>
            <Row label="Resolves to">
              <Mono>{manage.capability.operator}</Mono>
            </Row>
            <Row label="Valid from">{dateLabel(manage.capability.validAfter)}</Row>
            <Row label="Valid until">{dateLabel(manage.capability.validUntil)}</Row>
            <Row label="Max / execution">{formatUsd(manage.capability.limits.maxExecutionValue)}</Row>
            <Row label="Max / hour">{formatUsd(manage.capability.limits.maxHourlyValue)}</Row>
            <Row label="Max / day">{formatUsd(manage.capability.limits.maxDailyValue)}</Row>
            <Row label="Max slippage">{manage.capability.limits.maxSlippageBps / 100}%</Row>
            <Row label="Executions">{manage.capability.executions.toString()}{manage.capability.limits.maxExecutions ? ` / ${manage.capability.limits.maxExecutions}` : ''}</Row>
            <Row label="Policy version">{manage.capability.policyVersion}</Row>
            {manage.limits ? <Row label="Remaining today">{formatUsd(manage.limits.remainingDailyValue)}</Row> : null}
            <div className="mt-4 rounded-lg bg-panel-2 p-3 text-xs text-muted">
              ENSv2 identity → BUCKET authorization → financial constraints. If <span className="text-fg">{manage.capability.operatorLabel}.{v.ensName}</span> is
              transferred to another address, this capability stops working immediately. Limits cannot be edited in place: revoke and grant a new
              permission.
            </div>
          </div>
        ) : null}
      </Dialog>

      <ConfirmTx
        open={!!revoke}
        onOpenChange={(o) => !o && setRevoke(null)}
        title="Revoke this capability?"
        confirmLabel="Revoke"
        destructive
        run={async () => {
          if (!wallet || !revoke) throw new Error('Connect the owner wallet')
          const r = await bucket.evm.revokeCapability(wallet, revoke.id)
          return [{ label: 'revoke', url: txUrl(r.hash) }]
        }}
        onDone={() => void qc.invalidateQueries()}
      >
        <p>
          <span className="font-medium">{revoke ? `${revoke.capability.operatorLabel}.${v.ensName}` : ''}</span> will no longer be able to execute under this Bucket.
        </p>
        <p className="mt-2 text-accent">Your assets remain in your wallet.</p>
      </ConfirmTx>

      <ConfirmTx
        open={danger !== null}
        onOpenChange={(o) => !o && setDanger(null)}
        title={danger === 'killswitch' ? 'Revoke every permission?' : danger === 'pause' ? 'Pause this Bucket?' : 'Resume this Bucket?'}
        confirmLabel={danger === 'killswitch' ? 'Revoke all' : danger === 'pause' ? 'Pause' : 'Resume'}
        destructive={danger !== 'resume'}
        run={async () => {
          if (!wallet) throw new Error('Connect the owner wallet')
          const r =
            danger === 'killswitch'
              ? await bucket.evm.revokeAllCapabilities(wallet, bucketId)
              : danger === 'pause'
                ? await bucket.evm.pause(wallet, bucketId)
                : await bucket.evm.setStatus(wallet, bucketId, BucketStatus.Active)
          return [{ label: danger ?? 'tx', url: txUrl(r.hash) }]
        }}
        onDone={() => void qc.invalidateQueries()}
      >
        {danger === 'killswitch'
          ? 'Every capability on this Bucket — and everything delegated from them — stops working at once (epoch bump). Grant new ones afterwards.'
          : danger === 'pause'
            ? 'All execution stops and any open intent is closed. Capabilities stay issued; resume to re-enable them.'
            : 'Operators can execute again within their capabilities.'}
        <p className="mt-2 text-accent">Your assets remain in your wallet.</p>
      </ConfirmTx>
    </div>
  )
}

function SuiBuckets() {
  const { deployment } = useApp()
  const sb = deployment.suiBuckets[0]
  const data = useSuiBucket(sb?.objectId ?? null)
  const owner = useSuiOwner()
  const qc = useQueryClient()
  const [revoke, setRevoke] = useState<{ nonce: bigint; name: string; operator: string; hasRole: boolean } | null>(null)
  const suiTx = (d: string) => `${deployment.sui?.explorer ?? 'https://suiscan.xyz/testnet'}/tx/${d}`
  if (!sb || !deployment.sui) return <EmptyState title="No Sui Bucket in this deployment" />
  if (data.isLoading || !data.data) return <Skeleton className="h-64" />
  const { state, vaultSui, capabilities } = data.data
  const isOwner = !!owner.address && owner.address === state.owner
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="text-xl font-semibold">{state.name}</div>
              <Badge tone={state.status === 1 ? 'green' : 'amber'}>
                <StatusDot active={state.status === 1} /> {state.status === 1 ? 'Active' : 'Paused'}
              </Badge>
              <Badge tone="blue">Sui Testnet</Badge>
            </div>
            <div className="mt-1 text-sm text-muted">
              Owner <Mono>{shortAddr(state.owner)}</Mono> · policy v{state.policy.version}
            </div>
          </div>
          {isOwner ? (
            <Button asChild variant="primary" size="sm">
              <Link to="/buckets/new">
                <Plus className="h-4 w-4" /> Grant permission
              </Link>
            </Button>
          ) : (
            <Badge>Read-only — connect the owner&apos;s Sui wallet to manage</Badge>
          )}
        </div>
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-panel-2 p-4">
          <Lock className="mt-0.5 h-4 w-4 text-accent" />
          <div className="text-sm">
            <div className="font-medium">
              {tokenAmount(vaultSui, 9)} SUI in the Bucket&apos;s Move vault
            </div>
            <div className="text-muted">
              On Sui, payments draw from this vault. Only the owner&apos;s OwnerCap can withdraw it; operators can only pay their fixed payee within limits.
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {capabilities.map((c) => {
          const expired = Number(c.validUntil) * 1000 < Date.now()
          const active = c.status === 1 && !expired && c.epoch === state.capabilityEpoch && c.policyVersion === state.policy.version
          return (
            <Card key={c.nonce.toString()} className="flex flex-col p-5">
              <div className="flex items-start justify-between">
                <div className="text-base font-semibold">Payments Agent</div>
                <Badge tone={active ? 'green' : 'red'}>
                  <StatusDot active={active} /> {c.status === 2 ? 'Revoked' : expired ? 'Expired' : active ? 'Active' : 'Superseded'}
                </Badge>
              </div>
              <div className="mt-4">
                <div className="text-xs text-muted">Operator (SuiNS identity)</div>
                <Identity name={c.operatorName} address={c.operator} />
              </div>
              <div className="mt-3 border-t border-line pt-2">
                <Row label="EAC ROLE_PAY">{c.hasRolePay ? <Badge tone="green">granted</Badge> : <Badge tone="red">not granted</Badge>}</Row>
                <Row label="Max / payment">{tokenAmount(c.limits.maxPerTx, 9)} SUI</Row>
                <Row label="Max / day">{tokenAmount(c.limits.maxDailySpend, 9)} SUI</Row>
                <Row label="Fixed payee">
                  <Mono>{shortAddr(c.payee)}</Mono>
                </Row>
                <Row label="Expires">{expired ? 'expired' : relativeExpiry(c.validUntil)}</Row>
              </div>
              {isOwner && (active || c.hasRolePay) ? (
                <Button size="sm" variant="danger" className="mt-4" onClick={() => setRevoke({ nonce: c.nonce, name: c.operatorName, operator: c.operator, hasRole: c.hasRolePay })}>
                  Revoke authority
                </Button>
              ) : null}
            </Card>
          )
        })}
      </div>

      <ConfirmTx
        open={!!revoke}
        onOpenChange={(o) => !o && setRevoke(null)}
        title="Revoke this capability?"
        confirmLabel="Revoke"
        destructive
        run={async () => {
          if (!owner.client || !revoke || !deployment.sui?.accessControlId) throw new Error('Connect the owner Sui wallet')
          const out: TxOutcome[] = []
          const r1 = await owner.client.revokeCapability({ packageId: deployment.sui.packageId, bucketObjectId: sb.objectId, nonce: revoke.nonce })
          out.push({ label: 'revoke_capability', url: suiTx(r1.digest) })
          if (revoke.hasRole) {
            const r2 = await owner.client.ownerRevokeRoles({
              packageId: deployment.sui.packageId,
              accessControlId: deployment.sui.accessControlId,
              bucketObjectId: sb.objectId,
              ownerCapId: sb.ownerCapId,
              roleBitmap: 0x10n,
              principal: revoke.operator,
            })
            out.push({ label: 'owner_revoke_roles', url: suiTx(r2.digest) })
          }
          return out
        }}
        onDone={() => void qc.invalidateQueries()}
      >
        <p>
          <span className="font-medium">{revoke?.name}</span> will no longer be able to pay from this Bucket: the capability is revoked
          {revoke?.hasRole ? ' and its EAC ROLE_PAY removed (two wallet confirmations)' : ''}.
        </p>
        <p className="mt-2 text-accent">The vault stays under your OwnerCap.</p>
      </ConfirmTx>
    </div>
  )
}

export default function BucketsPage() {
  const { network } = useApp()
  const { address } = useOwnerWallet()
  const { buckets, isLoading } = useKnownBuckets()
  const mine = address ? buckets.filter((b) => isAddressEqual(b.holder, address)) : []
  const shown = mine.length > 0 ? mine : buckets

  return (
    <div className="space-y-8">
      <PageHero
        eyebrow="Financial capability protocol"
        title="Dual-stream authority"
        subtitle={
          <>
            One name, every operator. Grant scoped financial permissions and let agents execute — while your assets
            never leave your wallet.{' '}
            <Link to="/" className="font-medium text-accent hover:underline">
              How it works
            </Link>{' '}
            <span className="text-faint">·</span>{' '}
            <Link to="/buckets/new" className="font-medium text-accent hover:underline">
              Grant a permission
            </Link>
          </>
        }
        art={<DoodleVault width={132} height={132} />}
      />
      <OwnershipExplainer network={network} />
      {network === 'sui' ? (
        <SuiBuckets />
      ) : isLoading && shown.length === 0 ? (
        <Skeleton className="h-64" />
      ) : shown.length === 0 ? (
        <EmptyState title="No Buckets yet">A Bucket is bound to an ENSv2 name you own.</EmptyState>
      ) : (
        shown.map((b) => <EvmBucket key={b.bucketId} bucketId={b.bucketId} />)
      )}
    </div>
  )
}

