import { readFileSync } from 'node:fs'
import path from 'node:path'

import { decodeBucketError } from '@bucket/sdk'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { config as loadEnv } from 'dotenv'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { formatEther } from 'viem'
import { z } from 'zod'

const repoRoot = path.resolve(process.cwd(), '../..')

// Server-only secrets (RPC URL, agent operator keys, optional OpenAI key) live in the repository's root `.env`.
// Nothing here is ever exposed to the browser: the SPA only receives what these handlers choose to return.
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true })

const { AgentActionSchema, ApprovalSchema } = await import('../src/lib/agent/schema')
const { explainError, explainMoveAbort } = await import('../src/lib/errors')
const { BlockedError, agentIdentities, executeAction, validateAction, verifyApproval } = await import('../src/lib/server/agent')
const { AI_COOKIE, resolveAiKey, sealKey } = await import('../src/lib/server/ai-key')
const { agentContext } = await import('../src/lib/server/context')
const { buildAgentCard, buildAgentCards } = await import('../src/lib/server/agent-card')
const { evmServer } = await import('../src/lib/server/evm')
const { protocolEvents } = await import('../src/lib/server/indexer')
const { redactRpc, sepoliaRpcUrls } = await import('../src/lib/server/rpc')
const { onboardConfig, onboardFaucet } = await import('../src/lib/server/onboard')
const { register } = await import('../src/instrumentation')

const app = new Hono()

// Safety net: no uncaught handler error ever reaches the browser with a provider URL (which embeds the RPC key)
// still in its message. Every explicit error response is also redacted at its own site.
app.onError((err, c) => c.json({ error: redactRpc(err instanceof Error ? err.message : String(err)) }, 500))

// --- Public deployment manifest (the single source of contract addresses; no secrets) -----------------------
app.get('/api/deployment', (c) => {
  const raw = readFileSync(path.join(repoRoot, 'deployments', 'sepolia.json'), 'utf8')
  return new Response(raw, { headers: { 'content-type': 'application/json' } })
})

// --- Onboarding: agent operator identity a new owner grants to (public; no secrets) ------------------------
app.get('/api/onboard/config', (c) => c.json(onboardConfig()))

// --- Onboarding faucet: seed a brand-new owner wallet (deployer key, testnet-only mock tokens) --------------
const FaucetBody = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'invalid address') })

app.post('/api/onboard/faucet', async (c) => {
  const parsed = FaucetBody.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  try {
    return c.json(await onboardFaucet(parsed.data.address as `0x${string}`))
  } catch (error) {
    return c.json({ error: redactRpc(error instanceof Error ? error.message : String(error)) }, 502)
  }
})

// --- Activity: decoded protocol events from Sepolia --------------------------------------------------------
app.get('/api/activity', async (c) => {
  try {
    return c.json(await protocolEvents())
  } catch (error) {
    return c.json({ error: redactRpc(error instanceof Error ? error.message : String(error)) }, 502)
  }
})

// --- Read-only Sepolia JSON-RPC proxy: keeps the RPC key server-side. Transactions are signed and broadcast
//     by the user's own wallet, never through this route. -----------------------------------------------------
const RPC_ALLOWED = new Set([
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
])

interface RpcRequest {
  jsonrpc: string
  id: unknown
  method: string
  params?: unknown
}

app.post('/api/rpc', async (c) => {
  const body = (await c.req.json()) as RpcRequest | RpcRequest[]
  const calls = Array.isArray(body) ? body : [body]
  const denied = calls.find((call) => !(typeof call?.method === 'string' && RPC_ALLOWED.has(call.method)))
  if (denied) {
    return c.json({ jsonrpc: '2.0', id: denied?.id ?? null, error: { code: -32601, message: `method ${String(denied?.method)} not allowed` } }, 200)
  }
  // Walk the configured endpoint then public fallbacks; a rate-limited (429) or failing (5xx) provider fails over
  // to the next instead of surfacing the error (and its keyed URL) to the browser.
  const payload = JSON.stringify(body)
  for (const url of sepoliaRpcUrls()) {
    const upstream = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, cache: 'no-store' }).catch(() => null)
    if (!upstream) continue
    if (upstream.status !== 429 && upstream.status < 500) {
      return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } })
    }
  }
  // Every endpoint was rate-limited or down: return a well-formed JSON-RPC error (never the raw upstream body,
  // which would leak the provider URL) so the client shows a clean "try again" instead of a transport crash.
  const rpcError = (id: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code: -32005, message: 'All RPC endpoints are rate-limited or unavailable. Please try again shortly.' } })
  return c.json(Array.isArray(body) ? calls.map((call) => rpcError(call?.id)) : rpcError(calls[0]?.id), 200)
})

// --- Agent: public operator identities + whether an AI provider is set -------------------------------------
app.get('/api/agent/status', async (c) => {
  const ids = agentIdentities()
  const ai = resolveAiKey(getCookie(c, AI_COOKIE))
  const gas = ids.evm ? formatEther(await evmServer().publicClient.getBalance({ address: ids.evm as `0x${string}` })) : null
  return c.json({
    evmOperator: ids.evm,
    evmOperatorGasEth: gas,
    suiOperator: ids.sui,
    ai: { configured: !!ai, source: ai?.source ?? null, model: ai?.model ?? null },
  })
})

