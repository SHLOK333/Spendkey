import { formatUsd } from '@bucket/protocol-types'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Bot, Brain, Scale, ShieldCheck } from 'lucide-react'

import { useState } from 'react'

import { AgentChat, type QuickAction } from '@/components/agent-chat'
import { AiSettings } from '@/components/ai-settings'
import { ConfirmTx } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { Badge, Card, EmptyState, Identity, Row, Skeleton, StatusDot } from '@/components/ui/primitives'
import { useApp, useOwnerWallet } from '@/lib/client/app'
import { useSelectedBucket } from '@/lib/client/bucket-selection'
import { useAgentStatus, useBucketView, useSuiBucket } from '@/lib/client/queries'
import { useSuiOwner } from '@/lib/client/sui'
import { tokenAmount } from '@/lib/utils'

function Pipeline() {
  const steps = [
    { icon: <Brain className="h-4 w-4" />, title: 'AI reasoning' },
    { icon: <ShieldCheck className="h-4 w-4" />, title: 'BUCKET authorization' },
    { icon: <Scale className="h-4 w-4" />, title: 'On-chain execution' },
  ]
  return (
    <div className="flex items-center gap-1.5">
      {steps.map((s, i) => (
        <div key={s.title} className="contents">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-medium">
            <span className="text-accent">{s.icon}</span> {s.title}
          </div>
          {i < steps.length - 1 ? <ArrowRight className="h-3.5 w-3.5 shrink-0 text-faint" /> : null}
        </div>
      ))}
    </div>
  )
}

function EvmAgents({ onConfigure }: { onConfigure: () => void }) {
  const { deployment, bucket } = useApp()
  const { wallet } = useOwnerWallet()
  const status = useAgentStatus()
  const sel = useSelectedBucket()
  const view = useBucketView(sel.bucketId)
  const qc = useQueryClient()
  const [stop, setStop] = useState(false)
  if (sel.isLoading || !status.data) return <Skeleton className="h-96" />
  if (!sel.bucketId) return <EmptyState title="No Bucket yet" />
  const ens = view.data?.ensName ?? ''
  const caps = sel.agentCaps
  const operatorName = caps[0] ? `${caps[0].capability.operatorLabel}.${ens}` : null
  const best = [...caps].sort((a, b) => Number(b.capability.limits.maxExecutionValue - a.capability.limits.maxExecutionValue))[0]
  const usdc = deployment.evm.tokens.find((t) => t.symbol === 'USDC')
  const quick: QuickAction[] = [
    ...sel.rebalanceCaps.slice(0, 1).map((c) => ({ label: 'Rebalance now', action: { action: 'rebalance' as const, network: 'sepolia' as const, bucketId: sel.bucketId!, capabilityId: c.id } })),
    ...sel.swapCaps.slice(0, 1).flatMap((c) => [
      { label: 'Swap 180 USDC → ETH', action: { action: 'swap' as const, network: 'sepolia' as const, bucketId: sel.bucketId!, capabilityId: c.id, sellSymbol: 'USDC', buySymbol: 'ETH', sellAmount: '180' } },
      { label: 'Swap 620 USDC → ETH', hint: 'Above a $500 limit: BUCKET should block it', action: { action: 'swap' as const, network: 'sepolia' as const, bucketId: sel.bucketId!, capabilityId: c.id, sellSymbol: 'USDC', buySymbol: 'ETH', sellAmount: '620' } },
    ]),
    ...(usdc ? sel.payCaps.slice(0, 1).map((c) => ({ label: 'Pay 10 USDC', action: { action: 'pay' as const, network: 'sepolia' as const, bucketId: sel.bucketId!, capabilityId: c.id, symbol: 'USDC', amount: '10' } })) : []),
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-accent" />
              <div className="font-semibold">Trading Agent</div>
            </div>
            <Badge tone={caps.length ? 'green' : 'red'}>
              <StatusDot active={caps.length > 0} /> {caps.length ? 'Active' : 'No authority'}
            </Badge>
          </div>
          <div className="mt-4">
            <div className="text-xs text-muted">Operator</div>
            <Identity name={operatorName} address={status.data.evmOperator} />
          </div>
          <div className="mt-3 border-t border-line pt-2">
            <Row label="Provider">{status.data.ai.configured ? `OpenAI · ${status.data.ai.model}` : 'OpenAI · not configured'}</Row>
            <Row label="Bucket">{ens || '—'}</Row>
            <Row label="Authority">{best ? `${formatUsd(best.capability.limits.maxExecutionValue)} / execution` : 'none'}</Row>
            <Row label="Permissions">
              {[sel.swapCaps.length && 'Swap', sel.rebalanceCaps.length && 'Rebalance', sel.payCaps.length && 'Pay'].filter(Boolean).join(' · ') || '—'}
            </Row>
            <Row label="Operator gas">{status.data.evmOperatorGasEth ? `${Number(status.data.evmOperatorGasEth).toFixed(4)} ETH` : '—'}</Row>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button size="sm" onClick={onConfigure}>
              Configure
            </Button>
            <Button size="sm" variant="danger" disabled={!sel.isOwner || caps.length === 0} onClick={() => setStop(true)}>
              Stop
            </Button>
          </div>
        </Card>
      </div>
      <AgentChat title="Trading Agent" selection={{ network: 'sepolia', bucketId: sel.bucketId }} aiConfigured={!!status.data.ai.configured} quickActions={quick} onConfigure={onConfigure} />
      <ConfirmTx
        open={stop}
        onOpenChange={setStop}
        title="Stop this agent?"
        confirmLabel={`Revoke ${caps.length} capabilit${caps.length === 1 ? 'y' : 'ies'}`}
        destructive
        run={async () => {
          if (!wallet) throw new Error('Connect the owner wallet')
          const out = []
          for (const c of caps) {
            const r = await bucket.evm.revokeCapability(wallet, c.id)
            out.push({ label: 'revoke', url: `${deployment.evm.explorer ?? 'https://sepolia.etherscan.io'}/tx/${r.hash}` })
          }
          return out
        }}
        onDone={() => void qc.invalidateQueries()}
      >
        Every capability naming {operatorName} is revoked on-chain ({caps.length} transaction{caps.length === 1 ? '' : 's'}). The agent can no longer execute anything
        on this Bucket. <span className="text-accent">Your assets remain in your wallet.</span>
      </ConfirmTx>
    </div>
  )
}

