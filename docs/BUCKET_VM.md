# Bucket SwapVM extension

## Why four instructions, not one (and not three)

The original design used one opcode carrying identity, pricing and limits together. Once execution authority became
a first-class, hierarchical Financial Capability rather than a flat ENSv2 role, that single instruction would have
had to re-derive the whole capability chain, the price, and every quantitative limit in one pass — correct, but
opaque to audit and impossible to reuse a piece of (e.g. checking authorization without pricing anything).

The Bucket bank is four small, composable instructions, each with one job:

| PC | Instruction | Opcode | Purpose |
|---|---|---|---|
| 0 | `Deadline(strategyExpiry)` | `0x20` (existing) | strategy generation's Aqua-level expiry |
| 1 | `Salt(strategyNonce)` | `0x02` (existing) | unique strategy hash per generation — Aqua strategies are immutable and a docked hash cannot be re-shipped |
| 2 | `BucketCapabilityGuard(controller, bucketId)` | `0xd0` (new) | WHO: identity, intent, capability chain, ENSv2 |
| 3 | `BucketQuote(controller, bucketId)` | `0xd1` (new) | policy-bound price, rebalance direction, no overshoot |
| 4 | `BucketSpendLimit(controller, bucketId)` | `0xd2` (new) | every quantitative cap: per-execution, hourly, daily, turnover, intent budget, Aqua budget |
| 5 | `BucketWalletBalanceCheck(controller, bucketId)` | `0xd3` (new) | live ERC-20 wallet balance of tokenOut ≥ amountOut |

`BucketOpcodes` is now a **minimal, standalone** instruction set — it no longer extends `AquaOpcodes`. A router that
only understands `Deadline`, `Salt` and the Bucket bank has no curve, fee or jump instruction a maker could combine
with Bucket instructions to bypass them.

## Opcode table change

`contracts/evm/lib/swap-vm/contracts/libs/OpcodeList.sol` (the only modified upstream file):

```diff
-    // 0xd0-0xdf | Buckets: policy-bound programmable capital (BUCKET protocol extension)
-    /* d0 */ BucketRebalance,
-    /* d1 */ _d1,
-    /* d2 */ _d2,
+    // 0xd0-0xdf | Buckets: capability-bound self-custodial execution (BUCKET protocol extension)
+    /* d0 */ BucketCapabilityGuard,
+    /* d1 */ BucketQuote,
+    /* d2 */ BucketSpendLimit,
+    /* d3 */ BucketWalletBalanceCheck,
```

### Why 0xd3 is `BucketWalletBalanceCheck` (not a post-state check, not a reservation)

An earlier version of this file named slot 0xd3 `BucketPostStateCheck` and left it as a non-live "reservation."
That was incorrect: a named-but-non-dispatched slot is a decoration, not an instruction.

The slot is now a **live instruction** that fills a genuine gap in the Financial Capability enforcement pipeline.

**The gap**: `BucketSpendLimit` (0xd2) checks `amountOut` against the Aqua virtual balance
(`ctx.swap.balanceOut`) — the amount Aqua believes is available from the holder's docked tokens or approved
allowance. BUCKET is self-custodial: assets stay in the holder's own wallet. The Aqua virtual balance can
diverge from the holder's actual on-chain ERC-20 balance if:
  - the holder transfers tokens out via a path Aqua does not track, or
  - the holder's ERC-20 approval was partially consumed since the last dock/balance sync.

**The instruction**: `BucketWalletBalanceCheck` (0xd3) reads `IERC20(tokenOut).balanceOf(holder)` from the
ERC-20 contract directly — an independent on-chain source — and reverts with `BucketInsufficientWalletBalance`
**before any state is modified**, making the Financial Capability unexercisable rather than reverting deep
inside a transfer with an opaque ERC-20 message.

**Why it was safe to reclaim `_d3` / `BucketPostStateCheck`**: the reservation served no runtime function.
Post-state enforcement is already done atomically in `BucketController.postTransferIn` (the Aqua maker hook),
which calls `BucketEngine.settle()` and `BucketEngine.requireAllocationInvariant()` — both revert and abort
the entire Aqua fill on violation. A SwapVM instruction at this slot literally cannot observe post-transfer
state (instructions run before the transfer), so the reservation added naming without capability enforcement.

`BucketSwapVMRouter` is `Simulator + SwapVM + BucketOpcodes`.

## Encoding

All three instructions share one argument layout (`BucketInstructionArgs.sol`):

```
[opcode][0x34][controller: 20][bucketId: 32]      (52 argument bytes)
```

