import { motion } from 'framer-motion'
import { Activity, Boxes, Gauge, LineChart, Sparkles, TrendingDown, TrendingUp, Waves, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits } from 'viem'

import { ConnectWallet } from '@/components/connect'
import { ActionFlow, type ActionOutcome, type ActionPhase } from '@/components/execution'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Badge, Card, EmptyState, Segmented } from '@/components/ui/primitives'
import type { AgentAction } from '@/lib/agent/schema'
import { useOwnerWallet } from '@/lib/client/app'
import { useOwnerAgentBuckets, useWalletAssets } from '@/lib/client/queries'

// ─────────────────────────────────────────────────────────────────────────────
// RALE — Risk-Adaptive Liquidity Engine
//
// The maker publishes NOT a static curve P=f(q) but a state-dependent executable policy P=f(q, S_t):
//   reservation price   P*  = P_t · (1 − λ·I_t)
//   executable spread   s_t = s0 + α·σ_t + β·|I_t|
//   execution price     P(q, S_t) = P* ± P_t·( s_t/2 + η·|q|/L )
// with state S_t = (B_A, B_B, I_t, σ_t, L_t). All inputs are REAL: P_t and inventory come from the
// protocol's on-chain reference feed + the connected wallet's live balances; σ_t is the volatility observed
// from sampled mid prices this session. Settlement (when a Swap capability exists) routes through the same
// real 1inch Aqua + BUCKET SwapVM (0xd0→0xd3) rails the rest of the app uses — nothing here is simulated.
// ─────────────────────────────────────────────────────────────────────────────

const ETA_DEFAULT = 0.4
const PREVIEW_PRICE = 2500 // used only for the unconnected preview; clearly labelled "not live"

type Side = 'ask' | 'bid'

interface Params {
  s0: number // base spread (fraction of mid)
  lambda: number // inventory-risk coefficient (reservation skew)
  alpha: number // volatility sensitivity (multiplier on σ_t)
  beta: number // inventory sensitivity (spread widening with |I_t|)
  L: number // strategy liquidity depth, in base units
  eta: number // size-impact coefficient
}

const DEFAULTS: Params = { s0: 0.001, lambda: 0.03, alpha: 1.2, beta: 0.02, L: 5, eta: ETA_DEFAULT }

/** Half of the executable spread at a given inventory (fraction of mid). */
function halfSpread(p: Params, sigma: number, inventory: number): number {
  return (p.s0 + p.alpha * sigma + p.beta * Math.abs(inventory)) / 2
}

