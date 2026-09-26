# Security model

## Invariants and where they are enforced

| # | Invariant | EVM | Sui | Off-chain |
|---|---|---|---|---|
| A | A capability never grants an owner-only permission | `BucketPermissions.isDelegable`, checked at issuance | `permissions::is_delegable` | `isValidPermissionMask` / `isDelegablePermissionMask` |
| B | `ChildAuthority ⊆ ParentAuthority`, checked once at issuance (capabilities are immutable after) | `BucketCapabilities.delegate` | `capability::issue_child` | `isChildWithinParent` |
| C | No execution proceeds unless every link of the capability's chain is valid *right now* | `BucketCapabilities.requireAuthorized`, called by opcode `0xd0` | `capability::check_link` + `check_leaf`, called from `bucket::bucket` | — |
| D | Cumulative usage never exceeds hourly/daily/turnover limits, for the capability chain *and* the Bucket as a whole | `BucketCapabilities.consume` + `BucketController._chargeBucket` | `capability::charge` + the Bucket's own `usage` field | — |
| E | Ownership never moves except through the identity layer | EVM ownership = ENSv2 name ownership; no Bucket function writes it | `OwnerCap` minted exactly once at `create_bucket`, transferable only as a whole object | — |
| F | Withdrawal is never delegable | `PERM_WITHDRAW ∉ DELEGABLE_PERMISSIONS` | same bit excluded from `permissions::delegable()` | `OWNER_ONLY_PERMISSIONS` |
| G | Rebalances/swaps stay within every limit in the chain | opcode `0xd2` (`BucketSpendLimit`) | n/a (Sui has no rebalance path) | `simulateFill` |
| H | Slippage bounded by the tightest limit in the chain | opcode `0xd1` (`BucketQuote`): concession ≤ `chainLimits(...).maxSlippageBps` | n/a | — |
| I | Only permitted assets; payments only to the capability's fixed payee | opcodes `0xd0`/`0xd2` + maker hooks; `BucketController.pay` | `bucket::bucket::pay` (payee check) | — |
| J | Accounting matches execution exactly | maker hooks: exact deltas on exactly two balances, zero fee | Move's own balance/coin type system (no separate reconciliation needed) | — |
| K | Post-state verifiable | maker hooks: non-worsening allocation (rebalance) / hard-band compliance (swap) | n/a | — |
| L | A capability's identity is still live, not just live at issuance | `_getRoles`/`ownerIn` re-resolve the ENSv2 registry on every `requireAuthorized` call | `check_link` re-derives nothing — Sui capabilities have no separate identity re-resolution step; the `OperatorCap` object *is* the live proof of possession | — |
| M | (Sui EAC, ENSv2) A protected operation requires the caller to hold the matching resource-scoped role on *this* Bucket's resource (its object address), or the same role on `ROOT_RESOURCE` | n/a | `bucket::require_role` → `access::has_roles` (effective = resource OR root), called from `charge_for_payment` (shared by `pay`/`pay_many`/`pay_bucket_to_bucket`) against the shared `access::AccessControl`; resource isolation is structural via the `(resource, account)` key | — |
| N | (Sui EAC, ENSv2) A role never escalates: to grant/revoke a role you must hold its admin role (`R<<128`); a regular-role holder can grant nothing and an admin can grant only the roles it administers (and that admin role itself) | n/a | `access::grant_roles`/`revoke_roles` check `bitmap & ~withAdminRolesApplied(effective_roles) == 0` (`ECannotGrantRoles`); owner-bootstrap (`bucket::owner_grant_roles`) is `OwnerCap`-gated and can never touch `ROOT_RESOURCE` | — |
| O | (Sui EAC) A SuiNS name grants authority only to the address it resolves to *at grant time*; re-pointing the name never transfers an existing grant | n/a | `access::resolve_target` (real `suins::registry::lookup`) binds the role to the resolved address; grants are keyed by address, never by name | — |
| P | (Sui EAC, ENSv2) A `ROOT_RESOURCE` grant applies to every Bucket; `grant_roles`/`revoke_roles` refuse the root resource so it is only ever set through the explicit root path | n/a | `access::has_roles` ORs `roles[ROOT]`; `grant_roles`/`revoke_roles` abort `ERootResourceNotAllowed` on root; `grant_root_roles`/`revoke_root_roles` are the only root path (admin-checked) | — |

## Custody model, explicitly

A Bucket never holds tokens on the EVM side. Its `holder` is the owner's own wallet. The controller's only transfer
authority is:

1. Aqua `pull`/`push` of the canonical strategy the holder itself shipped, bounded by that strategy's Aqua virtual
   balance and the holder's own ERC-20 allowance to Aqua.
2. A capability-gated payment, inside the holder's explicit ERC-20 allowance to the controller, only to that
   capability's fixed payee.

The holder can exit at any time without this protocol: revoke the Aqua allowance, `Aqua.dock` an active strategy, or
revoke the controller's allowance. No Bucket function can move funds the holder hasn't explicitly allowed, to a
destination the holder (via the capability it issued) hasn't fixed.

