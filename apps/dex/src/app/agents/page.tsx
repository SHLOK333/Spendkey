import { formatUsd } from '@bucket/protocol-types'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Bot, Brain, Fingerprint, Scale, ShieldCheck } from 'lucide-react'

import { useState } from 'react'

import { AgentChat, type QuickAction, type Selection } from '@/components/agent-chat'
import { AiSettings } from '@/components/ai-settings'
import { ConfirmTx } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { Badge, Card, EmptyState, Identity, Row, Skeleton, StatusDot } from '@/components/ui/primitives'
import { useApp, useOwnerWallet } from '@/lib/client/app'
import { useAgentCards, useAgentStatus, useOwnerAgentBuckets, useSuiBucket, type AgentCard, type OwnerAgentBucket } from '@/lib/client/queries'
import { useSuiOwner } from '@/lib/client/sui'
import { tokenAmount } from '@/lib/utils'

/** The three demo Buckets are named by their ENS label (trading / savings / payments); title-case it for display. */
function agentTitle(ensName: string): string {
  const label = ensName.split('.')[0] ?? ''
  const nice = label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Bucket'
  return `${nice} Agent`
}

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

/** One agent card per owned Bucket (Trading / Savings / Payments), with its live authority and a Stop control. */
function AgentBucketCard({ b, onConfigure }: { b: OwnerAgentBucket; onConfigure: () => void }) {
  const { deployment, bucket } = useApp()
  const { wallet } = useOwnerWallet()
  const status = useAgentStatus()
  const qc = useQueryClient()
  const [stop, setStop] = useState(false)
  const caps = b.agentCaps
  const operatorName = caps[0] ? `${caps[0].capability.operatorLabel}.${b.ensName}` : null
  const best = [...caps].sort((a, c) => Number(c.capability.limits.maxExecutionValue - a.capability.limits.maxExecutionValue))[0]
  const perms = [b.swapCaps.length && 'Swap', b.rebalanceCaps.length && 'Rebalance', b.payCaps.length && 'Pay'].filter(Boolean).join(' · ') || '—'
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-accent" />
          <div className="font-semibold">{agentTitle(b.ensName)}</div>
        </div>
        <Badge tone={caps.length ? 'green' : 'red'}>
          <StatusDot active={caps.length > 0} /> {caps.length ? 'Active' : 'No authority'}
        </Badge>
      </div>
      <div className="mt-4">
        <div className="text-xs text-muted">Operator</div>
        <Identity name={operatorName} address={status.data?.evmOperator ?? null} />
      </div>
      <div className="mt-3 border-t border-line pt-2">
        <Row label="Bucket">{b.ensName || '—'}</Row>
        <Row label="Authority">{best ? `${formatUsd(best.capability.limits.maxExecutionValue)} / execution` : 'none'}</Row>
        <Row label="Permissions">{perms}</Row>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button size="sm" onClick={onConfigure}>
          Configure
        </Button>
        <Button size="sm" variant="danger" disabled={!wallet || caps.length === 0} onClick={() => setStop(true)}>
          Stop
        </Button>
      </div>
      <ConfirmTx
        open={stop}
        onOpenChange={setStop}
        title={`Stop the ${agentTitle(b.ensName)}?`}
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
    </Card>
  )
}

/**
 * ERC-8004 (Trustless Agents) identity panel. Each agent's ENS name is bound to its on-chain operator address and a
 * capability manifest built from live chain state, so the agent is verifiable and discoverable — resolve the ENS
 * name, then check each skill's capability on-chain against the BUCKET controller.
 */
function AgentIdentityPanel({ bucketIds }: { bucketIds: string[] }) {
  const cards = useAgentCards()
  const mine = (cards.data ?? []).filter((c) => bucketIds.includes(c['x-bucket'].bucketId))
  if (cards.isLoading) return <Skeleton className="h-40" />
  if (mine.length === 0) return null
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Fingerprint className="h-5 w-5 text-accent" />
        <div className="font-semibold">Agent identity</div>
        <Badge tone="green">ERC-8004</Badge>
      </div>
      <p className="mt-2 text-xs text-muted">
        Each agent publishes a verifiable identity: its ENS name bound to the on-chain operator, with skills built from
        live capabilities anyone can check on-chain.
      </p>
      <div className="mt-3 space-y-3">
        {mine.map((card) => (
          <AgentIdentityRow key={card['x-bucket'].bucketId} card={card} />
        ))}
      </div>
    </Card>
  )
}