/** Executable price for a trade of size q (base units) on the given side. */
function execPrice(p: Params, mid: number, sigma: number, inventory: number, q: number, side: Side): number {
  const reservation = mid * (1 - p.lambda * inventory)
  const edge = mid * (halfSpread(p, sigma, inventory) + (p.L > 0 ? p.eta * Math.abs(q) / p.L : 0))
  return side === 'ask' ? reservation + edge : reservation - edge
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
const fmtPct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`
const fmtBps = (x: number) => `${Math.round(x * 10000)} bps`
const fmtNum = (x: number, d = 2) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const usd = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ── cohesive cool palette: deep indigo → periwinkle → cyan (lime reserved for the live marker) ──
const S0: [number, number, number] = [30, 33, 74]
const S1: [number, number, number] = [111, 121, 255]
const S2: [number, number, number] = [94, 240, 255]
const lerp3 = (a: [number, number, number], b: [number, number, number], f: number): [number, number, number] => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
function surfaceRGB(t: number): [number, number, number] {
  const x = clamp(t, 0, 1)
  return x < 0.5 ? lerp3(S0, S1, x / 0.5) : lerp3(S1, S2, (x - 0.5) / 0.5)
}
const shade = (rgb: [number, number, number], light: number) => `rgb(${rgb.map((v) => Math.round(clamp(v * light, 0, 255))).join(',')})`

/**
 * Smoothly tweens a series of values toward `target` whenever `sig` changes — the surface *morphs* between
 * states instead of snapping. Runs off requestAnimationFrame with easeOutCubic.
 */
function useMorph(target: number[], sig: number, ms = 450): number[] {
  const [disp, setDisp] = useState<number[]>(target)
  const dispRef = useRef<number[]>(target)
  dispRef.current = disp
  const raf = useRef<number | null>(null)
  useEffect(() => {
    const from = dispRef.current
    const to = target
    const start = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      setDisp(to.map((v, i) => {
        const f = from[i] ?? v
        return f + (v - f) * e
      }))
      if (k < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  return disp
}

// ── slider ───────────────────────────────────────────────────────────────────

function Slider({
  label,
  symbol,
  value,
  min,
  max,
  step,
  onChange,
  format,
  tint = 'var(--color-accent)',
}: {
  label: string
  symbol: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format: (v: number) => string
  tint?: string
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm text-muted">
          {label} <span className="ml-1 font-mono text-xs text-faint">{symbol}</span>
        </span>
        <span className="font-mono text-sm font-semibold tabular text-fg">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rale-slider w-full"
        style={{ background: `linear-gradient(90deg, ${tint} ${pct}%, var(--color-line) ${pct}%)` }}
      />
    </div>
  )
}

// ── stat card ─────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, tint, glow }: { label: string; value: string; sub?: string; tint?: string; glow?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-2xl border border-line bg-panel-2/70 px-4 py-3"
    >
      {glow ? <div className="pointer-events-none absolute -right-6 -top-6 h-16 w-16 rounded-full opacity-40 blur-2xl" style={{ background: tint }} /> : null}
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-1 font-mono text-xl font-bold tabular text-fg" style={tint ? { color: tint } : undefined}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-xs text-muted">{sub}</div> : null}
    </motion.div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// HERO — 3D isometric execution-cost surface
//
// z = |P(q, Sₜ) − Pₜ| / Pₜ  — the taker's edge (cost) across the (trade size q) × (inventory Iₜ) plane.
// A valley at the centre (small size, balanced book) rising into walls as size grows or the book skews;
// risk aversion λ tilts the whole surface toward the side the maker wants to unload. Every slider reshapes it.
// ═══════════════════════════════════════════════════════════════════════════════

function CostSurface({ params, mid, sigma, inventory, qmax, size, side }: { params: Params; mid: number; sigma: number; inventory: number; qmax: number; size: number; side: Side }) {
  const W = 760
  const H = 440
  const cols = 26
  const rows = 20
  const cx = 372
  const cy = 268
  const ax = 286
  const ay = 116
  const hz = 140

  const { flat, zmax } = useMemo(() => {
    const raw: number[] = []
    let mx = 1e-9
    for (let r = 0; r < rows; r++) {
      const inv = -1 + (r / (rows - 1)) * 2
      for (let c = 0; c < cols; c++) {
        const q = (c / (cols - 1)) * qmax
        const cost = Math.abs(execPrice(params, mid, sigma, inv, q, side) - mid) / (mid || 1)
        raw.push(cost)
        if (cost > mx) mx = cost
      }
    }
    return { flat: raw.map((v) => v / mx), zmax: mx }
  }, [params, mid, sigma, qmax, side])

  const sig = params.s0 * 1e4 + params.lambda * 1e3 + params.alpha * 100 + params.beta * 1e3 + params.L + params.eta * 100 + mid + sigma * 1e4 + inventory * 100 + qmax + (side === 'ask' ? 0 : 7)
  const z = useMorph(flat, sig)
  const at = (r: number, c: number) => z[r * cols + c] ?? flat[r * cols + c] ?? 0

  const proj = (gx: number, gy: number, t: number): [number, number] => {
    const u = gx - 0.5
    const v = gy - 0.5
    return [cx + (u - v) * ax, cy + (u + v) * ay - t * hz]
  }

  const quads = useMemo(() => {
    const out: Array<{ pts: string; depth: number; fill: string }> = []
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const t00 = at(r, c)
        const t01 = at(r, c + 1)
        const t11 = at(r + 1, c + 1)
        const t10 = at(r + 1, c)
        const P = [
          proj(c / (cols - 1), r / (rows - 1), t00),
          proj((c + 1) / (cols - 1), r / (rows - 1), t01),
          proj((c + 1) / (cols - 1), (r + 1) / (rows - 1), t11),
          proj(c / (cols - 1), (r + 1) / (rows - 1), t10),
        ]
        const tAvg = (t00 + t01 + t11 + t10) / 4
        const light = clamp(1 + (t10 - t00) * 1.1, 0.72, 1.28) // fake directional shading along the size axis
        out.push({ pts: P.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '), depth: r + c, fill: shade(surfaceRGB(tAvg), light) })
      }
    }
    out.sort((a, b) => a.depth - b.depth) // painter's algorithm: back to front
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [z, qmax])

  // live operating point on the surface
  const gxm = Math.min(size, qmax) / (qmax || 1)
  const gym = (inventory + 1) / 2
  const execPx = execPrice(params, mid, sigma, inventory, Math.min(size, qmax), side)
  const costm = Math.abs(execPx - mid) / (mid || 1)
  const tm = clamp(costm / zmax, 0, 1.05)
  const [mx1, my1] = proj(gxm, gym, tm)
  const [mx0, my0] = proj(gxm, gym, 0)

  const [qlx, qly] = proj(0.9, 1, 0)
  const [ilx, ily] = proj(0, 0.9, 0)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'auto' }} preserveAspectRatio="xMidYMid meet">
      <defs>
        <filter id="raleGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id="floorGlow" cx="50%" cy="70%" r="60%">
          <stop offset="0%" stopColor="#6f79ff" stopOpacity="0.20" />
          <stop offset="100%" stopColor="#6f79ff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x={0} y={0} width={W} height={H} fill="url(#floorGlow)" />

      <motion.g animate={{ y: [0, -5, 0] }} transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}>
        {quads.map((qd, i) => (
          <polygon key={i} points={qd.pts} fill={qd.fill} fillOpacity={0.92} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} strokeLinejoin="round" />
        ))}

        {/* operating point */}
        <line x1={mx0} y1={my0} x2={mx1} y2={my1} stroke="#c6f24e" strokeWidth={1.4} strokeDasharray="3 3" opacity={0.7} />
        <circle cx={mx0} cy={my0} r={3} fill="#c6f24e" opacity={0.45} />
        <motion.circle cx={mx1} cy={my1} r={7} fill="#c6f24e" filter="url(#raleGlow)" animate={{ r: [6, 9, 6] }} transition={{ duration: 1.6, repeat: Infinity }} />
        <text x={mx1} y={my1 - 16} textAnchor="middle" fontSize={12} fontWeight={700} fill="#c6f24e" fontFamily="var(--font-mono)">
          {fmtBps(costm)}
        </text>
        <text x={mx1} y={my1 - 30} textAnchor="middle" fontSize={10} fill="#9297a6">
          taker edge
        </text>
      </motion.g>

      {/* axes */}
      <text x={qlx + 10} y={qly + 20} fontSize={11} fill="#9297a6" fontWeight={500}>size q →</text>
      <text x={ilx - 12} y={ily + 16} textAnchor="end" fontSize={11} fill="#9297a6" fontWeight={500}>← inventory Iₜ</text>
      <text x={cx} y={30} textAnchor="middle" fontSize={11} fill="#5b5f6e">height = execution cost |P(q,Sₜ) − Pₜ| / Pₜ</text>
    </svg>
  )
}

// ── SwapVM pipeline ────────────────────────────────────────────────────────────

const PIPELINE = [
  { op: '0xd0', name: 'InventoryState', icon: Activity },
  { op: '', name: 'RiskAdjustment', icon: Gauge },
  { op: '0xd1', name: 'Spread', icon: Waves },
  { op: '0xd2', name: 'SizeImpact', icon: TrendingUp },
  { op: '', name: 'AdaptiveCurve', icon: LineChart },
  { op: '0xd3', name: 'Settlement', icon: Zap },
]

export type PipeState = 'idle' | 'running' | 'done' | 'blocked'

const PIPE_STATUS: Record<PipeState, { label: string; tint: string }> = {
  idle: { label: 'idle', tint: '#5b5f6e' },
  running: { label: 'executing…', tint: '#5ef0ff' },
  done: { label: 'settled', tint: '#c6f24e' },
  blocked: { label: 'blocked', tint: '#f87171' },
}

function nodeTint(hasOp: boolean, state: PipeState): string {
  if (state === 'done') return '#c6f24e'
  if (state === 'blocked') return '#f87171'
  return hasOp ? '#c6f24e' : '#8b93ff'
}

/**
 * The live SwapVM execution program. Idle: a soft glow drifts through the stages (the engine "idling"). Running:
 * a bright packet sweeps the whole pipeline and every connector flows — the taker's order moving through
 * 0xd0→0xd3. Done: the whole chain latches green (settled). Blocked: it goes red (a guard rejected it).
 */
function Pipeline({ state = 'idle' }: { state?: PipeState }) {
  const n = PIPELINE.length
  const [head, setHead] = useState(0)
  useEffect(() => {
    if (state === 'done' || state === 'blocked') return
    const period = state === 'running' ? 240 : 700
    const id = setInterval(() => setHead((h) => (h + 1) % n), period)
    return () => clearInterval(id)
  }, [state, n])

  const terminal = state === 'done' || state === 'blocked'
  const status = PIPE_STATUS[state]

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PIPELINE.map((s, i) => {
        const active = !terminal && i === head
        const trail = !terminal && i === (head - 1 + n) % n
        const lit = terminal || active || trail
        const tint = nodeTint(!!s.op, state)
        const connFlow = state === 'running' || (state === 'idle' && i === head)
        return (
          <div key={s.name} className="contents">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{
                opacity: state === 'blocked' && i < n - 1 ? 0.45 : 1,
                scale: active ? 1.07 : 1,
                borderColor: lit ? tint : 'var(--color-line)',
                boxShadow: active
                  ? `0 0 18px ${tint}77`
                  : state === 'done'
                    ? `0 0 10px ${tint}44`
                    : '0 0 0px rgba(0,0,0,0)',
              }}
              transition={{ duration: 0.28 }}
              className="flex items-center gap-1.5 rounded-lg border bg-panel-2 px-2.5 py-1.5"
            >
              <motion.span animate={{ color: lit ? tint : 'var(--color-muted)' }} transition={{ duration: 0.28 }} className="flex">
                <s.icon className="h-3.5 w-3.5" />
              </motion.span>
              <span className="text-[11px] font-medium" style={{ color: lit ? 'var(--color-fg)' : 'var(--color-muted)' }}>
                {s.name}
              </span>
              {s.op ? <span className="font-mono text-[10px]" style={{ color: lit ? tint : 'var(--color-faint)' }}>{s.op}</span> : null}
            </motion.div>
            {i < n - 1 ? (
              <div className="relative h-[2px] w-5 shrink-0 overflow-hidden rounded-full" style={{ background: 'var(--color-line)' }}>
                <motion.div
                  className="absolute inset-y-0 left-0 w-2.5 rounded-full"
                  style={{ background: tint }}
                  animate={connFlow ? { x: ['-10px', '20px'], opacity: [0, 1, 0] } : state === 'done' ? { x: '18px', opacity: 0.6 } : { x: '-10px', opacity: 0 }}
                  transition={connFlow ? { duration: 0.5, repeat: Infinity, ease: 'linear', delay: i * 0.04 } : { duration: 0.3 }}
                />
              </div>
            ) : null}
          </div>
        )
      })}
      <motion.span
        className="ml-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
        animate={{ color: status.tint, backgroundColor: `${status.tint}1a` }}
        transition={{ duration: 0.28 }}
      >
        <motion.span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: status.tint }}
          animate={state === 'running' ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
          transition={state === 'running' ? { duration: 0.9, repeat: Infinity } : { duration: 0.2 }}
        />
        {status.label}
      </motion.span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function RalePage() {
  const { address } = useOwnerWallet()
  const wallet = useWalletAssets(address)
  const { buckets } = useOwnerAgentBuckets()

  const [params, setParams] = useState<Params>(DEFAULTS)
  const [side, setSide] = useState<Side>('ask')
  const [size, setSize] = useState<number>(DEFAULTS.L * 0.04)
  const [base, setBase] = useState('ETH')
  const [quote, setQuote] = useState('USDC')
  const [review, setReview] = useState<AgentAction | null>(null)
  const [pipe, setPipe] = useState<PipeState>('idle')
  const [history, setHistory] = useState<number[]>([])
  const baseline = useRef<number | null>(null)

  // Drive the SwapVM pipeline animation from the real execution phase inside the dialog.
  const onExecPhase = (phase: ActionPhase, outcome: ActionOutcome) => {
    if (phase === 'done') setPipe(outcome === 'executed' ? 'done' : 'blocked')
    else if (phase === 'review') setPipe('idle')
    else setPipe('running') // validating · signing · executing
  }

  const set = <K extends keyof Params>(k: K, v: number) => setParams((p) => ({ ...p, [k]: v }))

  // ── live on-chain state ──
  const assets = wallet.data ?? []
  const priceOf = (sym: string) => {
    const a = assets.find((x) => x.symbol === sym)
    return a && a.priceWad > 0n ? Number(formatUnits(a.priceWad, 18)) : 0
  }
  const valueOf = (sym: string) => {
    const a = assets.find((x) => x.symbol === sym)
    return a ? Number(formatUnits(a.valueWad, 18)) : 0
  }
  const live = assets.length > 0 && priceOf(base) > 0 && priceOf(quote) > 0
  const mid = live ? priceOf(base) / priceOf(quote) : PREVIEW_PRICE
  const vBase = valueOf(base)
  const vQuote = valueOf(quote)
  const inventory = vBase + vQuote > 0 ? (vBase - vQuote) / (vBase + vQuote) : 0

  // observed volatility from sampled mids this session (std-dev of log returns)
  const sigma = useMemo(() => {
    const h = history.slice(-40)
    if (h.length < 3) return 0
    const rets: number[] = []
    for (let i = 1; i < h.length; i++) {
      const a = h[i - 1]!
      const b = h[i]!
      if (a > 0 && b > 0) rets.push(Math.log(b / a))
    }
    if (rets.length < 2) return 0
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length
    const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length
    return Math.sqrt(varr)
  }, [history])

  // sample mid on an interval (real observed data; flat when the oracle is stable)
  useEffect(() => {
    if (!live) return
    setHistory((h) => (h.length === 0 ? [mid] : h))
    const id = setInterval(() => setHistory((h) => [...h.slice(-79), mid]), 4000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, mid])

  // PnL vs session baseline (mark-to-market of the base+quote inventory)
  const totalValue = vBase + vQuote
  useEffect(() => {
    if (live && baseline.current === null && totalValue > 0) baseline.current = totalValue
  }, [live, totalValue])
  const pnl = baseline.current !== null ? totalValue - baseline.current : 0

  const sTot = params.s0 + params.alpha * sigma + params.beta * Math.abs(inventory)
  const qmax = Math.max(params.L, size * 1.5, 0.001)

  // keep size within [0, L]
  useEffect(() => {
    if (size > params.L) setSize(Number((params.L * 0.5).toFixed(4)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.L])

  // execution wiring — real swap through a Bucket's Swap capability (Aqua + SwapVM)
  const execBucket = buckets.find((b) => b.swapCaps.length > 0)
  const execCap = execBucket?.swapCaps[0]
  const execPx = execPrice(params, mid, sigma, inventory, size, side)
  const notionalUsd = size * priceOf(base)
  const maxExecWad = execCap?.limits?.maxExecutionValue ?? null
  const overLimit = maxExecWad !== null ? notionalUsd > Number(formatUnits(maxExecWad, 18)) : false
  const canExecute = live && !!execBucket && !!execCap && size > 0 && !overLimit
  const buildAction = (): AgentAction | null => {
    if (!execBucket || !execCap) return null
    // ask = taker buys base with quote (sell quote); bid = taker sells base for quote (sell base)
    const sellSymbol = side === 'ask' ? quote : base
    const buySymbol = side === 'ask' ? base : quote
    const sellAmount = side === 'ask' ? (size * mid).toFixed(2) : size.toFixed(6)
    return { action: 'swap', network: 'sepolia', bucketId: execBucket.bucketId, capabilityId: execCap.id, sellSymbol, buySymbol, sellAmount }
  }

  const baseOpts = ['ETH', 'WBTC', 'SUI']
  const quoteOpts = ['USDC', 'USDT', 'DAI', 'EURC']

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/15 text-accent">
              <Sparkles className="h-5 w-5" />
            </span>
            <h1 className="text-2xl font-bold tracking-tight">RALE</h1>
            <Badge tone="green">Risk-Adaptive Liquidity</Badge>
            {live ? <Badge tone="blue">live on-chain</Badge> : <Badge tone="amber">preview — connect for live</Badge>}
          </div>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            A state-dependent executable policy <span className="font-mono text-fg">P = f(q, S&#8348;)</span> — the maker&apos;s price adapts to inventory, volatility and trade size, then settles through 1inch Aqua + BUCKET SwapVM.
          </p>
        </div>
        <ConnectWallet />
      </div>

      {/* live state strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Mid  P_t" value={fmtNum(mid, 2)} sub={`${base}/${quote}`} tint="#eaf0ff" />
        <Stat label="Inventory  I_t" value={`${inventory >= 0 ? '+' : ''}${fmtPct(inventory, 1)}`} sub={inventory >= 0 ? 'net long base' : 'net short base'} tint="#8b93ff" glow />
        <Stat label="Volatility  σ_t" value={fmtPct(sigma, 2)} sub="session-observed" tint="#5ef0ff" />
        <Stat label="Spread  s_t" value={fmtBps(sTot)} sub={`½ = ${fmtBps(sTot / 2)}`} tint="#c6f24e" glow />
        <Stat label="Depth  L_t" value={`${fmtNum(params.L, 1)}`} sub={`${base} units`} tint="#eaf0ff" />
        <Stat label="PnL_t" value={`${pnl >= 0 ? '+' : ''}${usd(pnl)}`} sub="vs session start" tint={pnl >= 0 ? '#c6f24e' : '#f87171'} glow />
      </div>

      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        {/* ── controls ── */}
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-semibold">Pair</span>
              <div className="flex items-center gap-2">
                <select value={base} onChange={(e) => setBase(e.target.value)} className="rounded-lg border border-line bg-panel-2 px-2 py-1 text-sm font-semibold outline-none">
                  {baseOpts.map((o) => <option key={o} value={o} style={{ background: '#16171d' }}>{o}</option>)}
                </select>
                <span className="text-muted">/</span>
                <select value={quote} onChange={(e) => setQuote(e.target.value)} className="rounded-lg border border-line bg-panel-2 px-2 py-1 text-sm font-semibold outline-none">
                  {quoteOpts.map((o) => <option key={o} value={o} style={{ background: '#16171d' }}>{o}</option>)}
                </select>
              </div>
            </div>

            <div className="space-y-4">
              <Slider label="Base spread" symbol="s₀" value={params.s0} min={0} max={0.005} step={0.0001} onChange={(v) => set('s0', v)} format={fmtBps} tint="#c6f24e" />
              <Slider label="Risk aversion" symbol="λ" value={params.lambda} min={0} max={0.08} step={0.001} onChange={(v) => set('lambda', v)} format={(v) => fmtPct(v, 1)} tint="#8b93ff" />
              <Slider label="Volatility sens." symbol="α" value={params.alpha} min={0} max={4} step={0.05} onChange={(v) => set('alpha', v)} format={(v) => `${v.toFixed(2)}×`} tint="#5ef0ff" />
              <Slider label="Inventory sens." symbol="β" value={params.beta} min={0} max={0.05} step={0.001} onChange={(v) => set('beta', v)} format={(v) => fmtPct(v, 1)} tint="#8b93ff" />
              <Slider label="Liquidity depth" symbol="L" value={params.L} min={0.5} max={50} step={0.5} onChange={(v) => set('L', v)} format={(v) => v.toFixed(1)} tint="#5ef0ff" />
              <Slider label="Size impact" symbol="η" value={params.eta} min={0} max={1} step={0.01} onChange={(v) => set('eta', v)} format={(v) => v.toFixed(2)} tint="#c6f24e" />
            </div>

            <button className="mt-4 w-full rounded-lg border border-line py-1.5 text-xs text-muted transition-colors hover:bg-white/5" onClick={() => setParams(DEFAULTS)}>
              Reset to defaults
            </button>
          </Card>

          {/* execution */}
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold">Execute</span>
              <Segmented
                value={side}
                onChange={setSide}
                options={[
                  { value: 'ask', label: <span className="inline-flex items-center gap-1"><TrendingUp className="h-3.5 w-3.5" /> Buy</span> },
                  { value: 'bid', label: <span className="inline-flex items-center gap-1"><TrendingDown className="h-3.5 w-3.5" /> Sell</span> },
                ]}
              />
            </div>
            <Slider label="Trade size" symbol="q" value={size} min={0} max={params.L} step={params.L / 200} onChange={setSize} format={(v) => `${v.toFixed(4)} ${base}`} tint={side === 'ask' ? '#8b93ff' : '#c6f24e'} />
            <div className="mt-3 space-y-1.5 rounded-xl border border-line bg-panel-2 p-3 text-sm">
              <div className="flex justify-between"><span className="text-muted">Execution price</span><span className="font-mono font-semibold" style={{ color: side === 'ask' ? '#b9c0ff' : '#c6f24e' }}>{execPx.toFixed(2)} {quote}</span></div>
              <div className="flex justify-between"><span className="text-muted">vs mid</span><span className="font-mono">{((execPx / mid - 1) * 100 >= 0 ? '+' : '')}{((execPx / mid - 1) * 100).toFixed(3)}%</span></div>
              <div className="flex justify-between"><span className="text-muted">Notional</span><span className="font-mono">{live ? usd(notionalUsd) : '—'}</span></div>
            </div>
            <Button
              variant="primary"
              className="mt-3 h-12 w-full rounded-xl text-[15px] font-bold"
              disabled={!canExecute}
              onClick={() => setReview(buildAction())}
            >
              {!live ? 'Connect wallet' : !execBucket ? 'No Swap capability' : overLimit ? 'Reduce size — over limit' : `${side === 'ask' ? 'Buy' : 'Sell'} ${size.toFixed(4)} ${base}`}
            </Button>
            <p className="mt-2 text-center text-[11px] leading-relaxed text-faint">
              RALE computes the adaptive price policy; settlement executes on-chain via 1inch Aqua + BUCKET SwapVM under your Bucket&apos;s capability limits.
            </p>
          </Card>
        </div>

        {/* ── the one chart ── */}
        <div className="space-y-4">
          <Card className="overflow-hidden p-5">
            <div className="mb-1 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Boxes className="h-4 w-4 text-accent" />
                <span className="text-sm font-semibold">Execution-cost surface</span>
              </div>
              <span className="font-mono text-xs text-faint">P(q, Sₜ) = P* ± Pₜ·(sₜ/2 + η|q|/L)</span>
            </div>
            <p className="mb-2 text-xs text-muted">
              The taker&apos;s cost across every trade size and inventory state. The lime point is your live position; drag any parameter and the whole surface morphs.
            </p>
            <CostSurface params={params} mid={mid} sigma={sigma} inventory={inventory} qmax={qmax} size={size} side={side} />
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <Zap className="h-4 w-4 text-accent" />
              <span className="text-sm font-semibold">SwapVM execution program</span>
              <span className="ml-auto text-xs text-faint">Aqua = liquidity · SwapVM = execution · RALE = policy</span>
            </div>
            <Pipeline state={pipe} />
          </Card>
        </div>
      </div>

      <Dialog
        open={!!review}
        onOpenChange={(o) => {
          if (!o) {
            setReview(null)
            setPipe('idle')
          }
        }}
        title="Ship strategy → on-chain swap"
        description="RALE-priced order, checked against your Bucket's live on-chain authority."
      >
        {review ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-line bg-panel-2/60 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
                <Zap className="h-3.5 w-3.5 text-accent" /> Aqua + SwapVM
              </div>
              <Pipeline state={pipe} />
            </div>
            <ActionFlow action={review} onClose={() => setReview(null)} onPhase={onExecPhase} />
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