// --- Agent: bring-your-own-key management (encrypted httpOnly cookie; key never logged or echoed) -----------
const KeyBody = z.object({ apiKey: z.string().min(20).max(300), model: z.string().min(1).max(80) })

app.get('/api/agent/key', (c) => {
  const k = resolveAiKey(getCookie(c, AI_COOKIE))
  return c.json({ configured: !!k, source: k?.source ?? null, model: k?.model ?? null })
})

app.post('/api/agent/key', async (c) => {
  const parsed = KeyBody.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'invalid key or model' }, 400)
  const probe = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${parsed.data.apiKey}` } })
  if (!probe.ok) return c.json({ error: `OpenAI rejected the key (HTTP ${probe.status})` }, 400)
  setCookie(c, AI_COOKIE, sealKey(parsed.data), {
    httpOnly: true,
    sameSite: 'Strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.json({ configured: true, source: 'byok', model: parsed.data.model })
})

app.delete('/api/agent/key', (c) => {
  deleteCookie(c, AI_COOKIE, { path: '/' })
  return c.json({ configured: false })
})

// --- Agent: validate a proposed action against on-chain limits ---------------------------------------------
app.post('/api/agent/validate', async (c) => {
  const parsed = AgentActionSchema.safeParse((await c.req.json())?.action)
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  try {
    return c.json(await validateAction(parsed.data))
  } catch (error) {
    return c.json({ error: redactRpc(error instanceof Error ? error.message : String(error)) }, 502)
  }
})

// --- Agent: chat -> one or more structured proposals -> schema check -----------------------------------------
// The chat can be scoped to a single Bucket (`selection`) or to EVERY Bucket the owner holds (`selections`), so one
// conversation drives the trading, savings and payments agents at once. The model routes each request to the right
// Bucket by choosing its bucketId + capabilityId from the context. Each returned action is re-validated client-side
// (ActionFlow) and again on-chain before it can settle.
const SelectionSchema = z.discriminatedUnion('network', [
  z.object({ network: z.literal('sepolia'), bucketId: z.string() }),
  z.object({ network: z.literal('sui'), bucketObjectId: z.string() }),
])
const ChatBody = z
  .object({
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).min(1).max(40),
    selection: SelectionSchema.optional(),
    selections: z.array(SelectionSchema).min(1).max(8).optional(),
  })
  .refine((d) => d.selection || (d.selections && d.selections.length > 0), 'a selection is required')

const CHAT_SYSTEM = `You are the BUCKET operator agent. You may govern SEVERAL Buckets at once (e.g. trading, savings,
payments) — each Bucket in the context is a separate agent with its own capabilities. You decide WHAT action to
propose; BUCKET decides whether you are ALLOWED; the chain decides whether it can SETTLE. You never sign or move
funds yourself.

Reply with a single JSON object: {"reply": string, "proposals": object[]}.

"reply" is short, plain language for the wallet owner: state the relevant facts from the context (balances,
allocation, limits) and what you propose, naming the Bucket by its ensName when several exist.

"proposals" is an array of 0, 1 or MORE structured actions. Return several when the user asks to act on multiple
Buckets (e.g. "rebalance all my buckets" -> one rebalance per Bucket that needs it). Each action uses ONLY ids and
symbols from the context, and every bucketId/capabilityId MUST belong to the SAME Bucket entry in the context:
- {"action":"swap","network":"sepolia","bucketId","capabilityId","sellSymbol","buySymbol","sellAmount"}
  The owner's wallet sells sellAmount of sellSymbol and receives buySymbol. Needs a capability with canSwap.
