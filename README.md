# BUCKET — Self-Custodial Financial Capability Protocol

> **We don't delegate wallets. We delegate Financial Capabilities.**

A Bucket is a programmable financial container whose most important property is that **it never becomes the
user's custodian**. The owner's assets stay in the owner's own wallet. What the owner delegates to an operator is a
**Financial Capability** — a scoped, revocable, time-bound, nonce-bound, policy-bound, amount-limited, asset-limited
right to perform *one* kind of financial action, never custody of the funds themselves.

```
SuiNS / ENSv2                      →  WHO is this? (identity, resolved live; never authorization by itself)
Financial Capability               →  WHAT may that identity do? (permissions, assets, limits, time, policy version)
Move / Solidity enforcement        →  Capability checked live, on every call — never a frontend check
Aqua + SwapVM (EVM) / PTB (Sui)    →  HOW the authorized action actually settles
Execution receipt                  →  WHO executed, WHY it was allowed, WHAT changed, HOW MUCH, the RESULT
```

BUCKET runs this model **natively on two chains**, not as one shared contract:

```
                              FINANCIAL CAPABILITY
                    (chain-neutral concept: scoped, revocable,
                     hierarchical, non-escalating, limited)
                        /                                \
                EVM execution layer                 Sui-native layer
                       |                                    |
        ENSv2 → BucketCapabilities →          SuiNS-resolved address → bucket::capability →
        Bucket program (0xd0-0xd2)             bucket::bucket (native vault, pay/pay_many/
        → Aqua pull/push (real ERC-20s)         pay_bucket_to_bucket, real Coin<T> transfers)
```

Each stack is **independently issued and independently enforced**. The EVM side never mirrors Sui's capabilities,
and Sui never re-derives EVM's price-based rebalance math; an optional `bind_evm` link on the Sui Bucket exists
purely for cross-chain attribution in the UI, not shared trust.

---

## The core primitive: Financial Capability

```
Capability #3
  Bucket:        trading.shlok.eth
  Operator:      agent.trading.shlok.eth   (resolved live via ENSv2)
  Permissions:   REBALANCE
  Assets:        USDC · ETH · SUI
  Max/execution: $1,000        Max/hour: $3,000       Max/day: $5,000
  Max turnover:  80% of Bucket value / day
  Valid:         now → +24h
  Policy:        v3               Epoch: 0
  Status:        ACTIVE
```

The operator does **not** receive unrestricted wallet control — never an approval to move anything it wants. It
receives exactly this capability, checked in full on every single execution:

- **status** not `REVOKED` / `EXHAUSTED`
- **epoch** matches the Bucket's current epoch (an owner/guardian kill switch invalidates *every* capability at once)
- **policy version** matches the Bucket's current policy (a policy change immediately supersedes every capability
  issued under the old one)
- **time window** (`validAfter` ≤ now ≤ `validUntil`)
- **identity** — the operator still owns its ENSv2/SuiNS name right now, not just at issuance
- **permission** requested is one this capability was actually granted
- **asset / venue** scope
- **spend velocity** — per-execution, hourly, daily and daily-turnover ceilings, charged to this capability *and*
  every ancestor in its delegation chain, so parents bound the blast radius of everything they delegate

A capability may delegate a **child** (`PERM_DELEGATE`) only if the child is a subset of the parent in every one of
those dimensions — `ChildAuthority ⊆ ParentAuthority`, checked once at issuance because capabilities are immutable
afterward. A treasury capability with `$20,000/day` cannot mint a child with `$100,000/day`; the attempt reverts.

Revocation works four ways: revoke one capability (voids every descendant, since every check walks the chain to its
root), bump the Bucket's epoch (kills every capability at once — the emergency switch), install a new policy version
(supersedes every existing capability), or let it simply expire.

---

## EVM execution layer

| Layer | Role | Implementation |
|---|---|---|
| **ENSv2** (Sepolia) | Identity | `BucketAuthority`: Bucket owner = live owner of `trading.<name>.eth`; guardians = ENSv2 subnames holding an Enhanced Access Control role, re-checked live. Operators hold **no** standing role — they're resolved fresh from the registry every time a capability is checked. |
| **BucketCapabilities** | Authorization | Issues, delegates, revokes and charges the spend velocity of every Financial Capability. Owner-only issuance; `PERM_DELEGATE` for child issuance. |
| **BucketController** | Custody + settlement | Holds **no funds**. A Bucket's assets are the policy tokens in the owner's own wallet (`holder`). Manages policy, strategy generations, financial intents and capability-gated payments; verifies every settlement. |
| **1inch Aqua** | Shared liquidity | The holder is its own Aqua maker — no vault contract. Tokens move only via Aqua `pull`/`push` of a strategy the holder shipped, inside the holder's own ERC-20 allowance to Aqua. |
| **1inch SwapVM** | Programmable execution | Three new instructions in a new *Buckets* bank: `BucketCapabilityGuard` (0xd0, WHO/intent/capability chain), `BucketQuote` (0xd1, policy-bound price), `BucketSpendLimit` (0xd2, every quantitative cap) |

