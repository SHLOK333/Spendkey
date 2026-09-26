import { useApp } from '../lib/context'

const OPCODES = [
  {
    hex: '0x20',
    name: 'Deadline',
    source: 'SwapVM built-in',
    desc: 'Execution window guard — rejects fills after the intent expires',
  },
  {
    hex: '0x02',
    name: 'Salt',
    source: 'SwapVM built-in',
    desc: 'Uniqueness nonce — prevents replay across fills of the same intent',
  },
  {
    hex: '0xd0',
    name: 'BucketCapabilityGuard',
    source: 'BUCKET custom',
    desc: 'Re-derives the full capability chain on-chain: ENSv2 name still owned, current epoch, policy version, validity window, non-escalation',
    highlight: true,
  },
  {
    hex: '0xd1',
    name: 'BucketQuote',
    source: 'BUCKET custom',
    desc: 'Policy-bound price oracle + Dutch-auction discount. Computes amountOut from amountIn at the current block timestamp',
    highlight: true,
  },
  {
    hex: '0xd2',
    name: 'BucketSpendLimit',
    source: 'BUCKET custom',
    desc: 'Enforces per-execution, hourly, daily, turnover, intent-budget, and Aqua-budget caps simultaneously. All limits composable',
    highlight: true,
  },
  {
    hex: '0xd3',
    name: 'BucketWalletBalanceCheck',
    source: 'BUCKET custom',
    desc: 'Calls ERC-20 balanceOf(holder) live. Reverts if holder cannot cover amountOut — runs before any state is modified',
    highlight: true,
  },
] satisfies ReadonlyArray<{ hex: string; name: string; source: string; desc: string; highlight?: boolean }>

const SEQUENCE = [
  { step: 1, phase: 'SwapVM program', label: 'Opcodes 0xd0–0xd3 run', detail: 'All BUCKET guards execute here — before any hooks or token movement', highlight: true },
  { step: 2, phase: 'SwapVM', label: 'Constraint validation', detail: 'Built-in SwapVM constraint checks pass' },
  { step: 3, phase: 'BucketController', label: 'preTransferOut hook', detail: 'Snapshots holder balances into transient storage, sets execution lock' },
  { step: 4, phase: 'Aqua', label: 'tokenOut transfer', detail: 'Aqua pull() draws tokenOut from holder\'s wallet via pre-approved allowance — no custody change' },
  { step: 5, phase: 'SwapVM', label: 'postTransferOut hook', detail: 'SwapVM lifecycle hook fires' },
  { step: 6, phase: 'SwapVM', label: 'preTransferIn callback', detail: 'Taker-side callback opportunity' },
  { step: 7, phase: 'SwapVM', label: 'preTransferIn hook', detail: 'SwapVM lifecycle hook fires' },
  { step: 8, phase: 'Aqua', label: 'tokenIn transfer', detail: 'Aqua push() routes tokenIn from operator to holder\'s wallet' },
  { step: 9, phase: 'BucketController', label: 'postTransferIn hook', detail: 'Verifies exact balance deltas (lost amountOut, gained amountIn, others unchanged), charges spend velocity, records ExecutionReceipt' },
] satisfies ReadonlyArray<{ step: number; phase: string; label: string; detail: string; highlight?: boolean }>

const LAYERS = [
  {
    tag: 'WHO',
    tech: 'ENSv2',
    title: 'Identity resolution',
    color: 'var(--ens)',
    points: [
      'trading.shlok.eth is a hierarchical ENSv2 subname — owner of the name owns the Bucket',
      'Operators resolved by ENSv2 name, not hard-coded addresses',
      'ENSv2 resolves WHO — it does NOT authorize operations by itself',
      'BucketAuthority re-derives live ENSv2 ownership on every call',
    ],
    notClaim: 'ENSv2 does not provide authentication or on-chain authorization enforcement',
  },
  {
    tag: 'WHAT',
    tech: 'Financial Capabilities',
    title: 'Scoped, hierarchical rights',
    color: 'var(--ok)',
    points: [
      'Capabilities are scoped (Rebalance / Swap / Pay / Delegate), time-bound, and revocable',
      'Hierarchical: a delegated capability can never escalate beyond its parent',
      'Status: Active → Revoked or Exhausted. Revocation is permanent and instant',
      'On-chain enforcement in BucketCapabilities.requireAuthorized() on every execution',
    ],
    notClaim: 'BUCKET does not use ERC-7710 (redeemDelegations) or ERC-2612 (Permit) in the execution path',
  },
  {
    tag: 'HOW',
    tech: '1inch Aqua + SwapVM',
    title: 'Non-custodial programmable execution',
    color: 'var(--warn)',
    points: [
      'Aqua: non-custodial virtual balance layer. ship() registers allocation without transfers',
      'pull() draws tokenOut from holder\'s wallet via allowance — holder keeps custody throughout',
      'push() routes tokenIn from operator wallet to holder — atomic settlement',
      'SwapVM: opcode-based execution engine. BUCKET adds custom router with opcodes 0xd0–0xd3',
    ],
    notClaim: 'Aqua is not officially deployed on Sepolia — BUCKET deploys unmodified official AquaRouter source. Aqua does not enforce pricing or slippage; BUCKET opcodes do',
  },
  {
    tag: 'VERIFY',
    tech: 'BucketController',
    title: 'Atomic balance verification',
    color: 'var(--a2)',
    points: [
      'preTransferOut: snapshots every token balance into transient storage before tokenOut leaves',
      'postTransferIn: checks holder lost exactly amountOut tokenOut, gained exactly amountIn tokenIn, all others unchanged',
      'Any discrepancy reverts the entire trade — no partial fills, no stuck state',
      'ExecutionReceipt recorded on-chain after every successful fill',
    ],
    notClaim: 'These are BucketController maker hooks, executed after the SwapVM program phase (0xd0–0xd3)',
  },
] as const

