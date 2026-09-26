# Architecture

## The Financial Capability model

BUCKET implements the **Financial Capability** concept — scoped, revocable, hierarchical, non-escalating, limited —
on the EVM execution layer:

| | EVM execution layer |
|---|---|
| Identity | ENSv2 (Sepolia) |
| Authorization | `BucketCapabilities` |
| Custody | The owner's own wallet (`holder`); no vault contract |
| Execution | SwapVM (`0xd0`-`0xd3`) + 1inch Aqua |

## The Financial Capability, precisely

A capability is immutable once issued. Its fields (EVM `Capability` / `CapabilityLimits`):

```
bucketId, parentId, issuer, operator, depth
permissions (bitmask), assetMask, venueMask (EVM only)
validAfter, validUntil
policyVersion, epoch, nonce
payee (fixed destination for PERM_PAY, or none)
limits: maxExecutionValue/maxPerTx, maxHourlyValue/maxHourlySpend, maxDailyValue/maxDailySpend,
        maxSlippageBps (EVM only), maxDailyTurnoverBps, maxExecutions
usage: cumulative spend in fixed hour/day windows
```

**Issuance** validates the requested grant against the issuing policy (root) or the parent capability (child):
permissions ⊆ delegable/parent's, assets ⊆ policy's/parent's, window ⊆ parent's, every limit ≤ parent's, and (if it
pays) the same fixed payee as its parent. This is the whole of `ChildAuthority ⊆ ParentAuthority` — checked once,
never re-derivable afterward because the capability's content never changes.

**Live validation**, on every single use, walks the chain from leaf to root and requires, at each link: not revoked,
not exhausted, current epoch, current policy version, inside the time window, and — critically — that the operator
*still* owns the identity it was issued to (ENSv2 name still owned on EVM; Sui has no separate re-resolution step
because the `OperatorCap` object itself *is* the live proof of possession, so losing the object is losing the
authority). This is why revocation, epoch bumps and policy changes work without touching every descendant: each is
a single field that every existing capability's live check reads fresh.

**Spend velocity** is charged to the leaf *and every ancestor* on every execution: a parent's hourly/daily ceiling
bounds every capability it (transitively) delegated, together, not each independently.

## EVM: identity mapping (no shared-address assumption)

EVM and Sui accounts are unrelated key spaces. A Bucket's EVM identity is:

```
bucketId = keccak256(abi.encode(keccak256("BUCKET_ID_V1"), chainId, controller, registry, labelhash(label)))
```

computable off-chain before any transaction and cross-checked against the controller's own `computeBucketId`. If a
Sui twin exists, its `EvmBinding` carries this same `bucketId` plus the controller and holder addresses, purely so
a UI or `record_evm_receipt` caller can prove which EVM Bucket a Sui record refers to — never as a shared trust
boundary (see `docs/SECURITY.md`).

## Policy commitment

Both the EVM `PolicyParams`/`AssetConfig[]` and the Sui `bucket::policy::Policy` commit to their content with a
keccak256 digest (`BucketPolicyLib.hash` / `policy::hash`), so a policy version can be proven byte-for-byte without
trusting a live read. The two policies are **not required to be identical** — the EVM policy governs Aqua/SwapVM
rebalancing (target weights, slippage, price freshness); the Sui policy governs native payment velocity (no price
concept at all). They are independent instances of the same commitment *pattern*, not one shared schema.

## EVM authority model (ENSv2)

```
shlok.eth                     ETHRegistry label, owned by the user
 └─ UserRegistry (owner)      owner holds root registrar/subregistry roles
     ├─ trading.shlok.eth     Bucket name  → Bucket owner = getOwner(labelhash("trading"))
     │   └─ UserRegistry
     │       └─ agent.trading.shlok.eth    operator identity (no token roles; owner can unregister it)
     ├─ savings.shlok.eth
     └─ payments.shlok.eth
```

`BucketAuthority` extends ENSv2 `EnhancedAccessControl` for exactly one thing: guardianship (`ROLE_GUARDIAN`),
granted to the live owner of `<label>.<bucket name>` and re-checked live the same way ownership is. **Operators hold
no EAC role at all** — an operator's authority is a `BucketCapabilities` object, resolved by ENSv2 name only to
determine which address is allowed to exercise it right now. This is the key structural change from a
role-based-access model: the registry answers "who is this identity", never "what may it do".