On Sui, funds *do* sit in the Bucket object's own vault (a `Bag` of `Balance<T>`) — this is a deliberate difference
from the EVM design, matching Sui's object model: `withdraw` is owner-only and unrestricted, `pay`/`pay_many`/
`pay_bucket_to_bucket` are capability-gated and limited exactly as described above.

## Reentrancy and ordering (EVM)

- All mutating controller functions: `nonReentrant` (transient) + `notExecuting`.
- Settlement lock: `preTransferOut` sets a transient execution slot; any Bucket operation attempted from a taker
  callback between `pull` and `push` reverts; the post hook requires the slot to match the order.
- SwapVM already locks per `orderHash`; Aqua `pull` is limited to the strategy's virtual balance.
- The controller only accepts hooks from the immutable router and only for the Bucket's active intent, and only for
  the current strategy generation (`rotateStrategies` retires every previously shipped strategy).

## Trust assumptions (explicit)

1. **Reference prices (EVM only).** Valuation uses `IBucketPriceFeed`. The deployed `BucketReferencePriceFeed` is
   reporter-published because testnet tokens have no market; any oracle implementing the interface can replace it.
   A malicious reporter could misprice a fill by up to the reported price error (the concession cap still applies).
   Every consumer enforces `maxPriceAge`.
2. **No price oracle on Sui.** Sui-native spend-velocity limits are denominated in a coin's own smallest units, and
   the daily-turnover check is measured against that Bucket's own current vault balance of the *same* coin — a
   deliberate simplification for a settlement-focused stack with no cross-asset pricing, not an oversight. Limits
   across different coin types in one Bucket are not value-normalized against each other.
3. **EVM/Sui attribution, not shared trust.** `bind_evm` on a Sui Bucket and `record_evm_receipt` exist purely so a
   UI can show one execution history across both chains. Sui does not, and cannot, re-derive EVM's price-based
   allocation math from a receipt; it checks only what it can verify without an oracle (strict execution-nonce
   order, and that the report is for the bound EVM twin). The two capability registries are never merged; an EVM
   capability and a Sui capability are always separate objects, independently issued and independently enforced.
4. **Test assets.** `tUSDC`, `tETH`, `tSUI`, `tPEPE` are ordinary ERC-20s whose minting is restricted to the deployer.
   `tPEPE` is deliberately never added to any Bucket policy, to demonstrate the unapproved-asset rejection path.
5. **Aqua deployment.** On Sepolia, Aqua is deployed from the official unmodified source because no official Sepolia
   deployment exists.
6. **Guardians are a lighter-weight role than ownership.** A Bucket guardian (EVM: an ENSv2-resolved address holding
   the `ROLE_GUARDIAN` EAC role; Sui: a plain address in the Bucket's `guardians` set) can pause and revoke, never
   withdraw, never change ownership, never resume from pause. Losing an `OwnerCap`/the ENSv2 name is catastrophic
   with no recovery path in this implementation; that is the honest cost of true self-custody.

## Known limitations

- The Sui SDK does not yet decode an individual capability or vault balance directly from a Bucket object's BCS
  content — `Table`/`Bag` entries are Sui dynamic-field children, not inline data. Read them via the Move view
  functions (`bucket::get_capability`, `bucket::vault_balance`) with a `devInspect`-style call against whichever
  concrete Sui client (JSON-RPC, gRPC) the host application has; this is flagged explicitly in
  `packages/sdk/src/sui/bucket.ts`.
- There is no dedicated Sui end-to-end *network* demo script yet (`scripts/demo/run.ts` covers the EVM stack only).
  The full EAC flow (resolve SuiNS → grant role → authorized payment → revoke → rejection) is exercised as real Sui
  Move execution by the `bucket::access_tests` suite; a network demo additionally needs a deployed package and the
  testnet SuiNS shared-object id wired into the scripts.
- The Sui EAC and payment paths have an automated Move test suite (`contracts/sui/tests/access_tests.move`, 18 tests,
  all passing under `sui move test`), covering resource isolation, role bitmaps, per-role admin semantics, the
  ROOT_RESOURCE fallback, grant/revoke, unauthorized principals, SuiNS resolution, EAC ∧ capability/policy/state, and
  privilege-escalation prevention. The EVM contracts are covered by `forge` tests; neither layer has been exercised
  against a live testnet beyond compilation in this pass.
- The EAC layer is a shared `access::AccessControl` object created once by the module's `init` at publish; the deploy
  script must capture its object id, and every payment / grant / role check passes it. `ROOT_RESOURCE` is left
  unseeded in production by design (no global admin backdoor to per-Bucket self-custody); the mechanism is exercised
  in tests via a `#[test_only]` seed.
- The ENSv2 per-role **assignee counter** (max 15 holders per role) is intentionally not ported — it is an
  operational cap, not an authorization rule.
- On-chain SuiNS resolution requires the SuiNS package as a Move dependency (`suins`, added in `contracts/sui/Move.toml`
  with an `override` on the Sui framework rev so it resolves against `testnet-v1.80.1`). Actual name resolution at
  runtime needs the live SuiNS shared object id for the target network.