interface ContractRowProps {
  label: string
  address: string
  explorer: string
}

function ContractRow({ label, address, explorer }: ContractRowProps) {
  return (
    <div className="judge-contract">
      <span className="muted small">{label}</span>
      <a
        className="mono small link"
        href={`${explorer}/address/${address}`}
        target="_blank"
        rel="noreferrer"
        title={address}
      >
        {address.slice(0, 10)}…{address.slice(-8)}
      </a>
    </div>
  )
}

export function JudgePage() {
  const { config } = useApp()
  const { evm } = config.deployment
  const contracts = evm.contracts as Record<string, string>
  const explorer = evm.explorer ?? ''

  return (
    <main className="page judge-page">
      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="judge-hero">
        <div className="judge-hero-text">
          <div className="eyebrow">ETH Tokyo 2026 · Financial Capability Protocol</div>
          <h1>
            BUCKET
            <br />
            <span className="judge-sub">programmable capital</span>
          </h1>
          <p className="judge-tagline">
            A self-custodial protocol that lets a wallet owner issue scoped, revocable, composable Financial
            Capabilities — and enforce them atomically on-chain through 1inch Aqua + SwapVM.
          </p>
          <p className="judge-tagline muted">
            The owner's wallet IS the Bucket. No vaults. No bridges. No custody change — ever.
          </p>
        </div>
        <div className="judge-hero-stats">
          <div className="judge-stat">
            <div className="judge-stat-val ok">22 / 22</div>
            <div className="label">Forge tests</div>
          </div>
          <div className="judge-stat">
            <div className="judge-stat-val ok">Live</div>
            <div className="label">Sepolia mainnet</div>
          </div>
          <div className="judge-stat">
            <div className="judge-stat-val">6</div>
            <div className="label">SwapVM opcodes</div>
          </div>
          <div className="judge-stat">
            <div className="judge-stat-val">4</div>
            <div className="label">Custom opcodes</div>
          </div>
        </div>
      </section>

      {/* ── 4-layer architecture ────────────────────────────── */}
      <h2 className="section-title" style={{ marginTop: 36 }}>Architecture — four layers</h2>
      <div className="judge-layers">
        {LAYERS.map((layer) => (
          <div key={layer.tag} className="judge-layer">
            <div className="judge-layer-head">
              <span className="judge-layer-tag" style={{ color: layer.color }}>{layer.tag}</span>
              <span className="judge-layer-tech eyebrow">{layer.tech}</span>
            </div>
            <div className="judge-layer-title">{layer.title}</div>
            <ul className="judge-layer-points">
              {layer.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
            <div className="judge-layer-not">
              <span className="label">Must not claim:</span> {layer.notClaim}
            </div>
          </div>
        ))}
      </div>

      {/* ── 6-opcode canonical program ──────────────────────── */}
      <h2 className="section-title" style={{ marginTop: 36 }}>The 6-opcode canonical SwapVM program</h2>
      <p className="muted" style={{ marginBottom: 14 }}>
        Every BUCKET rebalance submits exactly this program to the custom BucketSwapVMRouter. All six
        instructions run during <strong>SwapVM program execution (phase 1)</strong> — before any hooks or
        token transfers occur.
      </p>
      <div className="judge-opcodes">
        {OPCODES.map((op) => (
          <div key={op.hex} className={`judge-opcode ${op.highlight ? 'judge-opcode-bucket' : ''}`}>
            <div className="judge-opcode-hex mono">{op.hex}</div>
            <div className="judge-opcode-name">{op.name}</div>
            <div className="judge-opcode-source eyebrow">{op.source}</div>
            <div className="judge-opcode-desc muted">{op.desc}</div>
          </div>
        ))}
      </div>

      {/* ── SwapVM execution sequence ───────────────────────── */}
      <h2 className="section-title" style={{ marginTop: 36 }}>SwapVM hook lifecycle (DEFAULT tokenOut-first order)</h2>
      <p className="muted" style={{ marginBottom: 14 }}>
        0xd3 BucketWalletBalanceCheck runs at step 1 — before any state is modified. The BucketController maker
        hooks (<code>preTransferOut</code> and <code>postTransferIn</code>) are separate, at steps 3 and 9.
      </p>
      <ol className="judge-sequence">
        {SEQUENCE.map((s) => (
          <li key={s.step} className={`judge-seq-row ${s.highlight ? 'judge-seq-highlight' : ''}`}>
            <span className="judge-seq-num mono">{String(s.step).padStart(2, '0')}</span>
            <span className="judge-seq-phase eyebrow">{s.phase}</span>
            <span className="judge-seq-label">{s.label}</span>
            <span className="judge-seq-detail muted small">{s.detail}</span>
          </li>
        ))}
      </ol>

      {/* ── ERC-7715 section ─────────────────────────────────── */}
      <h2 className="section-title" style={{ marginTop: 36 }}>ERC-7715 — wallet UX layer (additive only)</h2>
      <div className="judge-erc7715">
        <div className="judge-erc7715-col">
          <div className="label" style={{ marginBottom: 6 }}>What ERC-7715 does in BUCKET</div>
          <ul className="judge-layer-points">
            <li>
              <code>wallet_requestExecutionPermissions</code> tells the wallet "I am about to execute within
              this scoped capability" — wallet can show a richer confirmation dialog
            </li>
            <li>Probed first; falls back gracefully if the wallet returns an error (MetaMask, Rabby etc. don't support it yet)</li>
            <li>
              <code>context.bucketId</code> + <code>context.capabilityId</code> let BUCKET-aware wallets
              surface Bucket-specific UI
            </li>
          </ul>
        </div>
        <div className="judge-erc7715-col judge-erc7715-not">
          <div className="label" style={{ marginBottom: 6 }}>What ERC-7715 is NOT in BUCKET</div>
          <ul className="judge-layer-points">
            <li>Not the capability enforcement system — BucketCapabilities enforces all limits on-chain regardless</li>
            <li>Not required for execution — fallback to direct capability is the normal path today</li>
            <li>BUCKET does not implement ERC-7710 (redeemDelegations)</li>
          </ul>
        </div>
      </div>

      {/* ── Live contracts ──────────────────────────────────── */}
      <h2 className="section-title" style={{ marginTop: 36 }}>Live contracts · Sepolia</h2>
      <div className="judge-contracts">
        {Object.entries(contracts).map(([label, address]) => (
          <ContractRow key={label} label={label} address={address} explorer={explorer} />
        ))}
      </div>

      {/* ── ENSv2 names ─────────────────────────────────────── */}
      <h2 className="section-title" style={{ marginTop: 28 }}>ENSv2 identity · Sepolia</h2>
      <div className="judge-contracts">
        {config.deployment.buckets.map((b) => (
          <div key={b.bucketId} className="judge-contract">
            <span className="muted small">Bucket</span>
            <span className="ens">{b.ensName}</span>
            <span className="mono small muted">{b.bucketId.slice(0, 10)}…</span>
          </div>
        ))}
      </div>

      {/* ── Key protocol properties ─────────────────────────── */}
      <h2 className="section-title" style={{ marginTop: 36 }}>Key properties</h2>
      <div className="judge-props">
        {[
          ['Self-custodial', "Holder's wallet holds every asset. Aqua pull() draws via allowance — no vault, no escrow, no bridges"],
          ['Non-escalating', 'A delegated capability can grant at most what its parent grants. Checked live on every call'],
          ['Composable limits', '0xd2 enforces per-call, hourly, daily, turnover, intent-budget, and Aqua-budget caps simultaneously — from a single capability'],
          ['Atomic verification', 'postTransferIn reverts if any balance delta is off. No partial fills. No accounting drift'],
          ['Epoch-gated', 'Advancing the epoch voids all capabilities instantly — emergency kill-switch without per-capability revocation'],
          ['Policy-versioned', 'A policy upgrade voids capabilities bound to older versions. Intent and capability must always match live policy'],
          ['Dutch-auction pricing', '0xd1 applies a time-decaying discount so price risk transfers from maker to taker the longer execution waits'],
          ['Intent-scoped fills', 'openRebalanceIntent locks tokenIn/Out pair and budget. Multiple fill transactions reduce remainingOut until exhausted'],
        ].map(([title, desc]) => (
          <div key={title as string} className="judge-prop">
            <div className="judge-prop-title">{title}</div>
            <div className="judge-prop-desc muted">{desc}</div>
          </div>
        ))}
      </div>

      <div className="judge-footer muted small">
        BUCKET Financial Capability Protocol · Built at ETH Tokyo 2026 · Deployed on Ethereum Sepolia ·{' '}
        <a className="link" href="#/">{'View live Buckets →'}</a>
      </div>
    </main>
  )
}
