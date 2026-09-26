import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react'
import { useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
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
/** One signature that authorizes the agent across EVERY Bucket the owner holds (keyed by owner address). */
const OWNER_SESSION_KEY = (signer: string) => `bucket.autonomous.all.${signer.toLowerCase()}`

// Sessions live in sessionStorage, which is not reactive. This tiny store lets every ActionFlow re-render the moment
// a session opens or closes — so authorizing ONE action (or the "Authorize all" button) cascades the others into
// executing, instead of each card asking for its own signature.
let sessionVersion = 0
const sessionListeners = new Set<() => void>()
function bumpSession() {
  sessionVersion += 1
  for (const l of sessionListeners) l()
}
/** Re-renders the caller whenever any agent session is opened or cleared. */
export function useSessionVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      sessionListeners.add(cb)
      return () => sessionListeners.delete(cb)
    },
    () => sessionVersion,
    () => sessionVersion,
  )
}

export function targetOf(action: AgentAction): string {
  return action.action === 'sui_pay' ? action.bucketObjectId : action.bucketId
}

function readSession(key: string): Approval | null {
  try {
    const raw = window.sessionStorage.getItem(key)
    const s = raw ? (JSON.parse(raw) as Approval) : null
    return s && s.expires > Math.floor(Date.now() / 1000) + 30 ? s : null
  } catch {
    return null
  }
}

/** An owner-signed autonomous session for one Bucket, kept for this browser tab only. */
export function loadSession(target: string): Approval | null {
  return readSession(SESSION_KEY(target))
}

/** An owner-signed session covering all of `signer`'s Buckets (one signature for trading + savings + payments). */
export function loadOwnerSession(signer: string | null | undefined): Approval | null {
  return signer ? readSession(OWNER_SESSION_KEY(signer)) : null
}

/** The session that applies to an action: the all-Buckets owner session takes precedence over a per-Bucket one. */
export function sessionFor(action: AgentAction, signer: string | null | undefined): Approval | null {
  return loadOwnerSession(signer) ?? loadSession(targetOf(action))
}

export function clearSession(target: string) {
  try {
    window.sessionStorage.removeItem(SESSION_KEY(target))
  } catch {
    // ignore
  }
  bumpSession()
}

export function clearOwnerSession(signer: string | null | undefined) {
  if (!signer) return
  try {
    window.sessionStorage.removeItem(OWNER_SESSION_KEY(signer))
  } catch {
    // ignore
  }
  bumpSession()
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
    bumpSession()
    return approval
  }

  /**
   * One signature that authorizes the agent across EVERY EVM Bucket the connected wallet owns. The message binds the
   * owner address (not a single Bucket), so the server accepts it for any Bucket whose holder is this signer; the
   * chain still enforces each Bucket's capability on every execution.
   */
  async function startOwnerSession(minutes: number): Promise<Approval> {
    if (!address) throw new Error('Connect the wallet that owns these Buckets')
    const expires = Math.floor(Date.now() / 1000) + minutes * 60
    const signature = await signMessageAsync({ message: approvalMessage({ scope: 'session-all', target: address, expires }) })
    const approval: Approval = { scope: 'session-all', expires, signature, signer: address }
    window.sessionStorage.setItem(OWNER_SESSION_KEY(address), JSON.stringify(approval))
    bumpSession()
    return approval
  }

  /** The session currently applicable to an action for the connected owner (all-Buckets session preferred). */
  function currentSession(action: AgentAction): Approval | null {
    return sessionFor(action, action.network === 'sui' ? suiAccount?.address : address)
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

  return { approveAction, startSession, startOwnerSession, currentSession, execute, ownerAddress: address }
}