Permission bits (`BucketPermissions` on both EVM and Sui, identical numbering):

| bit | permission | delegable |
|---|---|---|
| 0 | REBALANCE | yes |
| 1 | SWAP | yes |
| 2 | PAY | yes |
| 3 | DELEGATE | yes |
| 4 | UPDATE_POLICY | **never** |
| 5 | CHANGE_OWNER | **never** |
| 6 | WITHDRAW | **never** |

## Aqua lifecycle (EVM)

Strategies are immutable once shipped. A Bucket has exactly one canonical strategy per asset pair per "strategy
generation" (`BucketController.rotateStrategies` starts a new generation, retiring every previously shipped
strategy at once — the emergency stop for the execution layer itself, independent of capability revocation):

```
openRebalanceIntent / openSwapIntent → holder ships the canonical Aqua strategy for the pair (idempotent: the
    same strategy generation always compiles to the same order) → fill via BucketSwapVMRouter.swap →
    pull(tokenOut → operator), push(tokenIn → holder) → maker hooks verify → capability + Bucket usage charged →
    intent closed (fulfilled, or superseded by the next one)
```

`orderHash` (SwapVM Aqua mode) equals the Aqua `strategyHash` (`keccak256(abi.encode(order))`); the taker (SDK)
verifies this and every hook target before ever calling `swap` (`@bucket/vm`'s `verifyBucketOrder`).

## Sui: BUCKET Enhanced Access Control (ENSv2 semantics)

SuiNS does **not** provide ENSv2-style Enhanced Access Control. BUCKET implements its own Move-native EAC layer
(`bucket::access`) that **ports the actual ENSv2 `EnhancedAccessControl` semantics** (`@ensdomains/contracts-v2`),
not merely an EAC-inspired one; SuiNS supplies only the human-readable identity/name layer. Each layer is enforced
in Move:

```
SuiNS name/subname        WHO           on-chain resolution to a live target address (suins::registry::lookup)
        ↓
resolved principal        (the security-critical identity — never the string)
        ↓
BUCKET EAC                WHAT AUTHORITY resource-scoped role bitmap (bucket::access, ENSv2 semantics)
        ↓
Financial Capability      CONSTRAINTS   permissions, assets, per-tx/hourly/daily/turnover limits, validity, epoch
        ↓
Policy + Bucket state     CONSTRAINTS   accepted assets, policy version, not paused/closed
        ↓
Move                      ENFORCEMENT   the transaction aborts if any layer refuses
```

Semantics reproduced from ENSv2:

- **Shared, multi-resource registry.** A single shared `access::AccessControl` object holds
  `Table<(resource, account), u256>` — exactly ENSv2's `mapping(resource => mapping(account => roleBitmap))`. A
  Bucket's **resource id is its own object address** (`bucket::bucket_resource`), so a role on Bucket #42 is a
  different key from #43 and never leaks across resources.
- **`ROOT_RESOURCE` (`@0x0`).** Effective roles = `roles[ROOT][account] | roles[resource][account]`; a grant on the
  root resource applies to *every* Bucket. `grant_roles`/`revoke_roles` reject the root resource; `grant_root_roles`/
  `revoke_root_roles` handle it — matching ENSv2 exactly.
- **Nybble-packed `u256` bitmap.** Each role occupies one nybble (`role N = 1<<(N*4)`); the lower 128 bits are 32
  regular roles, the upper 128 bits their admin roles (`admin(R) = R<<128`). `ALL_ROLES = 0x1111…`. BUCKET roles:
  `ROLE_VIEW`(0), `ROLE_PAY`(1), `ROLE_REBALANCE`(2), `ROLE_EXECUTE`(3), `ROLE_GUARDIAN`(4). Multiple roles OR into
  one grant.
- **Per-role admin roles (not a single super-admin).** Holding admin role `R<<128` authorizes granting/revoking
  both the regular role `R` and the admin role itself — ENSv2's `withAdminRolesApplied`. `grant_roles` checks that
  every bit is within the caller's settable set (`ECannotGrantRoles` otherwise), so a regular-role holder can grant
  nothing and an admin can only grant the specific roles it administers. This is the exact ENSv2 anti-escalation
  rule; the earlier single-`ROLE_ADMIN` model is gone.
- **`grant_roles` / `revoke_roles` / `has_roles`** match ENSv2's `grantRoles` / `revokeRoles` / `hasRoles`
  (effective-role check with root fallback).

Adapted for Move / BUCKET (see `docs/SECURITY.md`):

- **Owner bootstrap** replaces ENSv2's registrar seeding. A Bucket's `OwnerCap` holder is the root authority for
  that Bucket's resource: `bucket::owner_grant_roles` / `owner_grant_roles_by_suins` / `owner_revoke_roles` seed
  roles on the Bucket's own resource with no pre-existing admin role, and can never touch the root resource. After
  seeding an admin role, the plain ENSv2 `access::grant_roles` path (admin-checked) takes over.
- **Assignee counting** (ENSv2's max-15-holders-per-role nybble counter, an operational cap, not an authorization
  rule) is intentionally not reproduced.
- **SuiNS is identity only.** Roles bind to the *resolved address*, never the name string; re-pointing a name never
  transfers an existing grant (a fresh grant is required). Subnames resolve through the same `registry::lookup`.
- **EAC never replaces the capability system.** A payment requires `ROLE_PAY` **and** a live `PAY` capability **and**
  the policy accepting the asset **and** the Bucket active **and** the amount within every velocity limit — one AND,
  enforced at the single spend boundary `charge_for_payment` (shared by `pay`/`pay_many`/`pay_bucket_to_bucket`),
  which now takes the shared `AccessControl`. The owner implicitly holds every role for its own Bucket.
- **Guardian bridge.** The owner-bootstrap path also adds/removes a `ROLE_GUARDIAN` principal to the existing
  `guardians` set, so the audited pause/`revoke_all` path is unchanged; a guardian still cannot withdraw or change
  ownership.

The SuiNS integration uses the real on-chain package (`suins::registry::lookup` → `name_record::target_address`,
`suins::domain`), added as a Move dependency (see `Move.toml`). See `docs/SECURITY.md` for the full invariant list.

## Sui object

`bucket::bucket::Bucket` (shared): name, owner, optional `EvmBinding`, policy + its commitment, capability epoch
and nonce counter, a `Table<u64, Capability>` of every issued capability, Bucket-wide usage, guardians (`VecSet`),
an optional receiving policy, a native vault (`Bag` of `Balance<T>`), EVM-attribution counters, status, object
version, timestamps. EAC roles live in the separate shared `access::AccessControl` registry, keyed by
`(resource, account)` where the resource is the Bucket's own object address (this is what makes `ROOT_RESOURCE`
possible — one registry spans all Buckets).

