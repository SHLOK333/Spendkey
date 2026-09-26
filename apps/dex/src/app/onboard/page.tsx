import { ethRegistrarAbi } from '@bucket/sdk'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Bot, Check, CircleDot, ExternalLink, Sparkles, Wallet, Zap } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { ConnectWallet } from '@/components/connect'
import { Button } from '@/components/ui/button'
import { Card, Input, Label, Spinner } from '@/components/ui/primitives'
import { useApp, useOwnerWallet } from '@/lib/client/app'
import { ONBOARD_STEPS, runOnboarding, type OnboardResult, type Progress, type StepKey } from '@/lib/client/onboard'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'active' | 'done' | 'error'
interface StepState {
  status: Status
  detail?: string
  wait?: number
  txs: Array<{ label: string; hash: string }>
}

const LABEL_RE = /^[a-z0-9-]{3,20}$/

function blankSteps(): Record<StepKey, StepState> {
  return Object.fromEntries(ONBOARD_STEPS.map((s) => [s.key, { status: 'idle', txs: [] } as StepState])) as Record<StepKey, StepState>
}

function StepRow({ index, label, state, explorer }: { index: number; label: string; state: StepState; explorer: string }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className={cn(
            'grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
            state.status === 'done' ? 'bg-accent text-accent-fg' : state.status === 'active' ? 'bg-fg text-bg' : state.status === 'error' ? 'bg-danger/15 text-danger' : 'bg-panel-3 text-muted',
          )}
        >
          {state.status === 'done' ? <Check className="h-4 w-4" /> : state.status === 'active' ? <Spinner /> : state.status === 'error' ? <AlertTriangle className="h-3.5 w-3.5" /> : index + 1}
        </div>
        {index < ONBOARD_STEPS.length - 1 ? <div className={cn('mt-1 w-px flex-1', state.status === 'done' ? 'bg-accent/40' : 'bg-line')} /> : null}
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <div className={cn('text-sm font-medium', state.status === 'idle' ? 'text-muted' : 'text-fg')}>{label}</div>
        {state.wait && state.status === 'active' ? <div className="mt-0.5 text-xs text-warn">ENSv2 commit/reveal wait — {state.wait}s remaining…</div> : state.detail ? <div className="mt-0.5 text-xs text-muted">{state.detail}</div> : null}
        {state.txs.length ? (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {state.txs.map((t, i) => (
              <a key={`${t.hash}-${i}`} href={`${explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-brand hover:underline">
                {t.label} <ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Wizard() {
  const { bucket, publicClient, deployment } = useApp()
  const { wallet, address, wrongChain } = useOwnerWallet()
  const explorer = deployment.evm.explorer ?? 'https://sepolia.etherscan.io'

  const [label, setLabel] = useState('')
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(blankSteps)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<OnboardResult | null>(null)
  const startedRef = useRef(false)

  const labelOk = LABEL_RE.test(label)
  const availability = useQuery({
    queryKey: ['ens-available', label],
    enabled: labelOk && !running && !result,
    retry: false,
    queryFn: () => publicClient.readContract({ address: deployment.evm.ens.ethRegistrar, abi: ethRegistrarAbi, functionName: 'isAvailable', args: [label] }),
  })

  const apply = useCallback((p: Progress) => {
    setSteps((prev) => {
      const next = { ...prev }
      const cur = { ...next[p.key] }
      if (p.type === 'step') {
        cur.status = p.status
        if (p.detail) cur.detail = p.detail
        if (p.status === 'active') delete cur.wait
      } else if (p.type === 'tx') {
        cur.txs = [...cur.txs, { label: p.label, hash: p.hash }]
      } else if (p.type === 'wait') {
        cur.status = 'active'
        cur.wait = p.secondsLeft
      }
      next[p.key] = cur
      return next
    })
  }, [])

  const run = useCallback(async () => {
    if (!wallet || !address || wrongChain || !labelOk) return
    setRunning(true)
    setError(null)
    startedRef.current = true
    try {
      const out = await runOnboarding({ wallet, publicClient, bucket, deployment, label }, apply)
      setResult(out)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      // Mark the currently-active step as failed so the trail shows where it stopped.
      setSteps((prev) => {
        const next = { ...prev }
        for (const s of ONBOARD_STEPS) if (next[s.key].status === 'active') next[s.key] = { ...next[s.key], status: 'error' }
        return next
      })
    } finally {
      setRunning(false)
    }
  }, [wallet, address, wrongChain, labelOk, publicClient, bucket, deployment, label, apply])

  // ---- completed ---------------------------------------------------------------------------------------------
  if (result) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-2 text-accent">
          <Sparkles className="h-5 w-5" />
          <span className="text-lg font-semibold">You&apos;re set up to trade</span>
        </div>
        <div className="mt-2 text-sm text-muted">
          <span className="font-medium text-fg">{result.ownerName}</span> is yours, your trading Bucket is live, and the BUCKET agent is authorized to rebalance it within on-chain limits — no wallet prompt per trade.
        </div>
        <div className="mt-4 rounded-xl bg-panel-2 p-4 text-xs text-muted">
          <div className="flex justify-between gap-3 py-1">
            <span>Bucket</span>
            <span className="truncate font-mono text-fg">{result.bucketId}</span>
          </div>
          <div className="flex justify-between gap-3 py-1">
            <span>Capability</span>
            <span className="truncate font-mono text-fg">{result.capabilityId}</span>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild variant="primary">
            <Link to="/agents">
              <Bot className="h-4 w-4" /> Start the agent
            </Link>
          </Button>
          <Button asChild>
            <Link to="/trade">
              Trade manually <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </Card>
    )
  }

  const available = availability.data === true
  const taken = availability.data === false
  const canStart = !!wallet && !!address && !wrongChain && labelOk && !availability.isFetching && !taken

  return (
    <Card className="p-6">
      {/* connect */}
      {!address ? (
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-panel-3 text-muted">
            <Wallet className="h-6 w-6" />
          </div>
          <div>
            <div className="text-base font-semibold">Connect your new wallet</div>
            <div className="mt-1 max-w-sm text-sm text-muted">Bring a fresh MetaMask account. We&apos;ll fund it with test gas and tokens on Sepolia, then set up your name, Bucket and agent — you just sign.</div>
          </div>
          <ConnectWallet />
        </div>
      ) : wrongChain ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <AlertTriangle className="h-6 w-6 text-warn" />
          <div className="text-sm text-muted">Switch your wallet to the Sepolia testnet to continue.</div>
        </div>
      ) : (
        <>
          {/* name picker */}
          <div className={cn('space-y-4', startedRef.current && 'pointer-events-none opacity-60')}>
            <div>
              <div className="text-lg font-semibold">Pick your name</div>
              <div className="mt-1 text-sm text-muted">This becomes your own <span className="font-mono">.eth</span> identity on ENSv2 — your Bucket and agent live under it.</div>
            </div>
            <div>
              <Label hint="3–20 chars · a–z, 0–9, -">Your name</Label>
              <div className="flex items-center gap-2">
                <Input value={label} onChange={(e) => setLabel(e.target.value.trim().toLowerCase())} placeholder="satoshi" autoFocus disabled={startedRef.current} />
                <span className="whitespace-nowrap text-sm text-muted">.eth</span>
              </div>
              <div className="mt-1.5 h-4 text-xs">
                {!label ? null : !labelOk ? (
                  <span className="text-warn">Use 3–20 lowercase letters, numbers or hyphens.</span>
                ) : availability.isFetching ? (
                  <span className="inline-flex items-center gap-1.5 text-muted">
                    <Spinner /> Checking availability…
                  </span>
                ) : available ? (
                  <span className="text-accent">{label}.eth is available</span>
                ) : taken ? (
                  <span className="text-danger">{label}.eth is taken — try another.</span>
                ) : availability.error ? (
                  <span className="text-danger">Couldn&apos;t check availability.</span>
                ) : null}
              </div>
            </div>
          </div>

          {/* progress trail (shown once started) */}
          {startedRef.current ? (
            <div className="mt-6 border-t border-line pt-6">
              <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-faint">
                <CircleDot className="h-3.5 w-3.5" /> Setting up {label}.eth
              </div>
              {ONBOARD_STEPS.map((s, i) => (
                <StepRow key={s.key} index={i} label={s.label} state={steps[s.key]} explorer={explorer} />
              ))}
            </div>
          ) : (
            <p className="mt-6 text-xs text-muted">
              You&apos;ll sign each step in MetaMask — registering your name (a ~1 minute ENSv2 commit/reveal wait), deploying your registry, creating your Bucket, and authorizing the agent. Your funds never leave your wallet; the agent is bounded by on-chain limits.
            </p>
          )}

          {error ? <div className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}

          <div className="mt-6 flex items-center justify-between gap-3">
            <Link to="/" className="text-sm text-muted hover:text-fg">
              Cancel
            </Link>
            <Button variant="primary" size="lg" disabled={!canStart || running} onClick={run}>
              {running ? (
                <>
                  <Spinner /> Setting up…
                </>
              ) : error ? (
                'Resume setup'
              ) : (
                <>
                  Set me up to trade <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}

function Chooser({ onCreate }: { onCreate: () => void }) {
  const { deployment } = useApp()
  const demoBucket = deployment.buckets[0]?.ensName ?? deployment.ens?.ownerName ?? 'trading.shlok.eth'

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Instant — shared demo Bucket */}
      <Card className="flex flex-col p-6">
        <div className="flex items-center gap-2 text-accent">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/15">
            <Zap className="h-5 w-5" />
          </span>
          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Instant</span>
        </div>
        <div className="mt-4 text-lg font-semibold">Use a ready-made Bucket</div>
        <p className="mt-1.5 flex-1 text-sm text-muted">
          Skip name registration entirely. The <span className="font-mono text-fg">{demoBucket}</span> Bucket is already live with the
          agent authorized — jump straight in and watch it trade under on-chain limits. Best for a quick look or a demo.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild variant="primary">
            <Link to="/trade">
              Trade now <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/agents">
              <Bot className="h-4 w-4" /> Meet the agent
            </Link>
          </Button>
        </div>
        <p className="mt-3 text-xs text-faint">No registration wait. Owner actions need the Bucket owner&apos;s wallet; the agent runs for everyone.</p>
      </Card>

      {/* Full — create your own identity */}
      <Card className="flex flex-col p-6">
        <div className="flex items-center gap-2 text-brand">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-panel-3 text-fg">
            <Sparkles className="h-5 w-5" />
          </span>
          <span className="rounded-full bg-panel-3 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Your own</span>
        </div>
        <div className="mt-4 text-lg font-semibold">Create your own identity</div>
        <p className="mt-1.5 flex-1 text-sm text-muted">
          Register your own <span className="font-mono text-fg">.eth</span> name on ENSv2, deploy your registry, and spin up your own
          trading Bucket + agent. Everything is yours. Includes a ~1&nbsp;minute ENS commit/reveal wait.
        </p>
        <div className="mt-5">
          <Button variant="primary" onClick={onCreate}>
            Create my name <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <p className="mt-3 text-xs text-faint">A brand-new wallet to a live, agent-managed Bucket — name, identity and all.</p>
      </Card>
    </div>
  )
}

export default function OnboardPage() {
  const [mode, setMode] = useState<'choose' | 'create'>('choose')

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold">{mode === 'create' ? 'Create your identity' : 'Get started'}</h1>
        <p className="mt-1 text-sm text-muted">
          {mode === 'create'
            ? 'A brand-new wallet to a live, agent-managed Bucket — name, identity and all.'
            : 'Trade on a ready-made Bucket right now, or create your own ENSv2 identity from scratch.'}
        </p>
      </div>
      {mode === 'create' ? (
        <div className="mx-auto max-w-2xl">
          <button onClick={() => setMode('choose')} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
            ← Back to options
          </button>
          <Wizard />
        </div>
      ) : (
        <Chooser onCreate={() => setMode('create')} />
      )}
    </div>
  )
}
