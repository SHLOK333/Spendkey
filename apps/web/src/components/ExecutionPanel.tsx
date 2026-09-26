import { Permission, formatAmount, formatUsd, formatWeight, hasPermissions } from '@bucket/protocol-types'
import { BucketProtocolError, type BucketView, type RebalanceExecution, type RebalanceStage, type StageUpdate } from '@bucket/sdk'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { useApp } from '../lib/context'
import { evmTxUrl } from '../lib/format'
import { useCapabilities } from '../lib/queries'
import { probeERC7715, requestBucketExecutionPermission } from '../lib/evmWallet'
import { Chip, ErrorBox, HexLink, Panel, Spinner } from './primitives'

// ─── Pipeline stages ──────────────────────────────────────────────────────────
//
// 7-step execution pipeline (spec Part 10):
//   Authorization → Capability → Policy → Intent → Quote → Execution → Post-state
//
// Stage 1 (authorization) is managed locally here: it runs the ERC-7715 wallet
// probe + permission request BEFORE the SDK's executeRebalance call. The remaining
// six stages are reported by the SDK via onStage callbacks.
//
// ERC-7715 is purely additive UX — wallet sees a scoped permission hint. BUCKET
// on-chain validation (BucketCapabilities, BucketEngine) enforces all limits
// regardless of whether the wallet supports ERC-7715.

type AuthStatus = 'pending' | 'running' | 'granted' | 'not-supported' | 'declined'
type StageStatus = 'pending' | StageUpdate['status']

const SDK_STAGES: ReadonlyArray<{ key: RebalanceStage; label: string; layer: string }> = [
  { key: 'capability-check', label: 'Capability check', layer: 'BucketCapabilities' },
  { key: 'policy-check', label: 'Policy check', layer: 'Bucket' },
  { key: 'open-intent', label: 'Intent opened', layer: 'Bucket' },
  { key: 'quote-verify', label: 'Quote + spend limit verified', layer: 'SwapVM 0xd1-0xd2' },
  { key: 'execution', label: 'Execution', layer: 'Aqua + SwapVM' },
  { key: 'post-state', label: 'Post-state verified', layer: 'BucketController' },
]

function rowOf(view: BucketView, token: string) {
  return view.allocation.rows.find((r) => r.token.toLowerCase() === token.toLowerCase())
}

function describe(view: BucketView, token: string, amount: bigint): string {
  const row = rowOf(view, token)
  return row ? `${formatAmount(amount, row.decimals)} ${row.symbol}` : `${amount} ${token}`
}

function authMark(status: AuthStatus) {
  if (status === 'granted') return '✓'
  if (status === 'not-supported') return '–'
  if (status === 'declined') return '–'
  if (status === 'running') return <Spinner />
  return '○'
}

function authLabel(status: AuthStatus): string {
  if (status === 'granted') return 'ERC-7715 permission granted'
  if (status === 'not-supported') return 'ERC-7715 not supported (direct capability used)'
  if (status === 'declined') return 'ERC-7715 permission declined (direct capability used)'
  return 'ERC-7715 authorization'
}

