import { Permission, formatUsd, usd, type CapabilityGrant } from '@bucket/protocol-types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, CreditCard, Landmark, LineChart } from 'lucide-react'
import { Suspense, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { isAddress, isAddressEqual, parseUnits, type Address, type Hex } from 'viem'

import { ConfirmTx, type TxOutcome } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { Card, EmptyState, Identity, Input, Label, Spinner } from '@/components/ui/primitives'
import { useApp, useOwnerWallet } from '@/lib/client/app'
import { useSelectedBucket } from '@/lib/client/bucket-selection'
import { useAgentStatus, useBucketView, useSuiBucket } from '@/lib/client/queries'
import { useSuiOwner } from '@/lib/client/sui'
import { cn, dateLabel, shortAddr } from '@/lib/utils'

type Purpose = 'trading' | 'payments' | 'treasury'

function Steps({ step }: { step: number }) {
  const names = ['Purpose', 'Operator', 'Policy', 'Review']
  return (
    <div className="mb-6 flex items-center gap-2">
      {names.map((n, i) => (
        <div key={n} className="flex items-center gap-2">
          <div className={cn('grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold', i < step ? 'bg-accent text-accent-fg' : i === step ? 'bg-fg text-bg' : 'bg-panel-3 text-muted')}>
            {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </div>
          <span className={cn('text-xs', i === step ? 'text-fg' : 'text-muted')}>{n}</span>
          {i < names.length - 1 ? <div className="h-px w-6 bg-line" /> : null}
        </div>
      ))}
    </div>
  )
}

function PurposeCard({ icon, title, body, onClick, disabled, note }: { icon: ReactNode; title: string; body: string; onClick: () => void; disabled?: boolean; note?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full rounded-2xl border border-line bg-panel-2 p-5 text-left transition-colors hover:border-line-2 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
    >
      <div className="text-accent">{icon}</div>
      <div className="mt-2 font-semibold">{title}</div>
      <div className="mt-1 text-sm text-muted">{body}</div>
      {note ? <div className="mt-2 text-xs text-warn">{note}</div> : null}
    </button>
  )
}

function Review({ who, whoAddress, what, limit, velocity, expiry, custody }: { who: string; whoAddress: string; what: string; limit: string; velocity: string; expiry: string; custody: string }) {
  return (
    <div className="rounded-2xl bg-panel-2 p-5">
      <div className="text-xs font-semibold uppercase tracking-wider text-faint">You are granting</div>
      <div className="mt-3 grid grid-cols-[88px_1fr] gap-y-3 text-sm">
        <div className="text-muted">WHO</div>
        <Identity name={who} address={whoAddress} />
        <div className="text-muted">WHAT</div>
        <div className="font-medium">{what}</div>
        <div className="text-muted">LIMIT</div>
        <div className="font-medium">{limit}</div>
        <div className="text-muted">VELOCITY</div>
        <div className="font-medium">{velocity}</div>
        <div className="text-muted">EXPIRY</div>
        <div className="font-medium">{expiry}</div>
      </div>
      <div className="mt-4 rounded-lg bg-accent/5 px-3 py-2 text-sm text-accent">{custody}</div>
    </div>
  )
}

// =================================================================================================== EVM

function EvmWizard({ initial }: { initial: Purpose | null }) {
  const { bucket, deployment } = useApp()
  const { wallet, address } = useOwnerWallet()
  const sel = useSelectedBucket()
  const view = useBucketView(sel.bucketId)
  const agent = useAgentStatus()
  const qc = useQueryClient()
  const [step, setStep] = useState(initial ? 1 : 0)
  const [purpose, setPurpose] = useState<Purpose>(initial ?? 'trading')
  const [label, setLabel] = useState('exec')
  const [assets, setAssets] = useState<number[]>([0, 1])
  const [perExec, setPerExec] = useState('500')
  const [perHour, setPerHour] = useState('2000')
  const [perDay, setPerDay] = useState('2000')
  const [slippage, setSlippage] = useState('0.5')
  const [days, setDays] = useState('7')
  const [payee, setPayee] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [issued, setIssued] = useState<Hex | null>(null)

  const operator = useQuery({
    queryKey: ['ens-operator', sel.bucketId, label],
    enabled: !!sel.bucketId && label.length > 0 && step >= 1,
    queryFn: async () => {
      const name = await bucket.evm.nameOf(sel.bucketId!)
      const sub = await bucket.ens.subregistryOf(name.registry, name.label)
      if (/^0x0+$/.test(sub)) throw new Error('This Bucket name has no subregistry for operator names')
      const resolved = await bucket.ens.locate(sub, label)
      return resolved
    },
    retry: false,
  })

  if (!sel.bucketId) return <EmptyState title="No Bucket found">A Bucket is bound to an ENSv2 name you own.</EmptyState>
  if (!address) return <EmptyState title="Connect the owner wallet">Only the Bucket owner can grant permissions.</EmptyState>
  if (!sel.isOwner) return <EmptyState title="This wallet does not own a Bucket">Connect the wallet that owns the Bucket&apos;s ENSv2 name.</EmptyState>

  const v = view.data
  const symbols = (v?.snapshot.assets ?? []).map((a) => deployment.evm.tokens.find((t) => isAddressEqual(t.address, a.token))?.symbol ?? '?')
  const policy = v?.snapshot.params
  const permissions = purpose === 'payments' ? Permission.Pay : Permission.Swap | Permission.Rebalance
  const assetMask = assets.reduce((m, i) => m | (1 << i), 0)
  const operatorAddr = operator.data?.owner
  const operatorOk = !!operatorAddr && !/^0x0+$/.test(operatorAddr) && !isAddressEqual(operatorAddr, address)
  const now = Math.floor(Date.now() / 1000)
  const validUntil = now + Math.round(Number(days) * 86_400)
  const n = (s: string) => (Number(s) > 0 ? usd(s) : 0n)
  const problems: string[] = []
  if (purpose === 'trading' && assets.length < 2) problems.push('Pick at least two assets to trade between.')
  if (purpose === 'payments' && assets.length < 1) problems.push('Pick the asset payments are made in.')
  if (purpose === 'payments' && !isAddress(payee)) problems.push('Enter the fixed payee address.')
  if (!(n(perExec) > 0n && n(perExec) <= n(perHour) && n(perHour) <= n(perDay))) problems.push('Limits must satisfy per execution ≤ per hour ≤ per day.')
  if (policy && n(perDay) > policy.maxDailyValue) problems.push(`The Bucket policy caps daily value at ${formatUsd(policy.maxDailyValue)}.`)
  if (policy && n(perExec) > policy.maxExecutionValue) problems.push(`The Bucket policy caps each execution at ${formatUsd(policy.maxExecutionValue)}.`)
  if (!(Number(days) > 0)) problems.push('Expiry must be in the future.')

  const grant: CapabilityGrant = {
    operatorLabel: label,
    permissions,
    assetMask,
    venueMask: 1,
    validAfter: now - 60,
    validUntil,
    payee: purpose === 'payments' && isAddress(payee) ? (payee as Address) : ('0x0000000000000000000000000000000000000000' as Address),
    limits: {
      maxExecutionValue: n(perExec),
      maxHourlyValue: n(perHour),
      maxDailyValue: n(perDay),
      maxSlippageBps: Math.round(Number(slippage) * 100),
      maxDailyTurnoverBps: policy?.maxDailyTurnoverBps ?? 5_000,
      maxExecutions: 0,
    },
  }
  const operatorName = operator.data?.name ?? `${label}.${v?.ensName ?? ''}`
  const what = purpose === 'payments' ? `Pay ${assets.map((i) => symbols[i]).join(', ')} → ${shortAddr(payee)} only` : `Swap / rebalance ${assets.map((i) => symbols[i]).join(' ↔ ')}`

  if (issued) {
    return (
      <Card className="p-6">
        <div className="text-lg font-semibold text-accent">Permission granted</div>
        <div className="mt-2 text-sm text-muted">
          {operatorName} can now act within these limits. Capability <span className="font-mono">{shortAddr(issued, 10, 6)}</span>.
        </div>
        <div className="mt-5 flex gap-3">
          <Button asChild variant="primary">
            <Link to="/buckets">View Buckets</Link>
          </Button>
          <Button asChild>
            <Link to={purpose === 'payments' ? '/pay' : '/trade'}>{purpose === 'payments' ? 'Make a payment' : 'Trade'}</Link>
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card className="p-6">
      <Steps step={step} />
      {step === 0 ? (
        <div>
          <div className="mb-4 text-lg font-semibold">What should this permission do?</div>
          <div className="grid gap-3 md:grid-cols-3">
            <PurposeCard icon={<LineChart className="h-5 w-5" />} title="Trading" body="Swap and rebalance between chosen assets through Aqua + SwapVM." onClick={() => (setPurpose('trading'), setStep(1))} />
            <PurposeCard icon={<CreditCard className="h-5 w-5" />} title="Payments" body="Pay one fixed recipient from your wallet, within limits." onClick={() => (setPurpose('payments'), setStep(1))} />
            <PurposeCard icon={<Landmark className="h-5 w-5" />} title="Treasury" body="Multi-recipient treasury management." disabled note="Not supported by the current EVM contracts." onClick={() => undefined} />
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="space-y-4">
          <div className="text-lg font-semibold">Who is the operator?</div>
          <div>
            <Label hint={`under ${v?.ensName ?? 'your Bucket'}`}>ENSv2 name</Label>
            <div className="flex items-center gap-2">
              <Input value={label} onChange={(e) => setLabel(e.target.value.trim().toLowerCase())} placeholder="agent" />
              <span className="whitespace-nowrap text-sm text-muted">.{v?.ensName}</span>
            </div>
          </div>
          <div className="rounded-xl bg-panel-2 p-4 text-sm">
            {operator.isFetching ? (
              <span className="inline-flex items-center gap-2 text-muted">
                <Spinner /> Resolving on ENSv2…
              </span>
            ) : operator.error ? (
              <span className="text-danger">{String(operator.error instanceof Error ? operator.error.message : operator.error)}</span>
            ) : operatorAddr && !/^0x0+$/.test(operatorAddr) ? (
              <div>
                <div className="text-xs text-muted">Resolves to (the address that will hold authority)</div>
                <Identity name={operatorName} address={operatorAddr} />
                {isAddressEqual(operatorAddr, address) ? <div className="mt-2 text-danger">That is your own wallet — the owner cannot be their own operator.</div> : null}
                {agent.data?.evmOperator && isAddressEqual(operatorAddr, agent.data.evmOperator) ? (
                  <div className="mt-2 text-xs text-accent">This is the BUCKET agent operator — the agent will be able to act under this permission.</div>
                ) : null}
              </div>
            ) : (
              <span className="text-danger">{operatorName} is not registered.</span>
            )}
          </div>
          <p className="text-xs text-muted">
            On EVM, operators are ENSv2 names under your Bucket&apos;s name; the contract resolves the name to its current owner on every execution. A raw
            address is not accepted — authority always follows the name.
          </p>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button variant="primary" disabled={!operatorOk} onClick={() => setStep(2)}>
              Continue
            </Button>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="space-y-4">
          <div className="text-lg font-semibold">Limits</div>
          <div>
            <Label>{purpose === 'payments' ? 'Payment asset' : 'Allowed assets'}</Label>
            <div className="flex flex-wrap gap-2">
              {symbols.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setAssets((a) => (purpose === 'payments' ? [i] : a.includes(i) ? a.filter((x) => x !== i) : [...a, i]))}
                  className={cn('rounded-full border px-3 py-1.5 text-sm cursor-pointer', assets.includes(i) ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-muted')}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          {purpose === 'payments' ? (
            <div>
              <Label hint="the only address payments can go to">Fixed payee</Label>
              <Input value={payee} onChange={(e) => setPayee(e.target.value.trim())} placeholder="0x…" className="font-mono" />
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label hint="USD">Max per execution</Label>
              <Input value={perExec} onChange={(e) => setPerExec(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <Label hint="USD">Max per hour</Label>
              <Input value={perHour} onChange={(e) => setPerHour(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <Label hint="USD">Max per day</Label>
              <Input value={perDay} onChange={(e) => setPerDay(e.target.value)} inputMode="decimal" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {purpose === 'trading' ? (
              <div>
                <Label hint={`policy max ${(policy?.maxSlippageBps ?? 0) / 100}%`}>Max price concession</Label>
                <Input value={slippage} onChange={(e) => setSlippage(e.target.value)} inputMode="decimal" />
              </div>
            ) : null}
            <div>
              <Label hint={dateLabel(validUntil)}>Expires in (days)</Label>
              <Input value={days} onChange={(e) => setDays(e.target.value)} inputMode="decimal" />
            </div>
          </div>
          {problems.length ? (
            <ul className="space-y-1 text-sm text-warn">
              {problems.map((p) => (
                <li key={p}>• {p}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="primary" disabled={problems.length > 0} onClick={() => setStep(3)}>
              Review
            </Button>
          </div>
        </div>
      ) : null}

      {step === 3 && operatorAddr ? (
        <div className="space-y-4">
          <Review
            who={operatorName}
            whoAddress={operatorAddr}
            what={what}
            limit={`${formatUsd(grant.limits.maxExecutionValue)} / execution`}
            velocity={`${formatUsd(grant.limits.maxHourlyValue)} / hour · ${formatUsd(grant.limits.maxDailyValue)} / day`}
            expiry={dateLabel(validUntil)}
            custody="Your funds remain in your wallet."
          />
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button variant="primary" onClick={() => setConfirm(true)}>
              Confirm Permission
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmTx
        open={confirm}
        onOpenChange={setConfirm}
        title="Grant this permission?"
        confirmLabel="Sign & grant"
        run={async (): Promise<TxOutcome[]> => {
          if (!wallet) throw new Error('Connect the owner wallet')
          const r = await bucket.evm.issueCapability(wallet, sel.bucketId!, grant)
          setIssued(r.value.capabilityId)
          await qc.invalidateQueries()
          return [{ label: 'issue capability', url: `${deployment.evm.explorer ?? 'https://sepolia.etherscan.io'}/tx/${r.hash}` }]
        }}
      >
        You are granting <span className="font-medium">{operatorName}</span> {what.toLowerCase()} up to {formatUsd(grant.limits.maxExecutionValue)} per execution and{' '}
        {formatUsd(grant.limits.maxDailyValue)} per day until {dateLabel(validUntil)}. Your wallet signs one transaction; your assets do not move.
      </ConfirmTx>
    </Card>
  )
}

// =================================================================================================== Sui

function SuiWizard() {
  const { deployment, suiReader } = useApp()
  const owner = useSuiOwner()
  const sb = deployment.suiBuckets[0]
  const data = useSuiBucket(sb?.objectId ?? null)
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [who, setWho] = useState('bucketprotocol.sui')
  const [payeeInput, setPayeeInput] = useState('')
  const [perPayment, setPerPayment] = useState('0.1')
  const [perDay, setPerDay] = useState('0.5')
  const [days, setDays] = useState('7')
  const [confirm, setConfirm] = useState(false)
  const [done, setDone] = useState(false)

  const resolve = async (input: string): Promise<{ address: string; name: string | null }> => {
    if (/^0x[0-9a-fA-F]{1,64}$/.test(input)) return { address: input, name: null }
    if (!input.endsWith('.sui')) throw new Error('Enter a Sui address or a SuiNS name (…sui)')
    if (!suiReader || !deployment.sui?.suinsObjectId) throw new Error('SuiNS not configured')
    return { address: await suiReader.resolveSuinsPrincipal(deployment.sui.suinsObjectId, input), name: input }
  }
  const operator = useQuery({ queryKey: ['suins', who], enabled: step >= 1 && who.length > 3, retry: false, queryFn: () => resolve(who) })
  const payee = useQuery({ queryKey: ['suins-payee', payeeInput], enabled: step >= 2 && payeeInput.length > 3, retry: false, queryFn: () => resolve(payeeInput) })

  if (!sb || !deployment.sui) return <EmptyState title="No Sui Bucket in this deployment" />
  if (!owner.address) return <EmptyState title="Connect the owner's Sui wallet">Only the Bucket owner (holder of its OwnerCap) can grant permissions.</EmptyState>
  if (data.data && data.data.state.owner !== owner.address) return <EmptyState title="This Sui wallet does not own the Bucket">Connect the wallet that holds its OwnerCap.</EmptyState>

  const now = Math.floor(Date.now() / 1000)
  const validUntil = now + Math.round(Number(days) * 86_400)
  const mist = (s: string) => {
    try {
      return parseUnits(s, 9)
    } catch {
      return 0n
    }
  }
  const limitOk = mist(perPayment) > 0n && mist(perPayment) <= mist(perDay)
  if (done) {
    return (
      <Card className="p-6">
        <div className="text-lg font-semibold text-accent">Permission granted on Sui</div>
        <div className="mt-2 text-sm text-muted">{who} can now pay the fixed payee within these limits.</div>
        <div className="mt-5 flex gap-3">
          <Button asChild variant="primary">
            <Link to="/buckets">View Buckets</Link>
          </Button>
          <Button asChild>
            <Link to="/pay">Make a payment</Link>
          </Button>
        </div>
      </Card>
    )
  }
  return (
    <Card className="p-6">
      <Steps step={step} />
      {step === 0 ? (
        <div>
          <div className="mb-4 text-lg font-semibold">What should this permission do?</div>
          <div className="grid gap-3 md:grid-cols-3">
            <PurposeCard icon={<LineChart className="h-5 w-5" />} title="Trading" body="Swaps via Aqua + SwapVM." disabled note="EVM only — the Sui implementation does not route swaps." onClick={() => undefined} />
            <PurposeCard icon={<CreditCard className="h-5 w-5" />} title="Payments" body="Pay one fixed recipient from the Bucket vault, within limits." onClick={() => setStep(1)} />
            <PurposeCard icon={<Landmark className="h-5 w-5" />} title="Treasury" body="Multi-recipient treasury management." disabled note="Not exposed in this app." onClick={() => undefined} />
          </div>
        </div>
      ) : null}
      {step === 1 ? (
        <div className="space-y-4">
          <div className="text-lg font-semibold">Who is the operator?</div>
          <div>
            <Label hint="SuiNS name or address">Operator</Label>
            <Input value={who} onChange={(e) => setWho(e.target.value.trim())} />
          </div>
          <div className="rounded-xl bg-panel-2 p-4 text-sm">
            {operator.isFetching ? (
              <span className="inline-flex items-center gap-2 text-muted">
                <Spinner /> Resolving through BUCKET&apos;s on-chain SuiNS lookup…
              </span>
            ) : operator.error ? (
              <span className="text-danger">{operator.error instanceof Error ? operator.error.message : 'Name could not be resolved'}</span>
            ) : operator.data ? (
              <div>
                <div className="text-xs text-muted">Resolves to (the address that will hold authority)</div>
                <Identity name={operator.data.name} address={operator.data.address} />
              </div>
            ) : null}
          </div>
          <p className="text-xs text-muted">SuiNS says who. BUCKET EAC grants ROLE_PAY to the resolved address. Move enforces it on every payment.</p>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button variant="primary" disabled={!operator.data || operator.data.address === owner.address} onClick={() => setStep(2)}>
              Continue
            </Button>
          </div>
        </div>
      ) : null}
      {step === 2 ? (
        <div className="space-y-4">
          <div className="text-lg font-semibold">Limits</div>
          <div>
            <Label hint="SuiNS name or address">Fixed payee</Label>
            <Input value={payeeInput} onChange={(e) => setPayeeInput(e.target.value.trim())} placeholder="merchant.sui or 0x…" />
            {payee.data ? <div className="mt-1 font-mono text-xs text-muted">{payee.data.address}</div> : payee.error ? <div className="mt-1 text-xs text-danger">Could not resolve</div> : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label hint="SUI">Max per payment</Label>
              <Input value={perPayment} onChange={(e) => setPerPayment(e.target.value)} />
            </div>
            <div>
              <Label hint="SUI">Max per day</Label>
              <Input value={perDay} onChange={(e) => setPerDay(e.target.value)} />
            </div>
            <div>
              <Label hint={dateLabel(validUntil)}>Expires in (days)</Label>
              <Input value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
          </div>
          {!limitOk ? <div className="text-sm text-warn">Per payment must be positive and ≤ per day.</div> : null}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="primary" disabled={!payee.data || !limitOk} onClick={() => setStep(3)}>
              Review
            </Button>
          </div>
        </div>
      ) : null}
      {step === 3 && operator.data && payee.data ? (
        <div className="space-y-4">
          <Review
            who={operator.data.name ?? shortAddr(operator.data.address)}
            whoAddress={operator.data.address}
            what={`Pay SUI → ${payee.data.name ?? shortAddr(payee.data.address)} only`}
            limit={`${perPayment} SUI / payment`}
            velocity={`${perDay} SUI / day`}
            expiry={dateLabel(validUntil)}
            custody="Payments draw from the Bucket's Move vault; only your OwnerCap can withdraw it."
          />
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button variant="primary" onClick={() => setConfirm(true)}>
              Confirm Permission
            </Button>
          </div>
        </div>
      ) : null}
      <ConfirmTx
        open={confirm}
        onOpenChange={setConfirm}
        title="Grant this permission?"
        confirmLabel="Sign & grant (2 transactions)"
        run={async () => {
          if (!owner.client || !operator.data || !payee.data || !deployment.sui?.accessControlId || !deployment.sui.suinsObjectId) throw new Error('Not ready')
          const sui = deployment.sui
          const url = (d: string) => `${sui.explorer ?? 'https://suiscan.xyz/testnet'}/tx/${d}`
          const role = operator.data.name
            ? await owner.client.ownerGrantRolesBySuins({ packageId: sui.packageId, accessControlId: sui.accessControlId!, bucketObjectId: sb.objectId, ownerCapId: sb.ownerCapId, suinsObjectId: sui.suinsObjectId!, name: operator.data.name, roleBitmap: 0x10n })
            : await owner.client.ownerGrantRoles({ packageId: sui.packageId, accessControlId: sui.accessControlId!, bucketObjectId: sb.objectId, ownerCapId: sb.ownerCapId, roleBitmap: 0x10n, principal: operator.data.address })
          const cap = await owner.client.issueCapability({
            packageId: sui.packageId,
            bucketObjectId: sb.objectId,
            ownerCapId: sb.ownerCapId,
            grant: {
              operator: operator.data.address,
              operatorName: operator.data.name ?? operator.data.address,
              permissions: Permission.Pay,
              assetMask: 1,
              validAfter: BigInt(now - 60),
              validUntil: BigInt(validUntil),
              payee: payee.data.address,
              limits: { maxPerTx: mist(perPayment), maxHourlySpend: mist(perDay), maxDailySpend: mist(perDay), maxDailyTurnoverBps: 10_000, maxExecutions: 0 },
            },
          })
          setDone(true)
          await qc.invalidateQueries()
          return [
            { label: 'grant ROLE_PAY', url: url(role.digest) },
            { label: 'issue capability', url: url(cap.digest) },
          ]
        }}
      >
        <p>
          Two wallet confirmations: grant EAC <span className="font-medium">ROLE_PAY</span> to {operator.data?.name ?? shortAddr(operator.data?.address)}, then issue the
          payment capability ({perPayment} SUI / payment, {perDay} SUI / day, payee {payee.data?.name ?? shortAddr(payee.data?.address)}).
        </p>
      </ConfirmTx>
    </Card>
  )
}

function Wizard() {
  const { network } = useApp()
  const [params] = useSearchParams()
  const initial = params.get('purpose') === 'payments' ? 'payments' : params.get('purpose') === 'trading' ? 'trading' : null
  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/buckets" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Buckets
      </Link>
      <h1 className="mb-5 text-2xl font-semibold">Grant a permission</h1>
      {network === 'sui' ? <SuiWizard /> : <EvmWizard initial={initial} />}
    </div>
  )
}

export default function NewBucketPermissionPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Wizard />
    </Suspense>
  )
}