function SuiAgents({ onConfigure }: { onConfigure: () => void }) {
  const { deployment } = useApp()
  const status = useAgentStatus()
  const sb = deployment.suiBuckets[0]
  const data = useSuiBucket(sb?.objectId ?? null)
  const owner = useSuiOwner()
  const qc = useQueryClient()
  const [stop, setStop] = useState(false)
  if (!sb || !deployment.sui) return <EmptyState title="No Sui Bucket in this deployment" />
  if (!status.data || data.isLoading || !data.data) return <Skeleton className="h-96" />
  const agent = status.data.suiOperator
  const caps = data.data.capabilities.filter((c) => agent && c.operator === agent)
  const live = caps.filter((c) => c.status === 1 && Number(c.validUntil) * 1000 > Date.now() && c.policyVersion === data.data.state.policy.version && c.epoch === data.data.state.capabilityEpoch)
  const role = caps.some((c) => c.hasRolePay)
  const active = live.length > 0 && role
  const cap = live[0]
  const quick: QuickAction[] = cap
    ? [
        { label: 'Pay 0.01 SUI', action: { action: 'sui_pay', network: 'sui', bucketObjectId: sb.objectId, amount: '0.01' } },
        { label: `Pay ${Number(tokenAmount(cap.limits.maxPerTx, 9)) * 2} SUI`, hint: 'Above the per-payment limit: Move should block it', action: { action: 'sui_pay', network: 'sui', bucketObjectId: sb.objectId, amount: String(Number(tokenAmount(cap.limits.maxPerTx, 9)) * 2) } },
      ]
    : [{ label: 'Pay 0.01 SUI', action: { action: 'sui_pay', network: 'sui', bucketObjectId: sb.objectId, amount: '0.01' } }]
  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-accent" />
              <div className="font-semibold">Payments Agent</div>
            </div>
            <Badge tone={active ? 'green' : 'red'}>
              <StatusDot active={active} /> {active ? 'Active' : live.length ? 'Role revoked' : 'No authority'}
            </Badge>
          </div>
          <div className="mt-4">
            <div className="text-xs text-muted">Operator (SuiNS identity)</div>
            <Identity name={cap?.operatorName ?? caps[0]?.operatorName ?? null} address={agent} />
          </div>
          <div className="mt-3 border-t border-line pt-2">
            <Row label="Provider">{status.data.ai.configured ? `OpenAI · ${status.data.ai.model}` : 'OpenAI · not configured'}</Row>
            <Row label="Bucket">{data.data.state.name}</Row>
            <Row label="EAC ROLE_PAY">{role ? <Badge tone="green">granted</Badge> : <Badge tone="red">not granted</Badge>}</Row>
            <Row label="Authority">{cap ? `${tokenAmount(cap.limits.maxPerTx, 9)} SUI / payment` : 'none'}</Row>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button size="sm" onClick={onConfigure}>
              Configure
            </Button>
            <Button size="sm" variant="danger" disabled={!owner.address || owner.address !== data.data.state.owner || !role} onClick={() => setStop(true)}>
              Stop
            </Button>
          </div>
        </Card>
      </div>
      <AgentChat title="Payments Agent" selection={{ network: 'sui', bucketObjectId: sb.objectId }} aiConfigured={!!status.data.ai.configured} quickActions={quick} onConfigure={onConfigure} />
      <ConfirmTx
        open={stop}
        onOpenChange={setStop}
        title="Stop this agent?"
        confirmLabel="Revoke ROLE_PAY"
        destructive
        run={async () => {
          if (!owner.client || !agent || !deployment.sui?.accessControlId) throw new Error('Connect the owner Sui wallet')
          const r = await owner.client.ownerRevokeRoles({
            packageId: deployment.sui.packageId,
            accessControlId: deployment.sui.accessControlId,
            bucketObjectId: sb.objectId,
            ownerCapId: sb.ownerCapId,
            roleBitmap: 0x10n,
            principal: agent,
          })
          return [{ label: 'owner_revoke_roles', url: `${deployment.sui.explorer}/tx/${r.digest}` }]
        }}
        onDone={() => void qc.invalidateQueries()}
      >
        The agent&apos;s EAC ROLE_PAY is removed on this Bucket; every payment it attempts will abort in Move. <span className="text-accent">The vault stays under your OwnerCap.</span>
      </ConfirmTx>
    </div>
  )
}

export default function AgentsPage() {
  const { network } = useApp()
  const status = useAgentStatus()
  const [settings, setSettings] = useState(false)
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold">Agents</h1>
          <Pipeline />
        </div>
        <Button onClick={() => setSettings(true)}>AI settings</Button>
      </div>
      {network === 'sui' ? <SuiAgents onConfigure={() => setSettings(true)} /> : <EvmAgents onConfigure={() => setSettings(true)} />}
      <AiSettings open={settings} onOpenChange={setSettings} status={status.data?.ai} />
    </div>
  )
}