### How an execution actually happens

```
capability check → policy check → open intent → Aqua strategy shipped → SwapVM program verified →
exact-in fill → Aqua pull/push (real ERC-20 transfers) → post-state invariant → capability + Bucket usage charged →
ExecutionReceipt recorded
```

1. **Detect** — the SDK values the Bucket from the holder's live wallet balances at reference prices.
2. **Open an intent** (`REBALANCE` or `SWAP`, under a live capability) — `BucketController.openRebalanceIntent` /
   `openSwapIntent` picks the leg, sizes it at `min(excess, deficit, effective limits)` and opens a time-boxed
   intent bound to the capability, the current policy version and a fixed operator.
3. **Fill** — the operator fills through `BucketSwapVMRouter.swap` against the Bucket's one canonical strategy for
   that asset pair. `0xd0` re-checks the whole capability chain and the intent; `0xd1` prices at reference ± a
   Dutch-auction concession capped by the tightest `maxSlippageBps` in the chain; `0xd2` enforces the per-execution,
   hourly, daily, turnover, intent and Aqua-budget ceilings.
4. **Settle** — Aqua `pull`s the overweight asset from the holder's wallet to the operator; the operator's payment
   is `push`ed back. Real ERC-20 transfers, nothing simulated.
5. **Verify** — maker hooks on the controller snapshot balances before the pull and, after the push, require exact
   deltas on exactly two balances, zero fee, and a non-worsening allocation (rebalance) or both assets back inside
   their hard bands (swap).
6. **Charge and record** — the capability and the Bucket's own velocity windows are charged; an `ExecutionReceipt`
   (who, why, what changed, how much, result) is emitted and recorded.

Payments (`PERM_PAY`) skip the SwapVM path entirely: `BucketController.pay` moves tokens straight from the holder's
wallet to the capability's **fixed** payee, inside the holder's explicit ERC-20 allowance to the controller — an
operator with PAY can fulfil payments to that one destination, never choose an arbitrary one.

---

## BUCKET SwapVM — Custom instruction set

Every EVM swap and rebalance runs through `BucketSwapVMRouter`, which only understands the **Bucket instruction set
(`BucketOpcodes`)** — a minimal, standalone bank containing `Deadline`, `Salt`, and four custom BUCKET instructions
in the `0xd0–0xd3` range. These are BUCKET extension instructions, not part of the standard 1inch SwapVM opcode
table and not usable without a deployed `BucketSwapVMRouter`.

### Opcode table

