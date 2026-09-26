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
const { evmServer } = await import('../src/lib/server/evm')
const { protocolEvents } = await import('../src/lib/server/indexer')
const { serverEnv } = await import('../src/lib/server/env')
const { onboardConfig, onboardFaucet } = await import('../src/lib/server/onboard')
const { register } = await import('../src/instrumentation')

const app = new Hono()

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
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
  }
})

// --- Activity: decoded protocol events from Sepolia --------------------------------------------------------
app.get('/api/activity', async (c) => {
  try {
    return c.json(await protocolEvents())
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
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
  const upstream = await fetch(serverEnv.sepoliaRpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } })
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
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 502)
  }
})

// --- Agent: chat -> single structured proposal -> schema check -> on-chain validation ----------------------
const ChatBody = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).min(1).max(40),
  selection: z.discriminatedUnion('network', [
    z.object({ network: z.literal('sepolia'), bucketId: z.string() }),
    z.object({ network: z.literal('sui'), bucketObjectId: z.string() }),
  ]),
})

const CHAT_SYSTEM = `You are a BUCKET operator agent. You decide WHAT action to propose; BUCKET decides whether you are
ALLOWED; the chain decides whether it can SETTLE. You never sign or move funds yourself.

Reply with a single JSON object: {"reply": string, "proposal": object | null}.

"reply" is short, plain language for the wallet owner: state the relevant facts from the context (balances,
allocation, limits) and what you propose.

"proposal" is null, or exactly one structured action using ONLY ids and symbols from the context:
- {"action":"swap","network":"sepolia","bucketId","capabilityId","sellSymbol","buySymbol","sellAmount"}
  The owner's wallet sells sellAmount of sellSymbol and receives buySymbol. Needs a capability with canSwap.
- {"action":"rebalance","network":"sepolia","bucketId","capabilityId"}  Needs canRebalance; BUCKET picks the leg.
- {"action":"pay","network":"sepolia","bucketId","capabilityId","symbol","amount"}  Needs canPay; goes to the fixed payee.
- {"action":"sui_pay","network":"sui","bucketObjectId","amount"}  SUI from the Sui Bucket vault to the fixed payee.
Amounts are decimal strings in token units (e.g. "180" for 180 USDC). If the user asks for more than a limit allows,
still propose exactly what they asked: BUCKET will enforce the limit and explain the block. Never invent ids.
If no capability of the agent fits the request, return proposal null and say which permission is missing.`

app.post('/api/agent/chat', async (c) => {
  const parsed = ChatBody.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
  const ai = resolveAiKey(getCookie(c, AI_COOKIE))
  if (!ai) return c.json({ error: 'No AI provider configured. Add your OpenAI key in Agents → Settings.' }, 400)

  let context: Record<string, unknown>
  try {
    context = await agentContext(parsed.data.selection)
  } catch (error) {
    return c.json({ error: `Could not load Bucket context: ${error instanceof Error ? error.message : String(error)}` }, 502)
  }

  const completion = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${ai.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ai.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CHAT_SYSTEM },
        { role: 'system', content: `Context (live chain state):\n${JSON.stringify(context)}` },
        ...parsed.data.messages,
      ],
    }),
  })
  if (!completion.ok) return c.json({ error: `OpenAI request failed (HTTP ${completion.status})` }, 502)

  const data = (await completion.json()) as { choices?: Array<{ message?: { content?: string } }> }
  let out: { reply?: unknown; proposal?: unknown }
  try {
    out = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as typeof out
  } catch {
    return c.json({ reply: 'The model returned an unreadable answer. Please rephrase.', proposal: null, validation: null })
  }
  const reply = typeof out.reply === 'string' ? out.reply : ''
  if (out.proposal == null) return c.json({ reply, proposal: null, validation: null })

  // Natural language never becomes a transaction: only a schema-valid action is considered, then validated.
  const action = AgentActionSchema.safeParse(out.proposal)
  if (!action.success) {
    return c.json({ reply, proposal: null, validation: null, note: 'The model proposed an action outside the allowed schema; it was discarded.' })
  }
  try {
    return c.json({ reply, proposal: action.data, validation: await validateAction(action.data) })
  } catch (error) {
    return c.json({ reply, proposal: action.data, validation: null, note: `Validation failed: ${error instanceof Error ? error.message : String(error)}` })
  }
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
    return c.json({ error: `Owner approval rejected: ${error instanceof Error ? error.message : String(error)}` }, 403)
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
    const text = error instanceof Error ? error.message : String(error)
    const explained = explainError(decoded?.errorName) ?? explainMoveAbort(text)
    return c.json(
      {
        status: 'failed',
        error: explained?.message ?? 'The transaction failed.',
        title: explained?.title ?? 'Execution failed',
        detail: decoded?.message ?? text.slice(0, 600),
      },
      200,
    )
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