Capabilities: `OwnerCap` (key + store, transferable — the one object in this protocol deliberately made
transferable, so it can live in cold storage or a multisig) and `OperatorCap` (key only, non-transferable after its
initial mint, one per issued capability, the live proof of operator identity).

Events: `BucketCreated`, `BucketEvmBound`, `BucketPolicyUpdated`, `BucketStatusUpdated`, `GuardianUpdated`,
`CapabilityIssued`, `CapabilityRevoked`, `CapabilityExhausted`, `CapabilityEpochAdvanced`, `VaultUpdated`,
`PaymentExecuted`, `BucketToBucketPayment`, `EvmReceiptRecorded`; plus `access::RolesGranted` / `access::RolesRevoked`
from the EAC registry.

## Financial math

- Integer only; WAD (1e18) for EVM USD values/prices/weights, basis points for policy weights.
- Token amounts normalised to 18 decimals by pure up-scaling (policy rejects decimals > 18).
- `mulDiv` full-precision; every rounding direction favours the Bucket (see `BucketMath`'s header comment).
- The TypeScript mirror (`@bucket/vm`) reproduces every EVM rounding step so the SDK can size fills to the exact
  on-chain maximum (`maxFillAmountIn`, binary search over the exact simulator) and simulate a fill's accept/reject
  outcome before ever sending a transaction.
- Sui-native payments carry no price concept: velocity limits are raw coin units, and turnover is measured against
  that Bucket's own current vault balance of the same coin (see `docs/SECURITY.md` for why).
