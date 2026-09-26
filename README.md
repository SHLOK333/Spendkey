# BUCKET — Self-Custodial Financial Capability Protocol

> **We don't delegate wallets. We delegate Financial Capabilities.**

A Bucket never becomes your custodian. Your assets stay in **your** wallet. What you hand an operator (a human or an
AI agent) is a **Financial Capability** — a scoped, revocable, time-bound, nonce-bound, policy-bound, amount-limited,
asset-limited right to perform *one* kind of action. It is enforced live on-chain on every call, never by the frontend.

```
SuiNS / ENSv2                      →  WHO is this?  (identity, resolved live — never authorization by itself)
Financial Capability               →  WHAT may they do?  (permissions · assets · limits · time · policy version)
Move / Solidity enforcement        →  Checked live, every call
1inch Aqua + SwapVM (EVM) / PTB (Sui)  →  HOW the authorized action settles
Execution receipt                  →  WHO · WHY allowed · WHAT changed · HOW MUCH
```

Two chains, **independently issued and independently enforced** — not one shared contract.

---

## RALE — the Risk-Adaptive Liquidity Engine

[`apps/dex/src/app/rale/page.tsx`](apps/dex/src/app/rale/page.tsx) · route `/rale` (Insights menu)

RALE is BUCKET's **adaptive maker-pricing engine**: instead of a static curve, a Bucket quotes a *state-dependent*
executable price that reacts to inventory, volatility and trade size in real time — and then settles that price
through the same on-chain program every other action uses.

```
P(q, Sₜ) = P*·(1 − λ·Iₜ)  ±  Pₜ·( sₜ/2 + η·|q|/L )        sₜ = s₀ + α·σₜ + β·|Iₜ|
           └ reservation ┘     └ half-spread ┘└ size impact ┘   └ base + vol + inventory skew ┘
```

- **Every input is real** — `Pₜ` and inventory `Iₜ` come from live on-chain prices + wallet balances
  (`useWalletAssets`), `σₜ` is session-observed volatility sampled from mids. It's a model *over real chain data*,
  not a simulation.
- **One hero visual** — a hand-built 3D isometric **execution-cost surface** `z = |execPrice − mid| / mid` over the
  (trade size q) × (inventory I) plane, morphing on every parameter change. (No chart library — framer-motion is the
  only viz dep, so all charts are hand-built SVG.)
- **It settles for real** — the pipeline `0xd0 InventoryState → 0xd1 Spread → 0xd2 SizeImpact → 0xd3 Settlement`
  maps one-to-one onto the SwapVM program below, and **Execute** routes the computed trade through `<ActionFlow>` →
  1inch Aqua + SwapVM, gated on the Bucket's live Swap capability and on-chain `maxExecutionValue`.

RALE is the **policy** (what price); the opcodes are the **enforcement** (may this fill happen, at that price, within
limits). Same program for the preview and the fill, so they can never disagree.

---

## Where 1inch is used: **Aqua = liquidity, SwapVM = execution**