function AgentIdentityRow({ card }: { card: AgentCard }) {
  const reg = card.registrations[0]
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-sm font-medium">{reg?.ensName ?? card['x-bucket'].ensName}</div>
        <a href={card['x-bucket'].verify} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-accent hover:underline">
          AgentCard ↗
        </a>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {card.trustModels.map((t) => (
          <Badge key={t} tone="neutral">
            {t}
          </Badge>
        ))}
      </div>
      <div className="mt-2 space-y-1">
        {card.skills.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted">{s.name}</span>
            <span className="font-mono text-faint">{s['x-bucket-capability'].maxPerExecutionUsd} / exec</span>
          </div>
        ))}
        {card.skills.length === 0 ? <div className="text-xs text-faint">No live skills</div> : null}
      </div>
    </div>
  )
}

function EvmAgents({ onConfigure }: { onConfigure: () => void }) {
  const { deployment } = useApp()
  const status = useAgentStatus()
  const { buckets, isLoading } = useOwnerAgentBuckets()
  if (isLoading || !status.data) return <Skeleton className="h-96" />
  if (buckets.length === 0) return <EmptyState title="No Bucket yet">Create or join a Bucket to give an agent authority.</EmptyState>

  const usdc = deployment.evm.tokens.find((t) => t.symbol === 'USDC')
  const selections: Selection[] = buckets.map((b) => ({ network: 'sepolia', bucketId: b.bucketId }))

  // Combined quick actions across every owned Bucket. First a single chip that rebalances ALL Buckets at once
  // (one owner signature → one rebalance per Bucket), then a per-Bucket rebalance, then trading swap/pay demos.
  const rebalanceAll = buckets.flatMap((b) =>
    b.rebalanceCaps.slice(0, 1).map((c) => ({ action: 'rebalance' as const, network: 'sepolia' as const, bucketId: b.bucketId, capabilityId: c.id })),
  )
  const quick: QuickAction[] = []
  if (rebalanceAll.length > 1) quick.push({ label: `Rebalance all ${rebalanceAll.length} Buckets`, hint: 'One signature, one rebalance per Bucket', actions: rebalanceAll })
  for (const b of buckets) {
    const label = b.ensName.split('.')[0] ?? 'bucket'
    for (const c of b.rebalanceCaps.slice(0, 1)) quick.push({ label: `Rebalance ${label}`, action: { action: 'rebalance', network: 'sepolia', bucketId: b.bucketId, capabilityId: c.id } })
  }
  const trading = buckets.find((b) => b.ensName.startsWith('trading')) ?? buckets[0]
  if (trading) {
    for (const c of trading.swapCaps.slice(0, 1)) {
      quick.push({ label: 'Swap 180 USDC → ETH', action: { action: 'swap', network: 'sepolia', bucketId: trading.bucketId, capabilityId: c.id, sellSymbol: 'USDC', buySymbol: 'ETH', sellAmount: '180' } })
      quick.push({ label: 'Swap 620 USDC → ETH', hint: 'Above a $500 limit: BUCKET should block it', action: { action: 'swap', network: 'sepolia', bucketId: trading.bucketId, capabilityId: c.id, sellSymbol: 'USDC', buySymbol: 'ETH', sellAmount: '620' } })
    }
    if (usdc) for (const c of trading.payCaps.slice(0, 1)) quick.push({ label: 'Pay 10 USDC', action: { action: 'pay', network: 'sepolia', bucketId: trading.bucketId, capabilityId: c.id, symbol: 'USDC', amount: '10' } })
  }

  const primary = selections[0]
  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div className="space-y-4">
        {buckets.map((b) => (
          <AgentBucketCard key={b.bucketId} b={b} onConfigure={onConfigure} />
        ))}
        <AgentIdentityPanel bucketIds={buckets.map((b) => b.bucketId)} />
      </div>
      {primary ? (
        <AgentChat
          title="BUCKET Agents"
          selection={primary}
          selections={selections}
          aiConfigured={!!status.data.ai.configured}
          quickActions={quick}
          onConfigure={onConfigure}
        />
      ) : null}
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