export function ExecutionPanel({ view }: { view: BucketView }) {
  const { clients, config, evmWallet } = useApp()
  const queryClient = useQueryClient()
  const entry = config.deployment.buckets.find((b) => b.bucketId === view.bucketId)
  const capabilities = useCapabilities(view.bucketId, entry?.capabilities ?? [])
  const [sdkStages, setSdkStages] = useState<Record<RebalanceStage, StageUpdate | null>>(
    () => Object.fromEntries(SDK_STAGES.map((s) => [s.key, null])) as Record<RebalanceStage, StageUpdate | null>,
  )
  const [authStatus, setAuthStatus] = useState<AuthStatus>('pending')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RebalanceExecution | null>(null)
  const [error, setError] = useState<unknown>(null)

  const usable = capabilities.data?.find(
    (c) =>
      c.capability &&
      evmWallet.address &&
      c.capability.operator.toLowerCase() === evmWallet.address.toLowerCase() &&
      hasPermissions(c.capability.permissions, Permission.Rebalance),
  )
  const capabilityId = usable?.entry.capabilityId

  const blocker = !evmWallet.address
    ? 'Connect the operator EVM wallet'
    : evmWallet.wrongChain
      ? 'Switch the EVM wallet to Sepolia'
      : capabilities.isLoading
        ? 'Checking capabilities…'
        : !capabilityId
          ? 'Connected account holds no live REBALANCE capability for this Bucket'
          : !view.plan?.required
            ? view.plan && !view.plan.required
              ? view.plan.reason === 'PriceStale'
                ? 'Reference prices are stale'
                : 'Bucket is within policy or limits are exhausted'
              : 'No open intent and Bucket is within policy'
            : null

  async function run() {
    if (!evmWallet.wallet || !capabilityId) return
    setRunning(true)
    setError(null)
    setResult(null)
    setSdkStages(Object.fromEntries(SDK_STAGES.map((s) => [s.key, null])) as Record<RebalanceStage, StageUpdate | null>)
    setAuthStatus('pending')

    try {
      // Step 1 — ERC-7715 authorization (wallet-level UX hint, never bypasses on-chain validation)
      const provider = typeof window !== 'undefined' ? window.ethereum : undefined
      if (provider) {
        setAuthStatus('running')
        const supported = await probeERC7715(provider)
        if (supported) {
          const ctx = await requestBucketExecutionPermission(provider, {
            chainId: evmWallet.chainId ?? 11155111,
            bucketId: view.bucketId,
            capabilityId: capabilityId as `0x${string}`,
            controllerAddress: config.deployment.evm.contracts.controller,
            expiryUnix: Math.floor(Date.now() / 1000) + 3600,
          })
          setAuthStatus(ctx ? 'granted' : 'declined')
        } else {
          setAuthStatus('not-supported')
        }
      } else {
        setAuthStatus('not-supported')
      }

      // Steps 2-7 — BUCKET on-chain capability validation and execution
      const execution = await clients.bucket.executeRebalance({
        bucketId: view.bucketId,
        capabilityId,
        wallet: evmWallet.wallet,
        reuseActiveIntent: true,
        onStage: (update) => setSdkStages((current) => ({ ...current, [update.stage]: update })),
      })
      setResult(execution)
    } catch (e) {
      setError(e)
    } finally {
      setRunning(false)
      await queryClient.invalidateQueries()
    }
  }

  const plan = view.plan
  return (
    <Panel
      eyebrow="1inch Aqua + SwapVM · opcodes 0xd0-0xd3"
      title="BUCKET_REBALANCE"
      actions={
        <button className="btn btn-primary" disabled={running || blocker !== null} onClick={() => void run()}>
          {running ? <Spinner /> : null} Execute rebalance
        </button>
      }
    >
      {plan?.required ? (
        <div className="plan">
          <div>
            <div className="label">Sell (overweight)</div>
            <strong>{view.allocation.rows[plan.outIndex]?.symbol}</strong>
            <span className="muted mono"> ≤ {formatAmount(plan.budgetOut, view.allocation.rows[plan.outIndex]?.decimals ?? 18)}</span>
          </div>
          <div className="plan-arrow">→</div>
          <div>
            <div className="label">Buy (underweight)</div>
            <strong>{view.allocation.rows[plan.inIndex]?.symbol}</strong>
          </div>
          <div>
            <div className="label">Leg value</div>
            <strong className="mono">{formatUsd(plan.tradeValue)}</strong>
          </div>
        </div>
      ) : null}

      {/* 7-step execution pipeline */}
      <ol className="stages">
        {/* Stage 1: ERC-7715 authorization (local, pre-SDK) */}
        <li className={`stage stage-${authStatus === 'granted' ? 'done' : authStatus === 'running' ? 'running' : authStatus === 'pending' ? 'pending' : 'skipped'}`}>
          <span className="stage-mark">{authMark(authStatus)}</span>
          <span className="stage-label">{authLabel(authStatus)}</span>
          <span className="stage-layer muted">ERC-7715</span>
          <span className="stage-link" />
        </li>

        {/* Stages 2-7: SDK-reported stages */}
        {SDK_STAGES.map((stage) => {
          const update = sdkStages[stage.key]
          const status: StageStatus = update?.status ?? 'pending'
          const link = update?.txHash ? { value: update.txHash, href: evmTxUrl(config.deployment, update.txHash) } : null
          return (
            <li key={stage.key} className={`stage stage-${status}`}>
              <span className="stage-mark">
                {status === 'done' ? '✓' : status === 'running' ? <Spinner /> : status === 'skipped' ? '–' : '○'}
              </span>
              <span className="stage-label">{stage.label}</span>
              <span className="stage-layer muted">{stage.layer}</span>
              <span className="stage-link">{link ? <HexLink value={link.value} href={link.href} /> : null}</span>
            </li>
          )
        })}
      </ol>

      {result ? (
        <div className="result">
          <Chip tone="ok">EXECUTED</Chip>
          <span className="mono">
            {describe(view, view.activeIntent?.intent.tokenOut ?? '0x0', result.fill.amountOut)} out ·{' '}
            {describe(view, view.activeIntent?.intent.tokenIn ?? '0x0', result.fill.amountIn)} in · max deviation{' '}
            {formatWeight(result.fill.pre.maxAbsDeviationWad)} → {formatWeight(result.fill.post?.maxAbsDeviationWad ?? 0n)}
          </span>
        </div>
      ) : null}
      {error ? (
        <ErrorBox error={error instanceof BucketProtocolError ? new Error(`Protocol rejected: ${error.message}`) : error} />
      ) : null}
      {blocker && !running ? <p className="muted small">{blocker}</p> : null}
    </Panel>
  )
}