BUCKET's EVM execution layer is built directly on **1inch's [SwapVM](https://github.com/1inch/swap-vm) and Aqua**.
A Bucket's strategy is a SwapVM program shipped to Aqua, so **Aqua virtual balances and the SwapVM program share one
execution path** — the assets never leave the owner's wallet; the taker pays `tokenIn` via `transferFrom + Aqua push`
and receives `tokenOut` via Aqua `pull` from the holder's wallet.

| Piece | What it does | Code |
|---|---|---|
| **SwapVM router** | Bucket router whose instruction set *is* the Bucket program; ships to Aqua as the app | [`contracts/evm/src/vm/BucketSwapVMRouter.sol`](contracts/evm/src/vm/BucketSwapVMRouter.sol) |
| **Ship strategy → Aqua** | Approve Aqua, ship the SwapVM program + virtual balances per pair | [`onboard.ts` `shipAqua`](apps/dex/src/lib/client/onboard.ts#L235) · [`sdk/evm/client.ts:268`](packages/sdk/src/evm/client.ts#L268) |
| **Fill via Aqua pull/push** | `swap()` on the router with `useTransferFromAndAquaPush` taker traits | [`sdk/evm/client.ts:459 fillIntent`](packages/sdk/src/evm/client.ts#L459) |

Sui is **not** an Aqua/SwapVM mirror — it settles natively (real `Coin<T>` transfers via PTB); see
[`contracts/sui/sources/bucket.move`](contracts/sui/sources/bucket.move).

---

## The opcodes: `0xd0 → 0xd3`

The Bucket program is a five-instruction canonical SwapVM program
([`contracts/evm/src/vm/BucketOpcodes.sol`](contracts/evm/src/vm/BucketOpcodes.sol)). `quote` and `swap` run it
identically (every instruction is `view`), so a preview and the real fill can never diverge:

| Op | Instruction | Question it answers | Code |
|----|---|---|---|
| **0xd0** | `BucketCapabilityGuard` | May *this* taker fill *this* order right now, under which capability? (identity, open intent, whole delegation chain, ENSv2 names, venue) | [`BucketCapabilityGuard.sol`](contracts/evm/src/vm/BucketCapabilityGuard.sol) |
| **0xd1** | `BucketQuote` | At what price? (reference price + Dutch-auction concession bounded by policy & every capability; rebalance direction; no target overshoot) | [`BucketQuote.sol`](contracts/evm/src/vm/BucketQuote.sol) |
| **0xd2** | `BucketSpendLimit` | Is the priced fill within every bound? (per-execution, hourly, daily, turnover, intent budget, Aqua budget) | [`BucketSpendLimit.sol`](contracts/evm/src/vm/BucketSpendLimit.sol) |
| **0xd3** | `BucketWalletBalanceCheck` | Does the holder's *real* ERC-20 balance still cover it? (independent of Aqua's virtual balance) | [`BucketWalletBalanceCheck.sol`](contracts/evm/src/vm/BucketWalletBalanceCheck.sol) |

### How the opcodes drive **the agent**

The operator agent validates, then executes, entirely through these opcodes — it can *never* move funds outside them:

- **Validate** — `previewSwap` runs `0xd0→0xd3` off-chain and surfaces each check; a live Swap capability + on-chain
  `maxExecutionValue` gate the button. [`agent.ts validateSwap`](apps/dex/src/lib/server/agent.ts#L215) (`route: 'Aqua / SwapVM (BUCKET program 0xd0 → 0xd3)'`).
- **Execute** — `executeSwap` opens the intent and fills through the router; the receipt is the Aqua + SwapVM fill.
  [`agent.ts` execution](apps/dex/src/lib/server/agent.ts#L573).

### How the opcodes drive **RALE**

[`apps/dex/src/app/rale/page.tsx`](apps/dex/src/app/rale/page.tsx) (Risk-Adaptive Liquidity Engine) is the *policy*
that produces the maker price the opcodes then enforce. Its on-page pipeline maps one-to-one onto the program —
`0xd0 InventoryState → 0xd1 Spread → 0xd2 SizeImpact → 0xd3 Settlement` — and the **Execute** button settles the
computed trade through the same real `<ActionFlow>` → Aqua + SwapVM path (gated on a Bucket's live `swapCaps`).
RALE is a model over **real** on-chain prices/balances; the fill is the real chain program. Nothing is simulated.

---

## Hierarchical capabilities → EAC & HAC

A capability can be **delegated** into a strictly narrower child
([`BucketCapabilities.delegate()`](contracts/evm/src/BucketCapabilities.sol)). The chain is enforced as a whole:

- **Monotone attenuation** — a child is never wider than its parent (assets, venues, permissions, limits, time all
  shrink or stay equal); depth-limited; usage is charged to the entire chain.
- **HAC (Hierarchical Agent Capabilities)** — children are issued to **ENSv2 subnames of the operator's own name**,
  so an agent can sub-delegate to a sub-agent without ever widening authority.
  [`BucketPermissions.sol`](contracts/evm/src/libraries/BucketPermissions.sol) · surfaced as ERC-8004 skills in
  [`agent-card.ts`](apps/dex/src/lib/server/agent-card.ts).
- **EAC (Enhanced Access Control)** — the *authority* model the hierarchy plugs into. On EVM it's ENSv2 semantics;
  on Sui it's a Move-native port of ENSv2 `EnhancedAccessControl`: resource-scoped, nybble-packed `u256` role
  bitmaps, per-role admin roles (no super-admin), a `ROOT_RESOURCE` that applies everywhere, and guardians.
  [`contracts/sui/sources/access.move`](contracts/sui/sources/access.move).

**Kill switches:** owner or guardian can `revoke` one capability or `revokeAll` (advances the epoch, invalidating
every capability at once) — [`sdk/evm/client.ts`](packages/sdk/src/evm/client.ts).

### The policies the whole thing respects

Every capability is bounded by its Bucket's policy, validated identically in Solidity, Move and TypeScript:

- **EVM** — [`BucketPolicyLib.sol`](contracts/evm/src/libraries/BucketPolicyLib.sol) invariants **I1–I10** (weight
  bands sum to 100%, `maxExecutionValue ≤ maxHourlyValue ≤ maxDailyValue`, slippage/turnover ceilings, venue subset,
  only delegable permissions may be delegated).
- **Sui** — [`contracts/sui/sources/policy.move`](contracts/sui/sources/policy.move) (payment/settlement policy).

---

## Identity: SuiNS & ENSv2 (last, and never authorization by itself)

Names answer *who*, never *what*. The **address** is always the security principal; the name only resolves to it.

- **ENSv2 (EVM)** — names resolved by descending the ENSv2 registry tree (`getSubregistry` per label), not by
  ENSv1 namehash. [`packages/sdk/src/ens/ensv2.ts`](packages/sdk/src/ens/ensv2.ts). An operator agent's ENSv2 name
  (e.g. `exec.trading.<owner>.eth`) is bound to its on-chain identity as an **ERC-8004** AgentCard built from *live*
  chain state — [`agent-card.ts`](apps/dex/src/lib/server/agent-card.ts).
- **SuiNS (Sui)** — `resolve_suins_principal` reads the real on-chain SuiNS registry and returns the target address,
  which becomes the EAC principal; an unregistered/expired name simply resolves to nothing.
  [`packages/sdk/src/sui/bucket.ts:604`](packages/sdk/src/sui/bucket.ts#L604) · `access::resolve_target` in
  [`access.move`](contracts/sui/sources/access.move).

---

## Run it

```bash
pnpm install
pnpm dev        # Vite SPA on :3100, Hono API on :3101 (Vite proxies /api)
```

The client holds **no secrets** — RPC, agent keys and the OpenAI key live server-side only
(see [`apps/dex/AGENTS.md`](apps/dex/AGENTS.md)). Testnets only: ENSv2 on Sepolia, SuiNS on Sui testnet.
Deployed addresses: [`deployments/sepolia.json`](deployments/sepolia.json).

---

*SwapVM & Aqua integration powered by [1inch SwapVM](https://github.com/1inch/swap-vm) — © Degensoft Ltd 2025.*