`@bucket/vm` provides `encodeBucketCapabilityGuard`/`encodeBucketQuote`/`encodeBucketSpendLimit`,
`compileBucketProgram`, `decodeProgram`, `decodeOrder` and `verifyBucketOrder`, which checks a controller-announced
order byte-for-byte against the canonical program before any fill.

## Execution semantics

Each instruction calls `IBucketController.loadFrame(bucketId, orderHash, tokenIn, tokenOut)` once, which returns
everything needed: the Bucket snapshot, the open intent, and the tightest effective limits over the policy, the
Bucket's own usage, and the whole capability chain. All three are `view`, so `quote` and `swap` evaluate identically.

**`BucketCapabilityGuard` (0xd0)**

| Check | Error |
|---|---|
| `bucket.holder == maker`; status ACTIVE; strategy is the current generation's canonical one; venue allowed | `BucketMakerMismatch`, `BucketInactive`, `BucketStrategyNotCanonical`, `BucketVenueNotAllowed` |
| An intent is open, not expired, bound to the current policy version, in this fill's direction | `BucketNoOpenIntent`, `BucketIntentExpired`, `BucketIntentPolicyMismatch`, `BucketIntentDirectionMismatch` |
| taker == the intent's operator | `BucketTakerNotOperator` |
| The whole capability chain is valid *now*, and the leaf grants this intent's permission, both assets and the venue | `BucketCapabilities`' typed errors (`CapabilityRevokedError`, `CapabilityExpired`, `CapabilityPolicySuperseded`, `CapabilityPermissionDenied`, …) |

**`BucketQuote` (0xd1)**

| Check | Error |
|---|---|
| Reference prices fresh (`maxPriceAge`) | `BucketMathPriceStale` |
| (REBALANCE) Bucket out of policy, tokenOut overweight, tokenIn underweight | `BucketWithinPolicy`, `BucketDirectionInvalid` |
| `discount = tightestMaxSlippageBps · min(now − intent.openedAt, auctionDuration) / auctionDuration`; exact-in: `out = in · pIn/pOut · BPS/(BPS − discount)` (floor); exact-out mirrored (ceil) | `BucketZeroAmount` |
| (REBALANCE) value(out) ≤ excess(out); value(in) ≤ deficit(in) — no overshoot past target | `BucketTargetOvershoot` |

The concession starts at 0 and grows to the tightest `maxSlippageBps` in the capability chain over the auction
window: the first solver willing to fill gets the best price for the Bucket, and the Bucket never concedes more
than the narrowest limit anyone in the chain allows.

**`BucketSpendLimit` (0xd2)**

| Check | Error |
|---|---|
| value(out) ≤ effective `maxExecutionValue` / remaining hourly / remaining daily / remaining turnover | `BucketExecutionLimitExceeded`, `BucketHourlyLimitExceeded`, `BucketDailyLimitExceeded`, `BucketTurnoverLimitExceeded` |
| `amountOut` ≤ the intent's remaining budget | `BucketIntentBudgetExceeded` |
| `amountOut` ≤ the strategy's Aqua virtual balance | `BucketAquaBudgetExceeded` |

## Settlement verification (maker hooks)

The order sets `preTransferOut` and `postTransferIn` hooks targeting the controller, with the Bucket id as maker
hook data:

- `preTransferOut` (before Aqua `pull`): router-only; the strategy must be canonical for the current generation; an
  intent must be open; snapshots every asset balance into transient storage and sets an execution lock (every
  mutating controller function reverts while it is set).
- `postTransferIn` (after the taker's Aqua `push`): router-only; zero fee; the snapshot must belong to this order;
  the holder must have lost exactly `amountOut` of `tokenOut`, gained exactly `amountIn` of `tokenIn`, and every
  other balance must be unchanged; the intent kind's allocation invariant must hold (non-worsening deviation for a
  rebalance, both hard bands for a swap). Charges the capability chain's and the Bucket's own spend velocity,
  records an `ExecutionReceipt`, and closes the intent if it's fulfilled or the Bucket is back in policy.

Takers must use `useTransferFromAndAquaPush` and the default transfer order (pull first); any other combination
fails the exact-delta check and reverts.

## `BucketEngine`: the shared library

`libraries/BucketEngine.sol` is a linked (delegatecall) library holding the controller's heaviest deterministic
logic — strategy compilation (`program`, `strategyOrder`, `strategyHash`), rebalance planning (`planRebalance`),
settlement verification (`settle`, `requireAllocationInvariant`) and the Bucket-wide usage/limit math
(`snapshot`, `limits`, `maxValue`, `chargeBucket`). Splitting it out of `BucketController` exists purely to fit
under the EIP-170 24 KB runtime-size limit once capability-aware authorization, three SwapVM instructions and
payments all live behind one router — it carries no independent trust boundary of its own.
