import { z } from 'zod'

const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'decimal amount')

/**
 * The only thing an agent (LLM or UI) can produce: a structured action. It is never a transaction — the server maps
 * it onto the BUCKET SDK, validates it against the live capability and policy, and only then executes it with the
 * agent operator's own key, where the chain enforces every limit again.
 */
export const AgentActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('swap'),
    network: z.literal('sepolia'),
    bucketId: bytes32,
    capabilityId: bytes32,
    /** The asset leaving the owner's wallet. */
    sellSymbol: z.string().min(1),
    /** The asset arriving in the owner's wallet. */
    buySymbol: z.string().min(1),
    sellAmount: decimal,
  }),
  z.object({
    action: z.literal('rebalance'),
    network: z.literal('sepolia'),
    bucketId: bytes32,
    capabilityId: bytes32,
  }),
  z.object({
    action: z.literal('pay'),
    network: z.literal('sepolia'),
    bucketId: bytes32,
    capabilityId: bytes32,
    symbol: z.string().min(1),
    amount: decimal,
  }),
  z.object({
    action: z.literal('sui_pay'),
    network: z.literal('sui'),
    bucketObjectId: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    amount: decimal,
  }),
])
export type AgentAction = z.infer<typeof AgentActionSchema>

export interface PolicyCheck {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly detail: string
}

export interface BlockedReason {
  readonly title: string
  readonly message: string
  readonly requested?: string
  readonly allowed?: string
  /** Decoded protocol error name, when the chain itself rejected the dry run. */
  readonly errorName?: string
}

export interface ActionQuote {
  readonly sell: { symbol: string; amount: string } | null
  readonly buy: { symbol: string; amount: string } | null
  readonly valueUsd: string | null
  readonly route: string
}

export interface ValidationResult {
  readonly ok: boolean
  readonly action: AgentAction
  readonly checks: PolicyCheck[]
  readonly blocked: BlockedReason | null
  readonly quote: ActionQuote | null
  readonly operator: { address: string; name: string | null }
  readonly capabilityLabel: string | null
}

export interface ExecutionResult {
  readonly network: 'sepolia' | 'sui'
  readonly kind: 'swap' | 'rebalance' | 'pay' | 'sui_pay'
  /** Every transaction submitted, in order (e.g. open intent, then fill). */
  readonly transactions: Array<{ label: string; hash: string; url: string }>
  /** Executed amounts read from the on-chain receipt / Move effects — never the pre-trade quote. */
  readonly actual: {
    readonly sold: { symbol: string; amount: string } | null
    readonly bought: { symbol: string; amount: string } | null
    readonly recipient: string | null
  }
  readonly walletAfter: Array<{ symbol: string; amount: string }>
}

/** What the owner signs (an off-chain message, not a transaction) to approve one action or an autonomous session. */
export function approvalMessage(input: { scope: 'action' | 'session'; target: string; actionHash?: string; expires: number }): string {
  return input.scope === 'action'
    ? `BUCKET agent approval\nbucket: ${input.target}\naction: ${input.actionHash}\nexpires: ${input.expires}`
    : `BUCKET autonomous agent session\nbucket: ${input.target}\nexpires: ${input.expires}\nThe agent may execute only within this Bucket's on-chain authority.`
}

export const ApprovalSchema = z.object({
  scope: z.enum(['action', 'session']),
  expires: z.number().int(),
  signature: z.string().min(1),
  /** Signer address (EVM) or Sui address. */
  signer: z.string().min(1),
})
export type Approval = z.infer<typeof ApprovalSchema>

/** Canonical JSON (sorted keys) so the client and server hash the same bytes. */
export function canonicalAction(action: AgentAction): string {
  const sorted = Object.fromEntries(Object.entries(action).sort(([a], [b]) => a.localeCompare(b)))
  return JSON.stringify(sorted)
}