- {"action":"rebalance","network":"sepolia","bucketId","capabilityId"}  Needs canRebalance; BUCKET picks the leg.
- {"action":"pay","network":"sepolia","bucketId","capabilityId","symbol","amount"}  Needs canPay; goes to the fixed payee.
- {"action":"sui_pay","network":"sui","bucketObjectId","amount"}  SUI from the Sui Bucket vault to the fixed payee.
Amounts are decimal strings in token units (e.g. "180" for 180 USDC). If the user asks for more than a limit allows,
still propose exactly what they asked: BUCKET will enforce the limit and explain the block. Never invent ids. If no
capability fits the request, return an empty "proposals" array and say which permission or Bucket is missing.`

app.post('/api/agent/chat', async (c) => {
  const parsed = ChatBody.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  const ai = resolveAiKey(getCookie(c, AI_COOKIE))
  if (!ai) return c.json({ error: 'No AI provider configured. Add your OpenAI key in Agents → Settings.' }, 400)

  const selections = parsed.data.selections ?? [parsed.data.selection!]
  let contexts: Array<Record<string, unknown>>
  try {
    contexts = await Promise.all(selections.map((s) => agentContext(s)))
  } catch (error) {
    return c.json({ error: redactRpc(`Could not load Bucket context: ${error instanceof Error ? error.message : String(error)}`) }, 502)
  }
  // A single Bucket is still sent as one context object so the prompt is unchanged for the common case.
  const contextPayload = contexts.length === 1 ? contexts[0] : { buckets: contexts }

  const completion = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${ai.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ai.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CHAT_SYSTEM },
        { role: 'system', content: `Context (live chain state):\n${JSON.stringify(contextPayload)}` },
        ...parsed.data.messages,
      ],
    }),
  })
  if (!completion.ok) return c.json({ error: `OpenAI request failed (HTTP ${completion.status})` }, 502)

  const data = (await completion.json()) as { choices?: Array<{ message?: { content?: string } }> }
  let out: { reply?: unknown; proposal?: unknown; proposals?: unknown }
  try {
    out = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as typeof out
  } catch {
    return c.json({ reply: 'The model returned an unreadable answer. Please rephrase.', proposals: [] })
  }
  const reply = typeof out.reply === 'string' ? out.reply : ''
  // Accept either the array form or a single "proposal" (models sometimes fall back to it).
  const raw = Array.isArray(out.proposals) ? out.proposals : out.proposal != null ? [out.proposal] : []

  // Natural language never becomes a transaction: only schema-valid actions survive; the rest are discarded.
  const proposals: unknown[] = []
  let discarded = 0
  for (const p of raw) {
    const action = AgentActionSchema.safeParse(p)
    if (action.success) proposals.push(action.data)
    else discarded++
  }
  const note = discarded > 0 ? `${discarded} proposed action(s) were outside the allowed schema and discarded.` : undefined
  return c.json({ reply, proposals, ...(note ? { note } : {}) })
})

// --- Agent: execute an owner-approved action (approval verified, limits enforced, then settle) --------------
const ExecuteBody = z.object({ action: AgentActionSchema, approval: ApprovalSchema })

app.post('/api/agent/execute', async (c) => {
  const parsed = ExecuteBody.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  const { action, approval } = parsed.data
  try {
    await verifyApproval(action, approval)
  } catch (error) {
    return c.json({ error: redactRpc(`Owner approval rejected: ${error instanceof Error ? error.message : String(error)}`) }, 403)
  }
  try {
    const { validation, result } = await executeAction(action)
    return c.json({ status: 'executed', validation, result })
  } catch (error) {
    if (error instanceof BlockedError) {
      return c.json({ status: 'blocked', validation: error.validation })
    }
    // Validation passed but the chain rejected at submission (e.g. state changed in between): report it plainly.
    const decoded = decodeBucketError(error)
    const text = redactRpc(error instanceof Error ? error.message : String(error))
    const explained = explainError(decoded?.errorName) ?? explainMoveAbort(text)
    return c.json(
      {
        status: 'failed',
        error: explained?.message ?? 'The transaction failed.',
        title: explained?.title ?? 'Execution failed',
        detail: redactRpc(decoded?.message ?? text.slice(0, 600)),
      },
      200,
    )
  }
})

// --- ERC-8004 agent identity (AgentCards) -------------------------------------------------------------------
// Each BUCKET operator agent publishes a verifiable identity: its ENSv2 name bound to the on-chain operator
// address, plus a capability manifest (skills) built from LIVE chain state. Counterparties resolve the ENS
// name and verify each skill's capability on-chain — the card never claims authority the chain doesn't grant.
function originOf(reqUrl: string): string {
  const u = new URL(reqUrl)
  return `${u.protocol}//${u.host}`
}

app.get('/api/agent/card', async (c) => {
  const bucketId = c.req.query('bucketId')
  const origin = originOf(c.req.url)
  try {
    if (bucketId) return c.json(await buildAgentCard(bucketId, origin))
    return c.json({ cards: await buildAgentCards(origin) })
  } catch (error) {
    return c.json({ error: redactRpc(error instanceof Error ? error.message : String(error)) }, 500)
  }
})

// A2A well-known location: serves the primary (first manifest) Bucket agent's card for auto-discovery.
app.get('/.well-known/agent-card.json', async (c) => {
  const origin = originOf(c.req.url)
  try {
    const cards = await buildAgentCards(origin)
    if (!cards[0]) return c.json({ error: 'no agent available' }, 404)
    return c.json(cards[0])
  } catch (error) {
    return c.json({ error: redactRpc(error instanceof Error ? error.message : String(error)) }, 500)
  }
})

// --- Static SPA (production only; in dev Vite serves the client and proxies /api here) ---------------------
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist' }))
  app.get('/*', serveStatic({ path: './dist/index.html' }))
}

const port = Number(process.env.PORT ?? 3101)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[BUCKET] API server listening on http://localhost:${info.port}`)
})

// Keep the on-chain reference price feed fresh so demo swaps never fail with BucketMathPriceStale.
void register().catch((e: unknown) => console.warn('[BUCKET] price refresh setup failed:', e instanceof Error ? e.message : String(e)))
