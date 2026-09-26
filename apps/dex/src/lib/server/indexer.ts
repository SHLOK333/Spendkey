
import { bucketAuthorityAbi, bucketCapabilitiesAbi, bucketControllerAbi } from '@bucket/sdk'
import { decodeEventLog, type Abi, type Address, type Log } from 'viem'

import { loadDeployment } from './deployment'
import { serverEnv } from './env'
import { evmServer } from './evm'

/** A decoded protocol event, JSON-safe (bigints as decimal strings). */
export interface IndexedEvent {
  readonly contract: 'controller' | 'capabilities' | 'authority'
  readonly eventName: string
  readonly args: Record<string, unknown>
  readonly txHash: string
  readonly blockNumber: string
  readonly logIndex: number
  readonly timestamp: number | null
}

interface IndexState {
  scannedTo: bigint
  events: IndexedEvent[]
  timestamps: Map<bigint, number>
  running: Promise<void> | null
}

const g = globalThis as unknown as { __bucketIndex?: IndexState }

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]))
  }
  return value
}

async function scan(state: IndexState): Promise<void> {
  const deployment = loadDeployment()
  const { publicClient } = evmServer()
  const c = deployment.evm.contracts
  const sources: Array<{ address: Address; abi: Abi; contract: IndexedEvent['contract'] }> = [
    { address: c.controller, abi: bucketControllerAbi as Abi, contract: 'controller' },
    { address: c.capabilities, abi: bucketCapabilitiesAbi as Abi, contract: 'capabilities' },
    { address: c.authority, abi: bucketAuthorityAbi as Abi, contract: 'authority' },
  ]
  const byAddress = new Map(sources.map((s) => [s.address.toLowerCase(), s]))
  const latest = await publicClient.getBlockNumber()
  const range = serverEnv.logsBlockRange()
  const chunks: Array<[bigint, bigint]> = []
  for (let from = state.scannedTo + 1n; from <= latest; from += range) {
    const to = from + range - 1n > latest ? latest : from + range - 1n
    chunks.push([from, to])
  }

  // Free-tier RPCs cap both the block range and compute units per second: small batches, retries with backoff, and
  // progress committed after every batch so a transient failure never discards what was already indexed.
  const CONCURRENCY = 4
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(([fromBlock, toBlock]) => withRetry(() => publicClient.getLogs({ address: sources.map((s) => s.address), fromBlock, toBlock }))),
    )
    await ingest(state, results.flat(), byAddress)
    state.scannedTo = batch[batch.length - 1]![1]
  }
  state.scannedTo = latest
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 7): Promise<T> {
  let delay = 300
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i >= attempts - 1) throw error
      await new Promise((r) => setTimeout(r, delay))
      delay *= 2
    }
  }
}

async function ingest(state: IndexState, found: Log[], byAddress: Map<string, { abi: Abi; contract: IndexedEvent['contract'] }>): Promise<void> {
  if (found.length === 0) return
  const { publicClient } = evmServer()
  const blocks = [...new Set(found.map((l) => l.blockNumber!).filter((b) => !state.timestamps.has(b)))]
  for (const blockNumber of blocks) {
    const block = await withRetry(() => publicClient.getBlock({ blockNumber }))
    state.timestamps.set(blockNumber, Number(block.timestamp))
  }
  for (const log of found) {
    const source = byAddress.get(log.address.toLowerCase())
    if (!source) continue
    try {
      const decoded = decodeEventLog({ abi: source.abi, data: log.data, topics: log.topics })
      state.events.push({
        contract: source.contract,
        eventName: decoded.eventName ?? 'Unknown',
        args: jsonSafe(decoded.args ?? {}) as Record<string, unknown>,
        txHash: log.transactionHash!,
        blockNumber: log.blockNumber!.toString(),
        logIndex: log.logIndex!,
        timestamp: state.timestamps.get(log.blockNumber!) ?? null,
      })
    } catch {
      // Not a BUCKET event (e.g. an inherited library event without an ABI entry): skip.
    }
  }
  state.events.sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || b.logIndex - a.logIndex)
}

/** BUCKET protocol events since the deployment block, newest first. Incremental; while the first scan is still running
 *  this returns what is indexed so far (`indexing: true`) instead of blocking. */
export async function protocolEvents(): Promise<{ events: IndexedEvent[]; scannedTo: string; indexing: boolean }> {
  if (!g.__bucketIndex) {
    const deployment = loadDeployment()
    g.__bucketIndex = { scannedTo: BigInt(deployment.evm.startBlock) - 1n, events: [], timestamps: new Map(), running: null }
  }
  const state = g.__bucketIndex
  if (!state.running) {
    state.running = scan(state).finally(() => {
      state.running = null
    })
  }
  const done = await Promise.race([state.running.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8_000))])
  return { events: state.events, scannedTo: state.scannedTo.toString(), indexing: !done }
}
