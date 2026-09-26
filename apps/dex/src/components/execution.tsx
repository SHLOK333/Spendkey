import { ArrowDown, Ban, Check, CheckCircle2, ChevronRight, ShieldCheck, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Badge, Card, Details, Identity, Row, Spinner, TxLink } from '@/components/ui/primitives'
import type { AgentAction, ExecutionResult, PolicyCheck, ValidationResult } from '@/lib/agent/schema'
import { loadSession, targetOf, useActionRunner, validateAction, type ExecuteResponse } from '@/lib/client/agent'
import { useApp } from '@/lib/client/app'
import { cn, decimalString } from '@/lib/utils'

const KIND_TITLE: Record<AgentAction['action'], string> = {
  swap: 'Swap',
  rebalance: 'Rebalance',
  pay: 'Payment',
  sui_pay: 'Payment',
}

export function PolicyChecklist({ checks }: { checks: PolicyCheck[] }) {
  return (
    <ul className="space-y-1.5">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2 text-sm">
          {c.ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> : <X className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
          <div className="min-w-0">
            <div className={cn(c.ok ? 'text-fg' : 'text-danger')}>{c.label}</div>
            <div className="truncate text-xs text-muted" title={c.detail}>
              {c.detail}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

// ─── Execution path trace ────────────────────────────────────────────────────

interface SwapVmInstruction {
  opcode: string
  name: string
  ok: boolean
  detail: string
}

/**
 * Maps the server-side policy check results onto the four custom BUCKET SwapVM opcodes.
 * These are BUCKET-specific extension instructions, not standard EVM or 1inch opcodes.
 *
 * 0xd0 CapabilityGuard  — verifies the operator, capability state, permissions and asset mask
 * 0xd1 Quote            — simulates the fill; verifies allocation bands stay in policy
 * 0xd2 SpendLimit       — enforces maxExecutionValue and velocity (hourly/daily/turnover)
 * 0xd3 WalletBalanceCheck — verifies the holder's wallet balance and Aqua approval
 */
function buildOpcodeTrace(checks: PolicyCheck[]): SwapVmInstruction[] {
  const get = (id: string) => checks.find((c) => c.id === id)
  const allPass = (...ids: string[]) => ids.every((id) => get(id)?.ok !== false)
  const firstFail = (...ids: string[]) => ids.map(get).find((c) => c && !c.ok)

  return [
    {
      opcode: '0xd0',
      name: 'CapabilityGuard',
      ok: allPass('operator', 'capability', 'permission', 'asset'),
      detail:
        firstFail('operator', 'capability', 'permission', 'asset')?.detail ??
        get('operator')?.detail ??
        'Authorized operator',
    },
    {
      opcode: '0xd1',
      name: 'Quote',
      ok: get('program')?.ok !== false,
      detail: get('program')?.detail ?? 'Quote within policy',
    },
    {
      opcode: '0xd2',
      name: 'SpendLimit',
      ok: allPass('limit', 'velocity'),
      detail:
        firstFail('limit', 'velocity')?.detail ??
        get('limit')?.detail ??
        'Within spend limits',
    },
    {
      opcode: '0xd3',
      name: 'WalletBalanceCheck',
      ok: allPass('balance', 'allowance'),
      detail:
        firstFail('balance', 'allowance')?.detail ??
        get('balance')?.detail ??
        'Wallet balance sufficient',
    },
  ]
}

function TraceConnector() {
  return (
    <div className="flex justify-center py-0.5">
      <div className="flex flex-col items-center gap-0.5">
        <div className="h-3 w-px bg-line" />
        <ArrowDown className="h-3 w-3 text-faint" />
      </div>
    </div>
  )
}

function TraceBox({
  label,
  sub,
  address,
  explorerBase,
  ok,
  children,
}: {
  label: string
  sub?: string
  address?: string
  explorerBase?: string
  ok?: boolean | undefined
  children?: ReactNode
}) {
  const border =
    ok === false
      ? 'border-danger/25 bg-danger/5'
      : ok === true
        ? 'border-accent/20 bg-accent/5'
        : 'border-line bg-panel-2'
  return (
    <div className={cn('rounded-lg border px-3.5 py-3', border)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">{label}</div>
          {sub ? <div className="mt-0.5 text-xs text-muted">{sub}</div> : null}
          {address ? (
            <div className="mt-1">
              {explorerBase ? (
                <a
                  href={`${explorerBase}/address/${address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all font-mono text-[10px] text-brand/80 hover:text-brand"
                >
                  {address}
                </a>
              ) : (
                <span className="break-all font-mono text-[10px] text-muted">{address}</span>
              )}
            </div>
          ) : null}
        </div>
        {ok !== undefined ? (
          ok ? (
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          ) : (
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
          )
        ) : null}
      </div>
      {children}
    </div>
  )
}

/**
 * Expandable execution path trace for swap and rebalance actions.
 * All data is from real server-side validation + on-chain receipt — nothing is hardcoded.
 *
 * Shows: BUCKET policy → BUCKET SwapVM (0xd0–0xd3) → Aqua → actual token transfer → tx proof.
 * For blocked actions, shows which opcode blocked the execution (no on-chain tx was submitted).
 */
function ExecutionPathPanel({
  kind,
  checks,
  result,
}: {
  kind: 'swap' | 'rebalance'
  checks: PolicyCheck[]
  result?: ExecutionResult
}) {
  const { deployment } = useApp()
  const [open, setOpen] = useState(false)
  const instructions = buildOpcodeTrace(checks)
  const blocked = instructions.some((i) => !i.ok) || checks.some((c) => !c.ok)
  const policyOk = ['operator', 'capability', 'permission', 'asset'].every((id) => checks.find((c) => c.id === id)?.ok !== false)
  const swapVmOk = instructions.every((i) => i.ok)
  const explorer = deployment.evm.explorer ?? 'https://sepolia.etherscan.io'
  const fillTx = result?.transactions.find((t) => t.label.toLowerCase().includes('fill') || t.label.toLowerCase().includes('aqua'))

  return (
    <div className="mt-3 border-t border-line/50 pt-3">
      <button
        className="flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-fg"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight className={cn('h-3.5 w-3.5', open && 'rotate-90')} />
        View execution path
      </button>

      {open ? (
        <div className="mt-3 space-y-0">
          {/* 1. BUCKET Policy */}
          <TraceBox
            label="BUCKET Policy"
            sub="Authorization + capability constraints"
            address={deployment.evm.contracts.controller}
            explorerBase={explorer}
            ok={policyOk}
          />
          <TraceConnector />

          {/* 2. BUCKET SwapVM */}
          <TraceBox
            label="BUCKET SwapVM"
            sub="BucketSwapVMRouter · Powered by 1inch SwapVM · Runs custom BUCKET opcodes 0xd0–0xd3"
            address={deployment.evm.contracts.router}
            explorerBase={explorer}
            ok={swapVmOk}
          >
            <div className="mt-2.5 space-y-1.5 border-t border-line/40 pt-2.5">
              {instructions.map((ins) => (
                <div key={ins.opcode} className="flex items-start gap-2">
                  {ins.ok ? (
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                  ) : (
                    <X className="mt-0.5 h-3 w-3 shrink-0 text-danger" />
                  )}
                  <div className="min-w-0 text-xs">
                    <span className="font-mono text-faint">{ins.opcode}</span>
                    <span className="mx-1.5 text-muted">—</span>
                    <span className={cn('font-medium', ins.ok ? 'text-fg' : 'text-danger')}>{ins.name}</span>
                    <div className="mt-0.5 truncate text-[10px] text-faint" title={ins.detail}>
                      {ins.detail}
                    </div>
                  </div>
                </div>
              ))}
              <p className="mt-1 text-[10px] text-faint">
                {blocked
                  ? 'Server-side validation against live chain state. BUCKET blocked this action before transaction submission — no on-chain tx was submitted.'
                  : result
                    ? 'Server-side validation confirmed by the on-chain dry run. Program executed on-chain by BucketSwapVMRouter.'
                    : 'Server-side validation against live chain state.'}
              </p>
            </div>
          </TraceBox>

          <TraceConnector />

          {/* 3. 1inch Aqua — shown always; grayed when blocked to make the architecture visible */}
          <TraceBox
            label="1inch Aqua"
            sub={
              blocked
                ? 'Shared liquidity pool — not reached (BUCKET blocked before settlement)'
                : 'Shared liquidity settlement — Aqua router pulls tokens, fills the intent, pushes output'
            }
            address={deployment.evm.contracts.aqua}
            explorerBase={explorer}
            ok={blocked ? undefined : true}
          />

          {!blocked && fillTx ? (
            <>
              <TraceConnector />

              {/* 4. Actual token transfer */}
              {result?.actual.sold && result.actual.bought ? (
                <TraceBox label="Actual token transfer" ok={true}>
                  <div className="mt-1.5 text-sm font-semibold tabular">
                    {decimalString(result.actual.sold.amount)} {result.actual.sold.symbol}
                  </div>
                  <ArrowDown className="my-0.5 h-3 w-3 text-faint" />
                  <div className="text-sm font-semibold tabular text-accent">
                    {decimalString(result.actual.bought.amount)} {result.actual.bought.symbol}
                  </div>
                  <div className="mt-1 text-[10px] text-faint">
                    Amounts read from the on-chain ExecutionRecorded event, not the pre-trade quote.
                  </div>
                </TraceBox>
              ) : null}
              <TraceConnector />

              {/* 5. Onchain proof */}
              <TraceBox label="Onchain proof" sub="Network: Sepolia">
                <div className="mt-1.5 break-all font-mono text-[10px] text-muted">{fillTx.hash}</div>
                <div className="mt-2">
                  <TxLink href={fillTx.url} label="View on Etherscan ↗" />
                </div>
              </TraceBox>
            </>
          ) : blocked ? (
            <div className="mt-2 rounded-lg border border-danger/20 bg-danger/5 px-3.5 py-2.5 text-xs text-muted">
              BUCKET validation blocked this action before transaction submission. No on-chain transaction was submitted and no funds moved.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ─── Card components ─────────────────────────────────────────────────────────

export function BlockedCard({ validation }: { validation: ValidationResult }) {
  const b = validation.blocked
  const kind = validation.action.action
  return (
    <div className="rounded-xl border border-danger/30 bg-danger/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-danger">
        <Ban className="h-4 w-4" /> Blocked by BUCKET
      </div>
      <div className="mt-2 text-sm text-fg">{b?.message ?? 'This action is outside the authority of this Bucket.'}</div>
      {b?.requested || b?.allowed ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {b?.requested ? (
            <div>
              <div className="text-xs text-muted">Requested</div>
              <div className="text-lg font-semibold tabular text-danger">{b.requested}</div>
            </div>
          ) : null}
          {b?.allowed ? (
            <div>
              <div className="text-xs text-muted">Maximum allowed</div>
              <div className="text-lg font-semibold tabular">{b.allowed}</div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 text-xs text-muted">No transaction submitted. No funds moved.</div>
      <Details>{JSON.stringify({ blocked: validation.blocked, checks: validation.checks }, null, 2)}</Details>
      {kind === 'swap' || kind === 'rebalance' ? (
        <ExecutionPathPanel kind={kind} checks={validation.checks} />
      ) : null}
    </div>
  )
}

export function ReceiptCard({ result, validation }: { result: ExecutionResult; validation?: ValidationResult }) {
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-accent">
        <CheckCircle2 className="h-4 w-4" /> Execution successful
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {result.actual.sold ? (
          <div>
            <div className="text-xs text-muted">{result.kind === 'pay' || result.kind === 'sui_pay' ? 'Paid' : 'Actual input'}</div>
            <div className="text-base font-semibold tabular">
              {result.actual.sold.amount} {result.actual.sold.symbol}
            </div>
          </div>
        ) : null}
        {result.actual.bought ? (
          <div>
            <div className="text-xs text-muted">Actual output</div>
            <div className="text-base font-semibold tabular">
              {result.actual.bought.amount} {result.actual.bought.symbol}
            </div>
          </div>
        ) : null}
        {result.actual.recipient ? (
          <div className="col-span-2">
            <div className="text-xs text-muted">Recipient (fixed payee)</div>
            <div className="font-mono text-xs">{result.actual.recipient}</div>
          </div>
        ) : null}
      </div>
      <div className="mt-3 text-xs text-muted">Amounts read from the on-chain receipt, not the quote.</div>
      <div className="mt-3 border-t border-accent/15 pt-3">
        <div className="mb-1 text-xs text-muted">{result.network === 'sui' ? 'Bucket vault after' : 'Wallet balance updated'}</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular">
          {result.walletAfter.map((w) => (
            <span key={w.symbol}>
              {decimalString(w.amount)} <span className="text-muted">{w.symbol}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        {result.transactions.map((t) => (
          <TxLink key={t.hash} href={t.url} label={`${t.label} ↗`} />
        ))}
      </div>
      {validation && (result.kind === 'swap' || result.kind === 'rebalance') ? (
        <ExecutionPathPanel kind={result.kind} checks={validation.checks} result={result} />
      ) : null}
    </div>
  )
}

function QuoteBlock({ validation }: { validation: ValidationResult }) {
  const q = validation.quote
  if (!q) return null
  return (
    <div className="rounded-xl bg-panel-2 p-4">
      {q.sell ? (
        <div>
          <div className="text-xs text-muted">{validation.action.action.endsWith('pay') ? 'Pay' : 'Sell'}</div>
          <div className="text-2xl font-semibold tabular">
            {decimalString(q.sell.amount)} <span className="text-base text-muted">{q.sell.symbol}</span>
          </div>
        </div>
      ) : null}
      {q.buy ? (
        <>
          <ArrowDown className="my-2 h-4 w-4 text-faint" />
          <div>
            <div className="text-xs text-muted">Receive</div>
            <div className="text-2xl font-semibold tabular">
              ~{decimalString(q.buy.amount)} <span className="text-base text-muted">{q.buy.symbol}</span>
            </div>
          </div>
        </>
      ) : null}
      {q.valueUsd ? <Row label="Value" className="mt-2">{q.valueUsd}</Row> : null}
      <Row label="Route">
        <span className="text-xs">{q.route}</span>
      </Row>
    </div>
  )
}

/**
 * Structured action → BUCKET validation (server, incl. on-chain dry run) → review → owner approval (signed message)
 * → execution by the agent operator → receipt. `autonomous` skips the per-action signature when an owner-signed
 * session exists, but never skips validation.
 */
export function ActionFlow({ action, autonomous = false, onClose }: { action: AgentAction; autonomous?: boolean; onClose?: () => void }) {
  const runner = useActionRunner()
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'validating' | 'review' | 'signing' | 'executing' | 'done'>('validating')
  const [response, setResponse] = useState<ExecuteResponse | null>(null)

  async function run(v: ValidationResult) {
    try {
      // Autonomous = smart-account/session-key model: authorize ONCE, then act freely within the
      // on-chain limits. If a session is already open, execute silently; if not, open one now (a
      // single signature) instead of asking again on this and every future action.
      let approval = autonomous ? loadSession(targetOf(action)) : null
      if (autonomous && !approval) {
        setPhase('signing')
        approval = await runner.startSession(action.network, targetOf(action), 60)
      }
      setPhase(approval ? 'executing' : 'signing')
      approval = approval ?? (await runner.approveAction(action))
      setPhase('executing')
      setResponse(await runner.execute(action, approval))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setValidation(v)
    } finally {
      setPhase('done')
    }
  }

  useEffect(() => {
    let cancelled = false
    setPhase('validating')
    setResponse(null)
    setError(null)
    validateAction(action)
      .then((v) => {
        if (cancelled) return
        setValidation(v)
        if (autonomous && v.ok && loadSession(targetOf(action))) void run(v)
        else setPhase('review')
      })
      .catch((e: unknown) => !cancelled && (setError(e instanceof Error ? e.message : String(e)), setPhase('done')))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(action), autonomous])

  if (phase === 'validating') {
    return (
      <Card className="flex items-center gap-3 p-5 text-sm text-muted">
        <Spinner /> Checking this action against the live BUCKET authority…
      </Card>
    )
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">Agent execution</div>
          <div className="text-lg font-semibold">{KIND_TITLE[action.action]}</div>
        </div>
        <Badge tone={action.network === 'sui' ? 'blue' : 'neutral'}>{action.network === 'sui' ? 'Sui Testnet' : 'Sepolia'}</Badge>
      </div>

      {validation ? (
        <div className="space-y-4">
          <QuoteBlock validation={validation} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-muted">Operator</div>
              <Identity name={validation.operator.name} address={validation.operator.address} />
            </div>
            <div>
              <div className="text-xs text-muted">Authority</div>
              <div className="text-sm">{validation.capabilityLabel ?? 'Bucket capability'}</div>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-faint">
              <ShieldCheck className="h-3.5 w-3.5" /> Policy
            </div>
            <PolicyChecklist checks={validation.checks} />
          </div>
        </div>
      ) : null}

      <div className="mt-5 space-y-3">
        {response?.status === 'executed' ? <ReceiptCard result={response.result} validation={response.validation} /> : null}
        {response?.status === 'blocked' ? <BlockedCard validation={response.validation} /> : null}
        {!response && validation && !validation.ok ? <BlockedCard validation={validation} /> : null}
        {response?.status === 'failed' ? (
          <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm">
            <div className="font-semibold text-danger">{response.title}</div>
            <div className="mt-1">{response.error}</div>
            <Details>{response.detail}</Details>
          </div>
        ) : null}
        {error ? (
          <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm">
            <div className="font-semibold text-danger">Not executed</div>
            <div className="mt-1 text-muted">{error}</div>
          </div>
        ) : null}

        {validation?.ok && !response ? (
          <Button variant="primary" size="lg" className="w-full" disabled={phase === 'signing' || phase === 'executing'} onClick={() => void run(validation)}>
            {phase === 'signing' ? (
              <>
                <Spinner /> {autonomous && !loadSession(targetOf(action)) ? 'Authorize the session (one message, no gas)…' : 'Approve in your wallet (message, no gas)…'}
              </>
            ) : phase === 'executing' ? (
              <>
                <Spinner /> Executing on-chain…
              </>
            ) : autonomous ? (
              loadSession(targetOf(action)) ? 'Execute' : 'Authorize agent & execute'
            ) : (
              'Execute'
            )}
          </Button>
        ) : null}
        {validation?.ok && !response && phase === 'review' ? (
          <p className="text-center text-xs text-muted">
            {autonomous && !loadSession(targetOf(action))
              ? 'Authorize once — for the next hour the agent executes on its own key with no more prompts, bounded on-chain by this capability.'
              : autonomous
                ? 'Autonomous session active — the agent submits with its own key, bounded on-chain by this capability. No signature needed.'
                : 'You sign an approval message. The agent operator submits the transaction with its own key, bounded by this capability.'}
          </p>
        ) : null}
        {onClose && (response || (validation && !validation.ok)) ? (
          <Button variant="ghost" className="w-full" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </div>
    </Card>
  )
}