| Opcode | Instruction | Source file | Purpose |
|--------|-------------|-------------|---------|
| `0xd0` | `BucketCapabilityGuard` | `contracts/evm/src/vm/BucketCapabilityGuard.sol` | **WHO** — verifies the taker is the intent's operator; the whole capability chain is valid right now (not revoked, not expired, epoch matches, policy version matches); the intent is open, not expired, bound to the current policy version and pointing the right direction |
| `0xd1` | `BucketQuote` | `contracts/evm/src/vm/BucketQuote.sol` | **PRICE** — Dutch-auction concession from 0 to `maxSlippageBps` over `auctionDuration`; prices the fill in reference-price WAD; enforces rebalance direction (tokenOut overweight, tokenIn underweight); no overshoot past target allocation |
| `0xd2` | `BucketSpendLimit` | `contracts/evm/src/vm/BucketSpendLimit.sol` | **LIMITS** — enforces every quantitative cap: `maxExecutionValue`, remaining hourly, daily and daily-turnover velocity, intent budget, Aqua virtual balance |
| `0xd3` | `BucketWalletBalanceCheck` | `contracts/evm/src/vm/BucketWalletBalanceCheck.sol` | **BALANCE** — reads `IERC20(tokenOut).balanceOf(holder)` on-chain (independent of Aqua's virtual balance) and reverts with `BucketInsufficientWalletBalance` before any state changes if the holder's actual wallet cannot supply `amountOut` |

### Canonical program layout

Every Bucket strategy program is the same five-instruction sequence, compiled by `@bucket/vm`:

```
PC 0  Deadline(strategyExpiry)         0x20  — Aqua-level strategy expiry
PC 1  Salt(strategyNonce)              0x02  — unique hash per strategy generation
PC 2  BucketCapabilityGuard(ctrl, id) 0xd0  — WHO
PC 3  BucketQuote(ctrl, id)           0xd1  — PRICE
PC 4  BucketSpendLimit(ctrl, id)      0xd2  — LIMITS
PC 5  BucketWalletBalanceCheck(ctrl)  0xd3  — BALANCE
```

`BucketController.strategyOrder` announces the canonical order to the router before every fill.
`@bucket/vm`'s `verifyBucketOrder` checks the announced order byte-for-byte against the canonical program —
the SDK rejects any fill against a non-canonical order before submitting it.

### Sepolia deployments

| Contract | Address | Etherscan |
|----------|---------|-----------|
| `BucketSwapVMRouter` | `0x1B99c7FE80b670d0d689B0887302A4a156009b20` | [sepolia.etherscan.io/address/0x1B99c7FE80b670d0d689B0887302A4a156009b20](https://sepolia.etherscan.io/address/0x1B99c7FE80b670d0d689B0887302A4a156009b20) |
| `AquaRouter` (unmodified upstream) | `0x219F46B2eC62F36617EA11b8dDC8a83b53261e78` | [sepolia.etherscan.io/address/0x219F46B2eC62F36617EA11b8dDC8a83b53261e78](https://sepolia.etherscan.io/address/0x219F46B2eC62F36617EA11b8dDC8a83b53261e78) |
| `BucketController` | `0x378a11968905265150CAE36237C2f77665F64bcA` | [sepolia.etherscan.io/address/0x378a11968905265150CAE36237C2f77665F64bcA](https://sepolia.etherscan.io/address/0x378a11968905265150CAE36237C2f77665F64bcA) |

> **Note:** AquaRouter on Sepolia is the unmodified official source (no mainnet deterministic deployment exists for
> Sepolia); `BucketSwapVMRouter` is deployed on top of it and runs only `BucketOpcodes` — the full upstream SwapVM
> instruction set is not exposed. Full opcode semantics: [docs/BUCKET_VM.md](docs/BUCKET_VM.md).

### UI execution trace

The BUCKET DEX frontend (`apps/dex`) shows an expandable **"View execution path"** section after every successful
swap or rebalance. The trace is populated entirely from real execution data — not hardcoded values:

- **BUCKET Policy** — server-side validation of operator, capability, permission, asset mask (maps to 0xd0)
- **BUCKET SwapVM** — per-opcode pass/fail from server-side policy checks, confirmed by the on-chain `ExecutionRecorded` event
- **Aqua** — the actual AquaRouter address from the deployment manifest; confirmed by the fill transaction
- **Actual token transfer** — amounts read from the on-chain `ExecutionRecorded` event (not the pre-trade quote)
- **Onchain proof** — the real Sepolia transaction hash; links to Etherscan

For blocked executions (over-limit, revoked capability) the trace shows which opcode blocked the action and confirms that no transaction was submitted.

---

## Sui-native layer

Sui is not a mirror of the EVM Bucket. `contracts/sui` is a complete, independent Financial Capability + settlement
stack: `bucket::bucket` (the Bucket object, a native vault of Sui coins, guardians, an optional attribution-only
`EvmBinding`), `bucket::capability` (issuance, delegation, revocation, spend velocity — the same chain-neutral
primitive, enforced in Move), `bucket::policy` (per-Bucket payment policy and its commitment) and `bucket::receipt`
(structured EVM execution attribution, for Buckets that choose to bind an EVM twin).

- **Native issuance** — the owner (`OwnerCap`) issues a root capability directly to an address resolved off-chain
  from a SuiNS name; an operator (`OperatorCap`) with `PERM_DELEGATE` issues a child the same way EVM does —
  `ChildAuthority ⊆ ParentAuthority`, checked in Move.
- **Native payments** — `pay` (single, fixed payee), `pay_many` (atomic multi-recipient — every payment succeeds or
  the whole call aborts), `pay_bucket_to_bucket` (moves a `Balance<T>` directly between two Bucket vaults in one
  atomic call, no Coin round-trip).
- **Receiving policies** — a destination Bucket may restrict `pay_bucket_to_bucket` senders and amount bounds.
- **Guardian** — pause and revoke, never withdraw or change ownership.
- **No price oracle** — spend-velocity limits are denominated in a coin's own smallest units, and daily turnover is
  measured against that Bucket's own vault balance of the same coin — this is a deliberate, documented simplicity
  for a settlement-focused stack, not an oversight (see `docs/SECURITY.md`).

---

## Repository

```
contracts/
  evm/                        Foundry
    src/
      BucketController.sol        policy, strategy generations, intents, payments, settlement verification
      BucketCapabilities.sol      Financial Capability registry: issue, delegate, revoke, spend velocity
      BucketAuthority.sol         ENSv2 identity: Bucket owner + guardian resolution
      vm/BucketCapabilityGuard.sol   SwapVM instruction 0xd0 — WHO/intent/capability chain
      vm/BucketQuote.sol             SwapVM instruction 0xd1 — policy-bound price
      vm/BucketSpendLimit.sol        SwapVM instruction 0xd2 — every quantitative cap
      vm/BucketOpcodes.sol           the Bucket instruction set (Deadline, Salt, 0xd0-0xd2 — nothing else)
      libraries/                   BucketMath, BucketPolicyLib, BucketPermissions, CapabilityLib, BucketEngine
      oracle/                      BucketReferencePriceFeed (IBucketPriceFeed)
      tokens/                      BucketTestToken (testnet assets)
    script/Deploy.s.sol
    lib/                         vendored, pinned upstream sources (see lib/VENDORED.md)
  sui/                         Move package `bucket`: codec, permissions, policy, capability, receipt, bucket
packages/
  protocol-types/              canonical TS model shared by both stacks: constants, permissions, capability +
                                policy validation/commitment, identity, manifest schema
  sdk/                         BucketClient (EVM), SuiBucketClient (Sui-native), typed ABIs, BCS layouts, tx builders
vm/                            @bucket/vm: Bucket instruction encoders, program compiler/decoder, taker traits,
                                exact BucketMath mirror, rebalance/fill simulation
apps/web/                      React dashboard (Vite)
scripts/                       deploy (EVM, Sui), configure (ENSv2 hierarchy, prices), demo (end-to-end EVM flow)
docs/                          ARCHITECTURE.md · BUCKET_VM.md · SECURITY.md · DEPLOYMENT.md
```

---

## Networks

| Component | Network | Address / source |
|---|---|---|
| ENSv2 | Sepolia | Official deployment (`ensdomains/contracts-v2`, tag `sepolia-deployment-2026-06-29`): RootRegistry `0x11b5…f50c`, ETHRegistry `0x67b7…4b43`, ETHRegistrar `0xa444…5a30`, UserRegistry impl `0x840f…61c0`, VerifiableFactory `0x118b…b70f` |
| Aqua | Sepolia | **Not officially deployed on Sepolia.** The official deterministic deployment (`0x1111113c…6a90a`) covers mainnets only, so `Deploy.s.sol` deploys the **unmodified** official `AquaRouter` source (pinned commit). Set `AQUA_ADDRESS` to reuse an existing Aqua. |
| `BucketSwapVMRouter` | Sepolia | `0x1B99c7FE80b670d0d689B0887302A4a156009b20` — runs only `BucketOpcodes` (0xd0–0xd3 + Deadline + Salt); deliberately narrower than the official upstream router. [Etherscan](https://sepolia.etherscan.io/address/0x1B99c7FE80b670d0d689B0887302A4a156009b20) |
| `AquaRouter` | Sepolia | `0x219F46B2eC62F36617EA11b8dDC8a83b53261e78` — unmodified official source (no official Sepolia deployment). [Etherscan](https://sepolia.etherscan.io/address/0x219F46B2eC62F36617EA11b8dDC8a83b53261e78) |
| Sui | testnet | `contracts/sui` published by `pnpm deploy:sui` |
| Assets | Sepolia | `tUSDC` (6), `tETH` (18), `tSUI` (9), `tPEPE` (18, deliberately never part of a Bucket policy — unapproved-asset rejection demo) test ERC-20s. Reference prices published by an authorized reporter from configuration. |

A local **anvil fork of Sepolia** is supported (`EVM_NETWORK=sepolia-fork`) and labelled `LOCAL FORK` in the UI.

---

## Quickstart

Prerequisites: Node ≥ 22, pnpm 9, Foundry, a Sui CLI ≥ 1.60 (`SUI_BIN`; a working build was staged for this repo at
`.tools/sui.exe` — see `docs/DEPLOYMENT.md` if you need to fetch your own), Sepolia ETH on the deployer, owner and
operator accounts, testnet SUI on the Sui owner key.

```bash
pnpm install
cp .env.example .env            # fill in RPC URL and keys
cp apps/web/.env.example apps/web/.env

pnpm evm:build && pnpm abi      # compile contracts, regenerate typed ABIs
pnpm deploy:evm                 # Aqua (official source), Bucket router, authority, capabilities, controller, feed, test tokens
pnpm deploy:sui                 # publish the Move package
pnpm configure:ens              # <owner>.eth, UserRegistries, trading/savings/payments, agent.trading.<owner>.eth
pnpm demo                       # create the trading Bucket, issue capabilities, rebalance + pay, then reject
                                 # a malicious agent's over-limit / unapproved-asset / revoked-capability attempts
pnpm web                        # http://localhost:5173
```

Local fork:

```bash
anvil --fork-url "$SEPOLIA_RPC_URL" --chain-id 11155111
EVM_NETWORK=sepolia-fork pnpm deploy:evm   # then the same configure/demo steps with EVM_NETWORK=sepolia-fork
```

On the fork the ENSv2 commit/reveal wait is skipped with `evm_increaseTime`; everything else runs against the real
forked ENSv2 contracts.

---

## SDK

```ts
import { BucketClient } from '@bucket/sdk'

const view = await client.getBucket(bucketId)             // ENSv2 name, snapshot, allocation, plan
if (view.plan?.required) {
  const run = await client.executeRebalance({
    bucketId,
    capabilityId,                                          // must grant REBALANCE, checked live on every stage
    wallet: operatorWallet,
    onStage: (s) => console.log(s.stage, s.status, s.txHash ?? ''),
  })
  console.log(run.fill.pre.maxAbsDeviationWad, '→', run.fill.post?.maxAbsDeviationWad)
}
```

`createBucket`, `getBucket`, `getBucketAllocation`, `executeRebalance` are on `BucketClient` (EVM). Lower-level EVM
access: `BucketEvm` (controller + capabilities + authority + router), `EnsV2`. For Sui, `SuiBucketClient` wraps
native capability issuance/delegation/revocation and `pay` / `payMany` / `payBucketToBucket`, backed by `BucketSui`
(read) and a pluggable `SuiExecutor` (write — a keypair in scripts, a wallet in the browser). `@bucket/vm` exposes
`compileBucketProgram`, `verifyBucketOrder`, `planRebalance`, `simulateFill`, `maxFillAmountIn`, `buildTakerTraits`.

---

## Protocol invariants

| Invariant | Enforced by |
|---|---|
| A capability never grants an owner-only permission | `BucketPermissions.isDelegable` / `permissions::is_delegable` |
| `ChildAuthority ⊆ ParentAuthority`, checked once at issuance | `BucketCapabilities.delegate` / `bucket::capability::issue_child` |
| No execution proceeds unless every link of the chain is valid *now* | `BucketCapabilities.requireAuthorized` (0xd0 calls it) / `capability::check_link` + `check_leaf` |
| Cumulative usage never exceeds hourly/daily/turnover limits, for the capability *and* the Bucket | `BucketCapabilities.consume` + `BucketController._chargeBucket` / `bucket::capability::charge` |
| Ownership never moves except through the ENSv2 name / the `OwnerCap` object | no Bucket function writes EVM ownership; `OwnerCap` is minted exactly once |
| Withdrawal is never delegable | `PERM_WITHDRAW` excluded from `DELEGABLE_PERMISSIONS` on both chains |
| Rebalances/swaps stay within limits | opcode `0xd2` / the same checks mirrored in `@bucket/vm` |
| Slippage bounded by the tightest limit in the capability chain | opcode `0xd1`: concession ≤ `chainLimits(...).maxSlippageBps` |
| Only permitted assets, only the capability's fixed payee for payments | opcodes `0xd0`/`0xd2` + hooks; `BucketController.pay` |
| Accounting matches execution exactly | maker hooks: exact deltas on exactly two balances, zero fee |
| Post-state verifiable | hooks: non-worsening allocation (rebalance) / hard-band compliance (swap) |

Details and trust assumptions: [docs/SECURITY.md](docs/SECURITY.md).

---

## Licensing and attribution

The EVM package and `@bucket/vm` extend SwapVM and are published under `LicenseRef-Degensoft-SwapVM-1.1`.
**Powered by SwapVM — © Degensoft Ltd 2025.** Aqua source is vendored unmodified under
`LicenseRef-Degensoft-Aqua-Source-1.1`. ENSv2 contracts are MIT. Everything else in this repository is MIT.
