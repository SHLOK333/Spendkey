import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react'
import { useQueryClient } from '@tanstack/react-query'
import { keccak256, toBytes } from 'viem'
import { useConnection, useSignMessage } from 'wagmi'

import {
  approvalMessage,
  canonicalAction,
  type AgentAction,
  type Approval,
  type ExecutionResult,
  type ValidationResult,
} from '@/lib/agent/schema'

export type ExecuteResponse =
  | { status: 'executed'; validation: ValidationResult; result: ExecutionResult }
  | { status: 'blocked'; validation: ValidationResult }
  | { status: 'failed'; title: string; error: string; detail: string }

const SESSION_KEY = (target: string) => `bucket.autonomous.${target.toLowerCase()}`

export function targetOf(action: AgentAction): string {
  return action.action === 'sui_pay' ? action.bucketObjectId : action.bucketId
}

/** An owner-signed autonomous session for one Bucket, kept for this browser tab only. */
export function loadSession(target: string): Approval | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY(target))
    const s = raw ? (JSON.parse(raw) as Approval) : null
    return s && s.expires > Math.floor(Date.now() / 1000) + 30 ? s : null
  } catch {
    return null
  }
}

export function clearSession(target: string) {
  try {
    window.sessionStorage.removeItem(SESSION_KEY(target))
  } catch {
    // ignore
  }
}

export async function validateAction(action: AgentAction): Promise<ValidationResult> {
  const res = await fetch('/api/agent/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
  const body = (await res.json()) as ValidationResult & { error?: string }
  if (!res.ok) throw new Error(body.error ?? 'validation failed')
  return body
}

export function useActionRunner() {
  const { address } = useConnection()
  const { signMessageAsync } = useSignMessage()
  const dAppKit = useDAppKit()
  const suiAccount = useCurrentAccount()
  const queryClient = useQueryClient()

  async function sign(network: 'sepolia' | 'sui', message: string): Promise<{ signature: string; signer: string }> {
    if (network === 'sui') {
      if (!suiAccount) throw new Error('Connect the Sui wallet that owns this Bucket')
      const signed = await dAppKit.signPersonalMessage({ message: new TextEncoder().encode(message) })
      return { signature: signed.signature, signer: suiAccount.address }
    }
    if (!address) throw new Error('Connect the wallet that owns this Bucket')
    return { signature: await signMessageAsync({ message }), signer: address }
  }

  /** Owner approval of exactly this action (copilot). */
  async function approveAction(action: AgentAction): Promise<Approval> {
    const expires = Math.floor(Date.now() / 1000) + 300
    const message = approvalMessage({ scope: 'action', target: targetOf(action), actionHash: keccak256(toBytes(canonicalAction(action))), expires })
    const { signature, signer } = await sign(action.network, message)
    return { scope: 'action', expires, signature, signer }
  }

  /** Owner approval of a time-boxed autonomous session; the chain still bounds every execution. */
  async function startSession(network: 'sepolia' | 'sui', target: string, minutes: number): Promise<Approval> {
    const expires = Math.floor(Date.now() / 1000) + minutes * 60
    const { signature, signer } = await sign(network, approvalMessage({ scope: 'session', target, expires }))
    const approval: Approval = { scope: 'session', expires, signature, signer }
    window.sessionStorage.setItem(SESSION_KEY(target), JSON.stringify(approval))
    return approval
  }

  async function execute(action: AgentAction, approval: Approval): Promise<ExecuteResponse> {
    const res = await fetch('/api/agent/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, approval }),
    })
    const body = (await res.json()) as ExecuteResponse & { error?: string }
    await queryClient.invalidateQueries()
    if (res.status === 403 || res.status === 400) return { status: 'failed', title: 'Not approved', error: body.error ?? 'rejected', detail: body.error ?? '' }
    return body
  }

  return { approveAction, startSession, execute }
}
