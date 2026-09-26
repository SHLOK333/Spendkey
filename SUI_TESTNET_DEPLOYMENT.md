# SUI TESTNET DEPLOYMENT

All results in this document were directly observed from Sui Testnet CLI or gRPC responses.

---

## Network

| Field | Value |
|---|---|
| Network | Sui Testnet |
| Chain ID | `69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD` |
| Epoch at publish | 1234 |
| gRPC endpoint | `https://fullnode.testnet.sui.io:443` |

---

## Deployer

| Field | Value |
|---|---|
| Alias | `bucket-testnet-deployer` |
| Address | `0xa5bc69b87f98bfb47e6fae168991353ebc0805f398dfe011fa89dbf5e0702176` |
| Key scheme | ed25519 (dedicated testnet-only key, created this session) |
| Funded balance | 1.00 SUI (faucet) |
| Remaining balance | 0.80 SUI |

---

## Funding

| Field | Value |
|---|---|
| Source | Official Sui Testnet faucet (`https://faucet.sui.io`) |
| Amount received | 1,000,000,000 MIST (1.00 SUI) |
| Verified by | `sui client balance` showing `1.00 SUI` before publish |

> **Note:** The CLI `sui client faucet` is disabled for testnet (returns web-only redirect). Funding was obtained via the web UI at `https://faucet.sui.io/?address=0xa5bc69b87f98bfb47e6fae168991353ebc0805f398dfe011fa89dbf5e0702176`.

---

## Build and Test Results

| Check | Result |
|---|---|
| `.tools/sui move build` | ✅ **SUCCESS** — BUILDING bucket (MoveStdlib, Sui, suins dependencies resolved). Use `.tools/sui.exe` (v1.80.1), not system `sui` (v1.38.1). |
| `.tools/sui move test` | ✅ **18/18 PASSED** — all access_tests pass (deprecation warnings only, no errors) |
| `pnpm -r run typecheck` | ✅ **5/5 packages clean** — protocol-types, vm, sdk, apps/web, scripts |

---

## Package Publication

| Field | Value |
|---|---|
| **Package ID** | `0x145ba9b61b1e7c022af62b0fb3160a835d8592eacfd1c5e96f261fc44b4b1153` |
| **Publish transaction** | `BUYwLkVRfNgjbiZQNJyvDVZfxufabSiot4EonUf3yVa3` |
| Status | Success |
| Epoch | 1234 |
| Gas used | storage 187,803,600 + computation 2,160,000 − rebate 978,120 = ~189 MIST net |
| Modules published | `access`, `bucket`, `capability`, `codec`, `permissions`, `policy`, `receipt` |
| UpgradeCap | `0xecc62450b45c1fbb9eeab5d3d5665532e9361941d8bed5df8397d7e4da00c35e` (deployer-owned) |

**Explorer:** https://suiscan.xyz/testnet/tx/BUYwLkVRfNgjbiZQNJyvDVZfxufabSiot4EonUf3yVa3

---

## Shared Objects Created at Publish

| Object | ID | Type |
|---|---|---|
| **AccessControl** | `0xf763e21898521dfd4cf7e4b7eb725ad8eb6f4414d3e4b39f02e230e0e244bfe5` | `::access::AccessControl` (Shared, initialSharedVersion 349181961) |

**AccessControl Explorer:** https://suiscan.xyz/testnet/object/0xf763e21898521dfd4cf7e4b7eb725ad8eb6f4414d3e4b39f02e230e0e244bfe5

The `access::init` function ran at publish and shared this singleton automatically. Every `pay`/`grant_roles`/etc. call passes it as a parameter.

---

## On-Chain BUCKET Flow

A real `create_bucket` transaction was executed using `scripts/create_bucket_testnet.ts` (TypeScript, via `tsx`), using the SDK's `buildPolicyArgument` path (`policy::new_assets` → `policy::new` → `bucket::create_bucket`).

### Transaction

| Field | Value |
|---|---|
| **Transaction digest** | `HLaDw8LRx6DyyDhpDm92q8rn46M3SQjc5GBYvJs8yus3` |
| Status | Success |
| Sender | `0xa5bc69b87f98bfb47e6fae168991353ebc0805f398dfe011fa89dbf5e0702176` |
| Gas used | computation 1,000,000 + storage 6,368,800 − rebate 978,120 |

**Explorer:** https://suiscan.xyz/testnet/tx/HLaDw8LRx6DyyDhpDm92q8rn46M3SQjc5GBYvJs8yus3

### Created Objects (verified via gRPC `getObjects`)

| Object | ID | Type | Owner |
|---|---|---|---|
| **Bucket** | `0x03ca254481432de995613bfa31314c7d5f4cbefdeb1cfc8859c0540543809314` | `::bucket::Bucket` | Shared (initialSharedVersion 1029742250) |
| **OwnerCap** | `0x882bf79499a189cb3972b3553590b655a3873a45b847aa98e87cd1956087c5c5` | `::bucket::OwnerCap` | deployer address |

**Bucket Explorer:** https://suiscan.xyz/testnet/object/0x03ca254481432de995613bfa31314c7d5f4cbefdeb1cfc8859c0540543809314

**OwnerCap Explorer:** https://suiscan.xyz/testnet/object/0x882bf79499a189cb3972b3553590b655a3873a45b847aa98e87cd1956087c5c5

The Bucket's `resource` id (used as the EAC key) equals its own object address:
`0x03ca254481432de995613bfa31314c7d5f4cbefdeb1cfc8859c0540543809314`

---

## SuiNS Integration Script

`scripts/register_suins.ts` implements the full end-to-end SuiNS ↔ BUCKET test:

### SuiNS Constants (on-chain verified)

| Name | Value |
|---|---|
| SuiNS object | `0x300369e8909b9a6464da265b9a5a9ab6fe2158a040e84e808628cde7a07ee5a3` (ISV 22205838) |
| SuiNS package v2 | `0x40eee27b014a872f5c3330dcd5329aa55c7fe0fcc6e70c6498852e2e3727172e` |
| Payments package | `0x4f33a0e1e30530f2aa500a41b9e3d502f8af3ef2c20bd0a1e42374e329da7cb0` (v2 upgrade of `0x9e8b85...`) |
| BBB Vault | `0xa0b7a4dcbb85209c9096a4e0e85e43b716377c605743193abe915e9c9f3043e5` (ISV 503149575) |
| SUI/USD PriceInfoObject | `0x867877562b5d8ac262d93b02062e04b428a2f9bfbb2f05b8af52e04cd98bd241` (ISV 854938920, actively updated by Pyth keepers) |
| Domain | `bucketprotocol.sui` |

### Registration PTB flow (TX1)

1. `payment::init_registration(suins, domain)` → PaymentIntent (hot potato, no clock)
2. `payments::calculate_price_after_discount(suins, intent)` → base_amount (USDC micro-units)
3. `payments::calculate_price_pro<SUI>(suins, base_amount, clock, price_info)` → sui_amount (MIST)
4. `splitCoins(gas, [sui_amount])` → payment_coin
5. `payments::handle_payment_pro<SUI>(suins, bbb_vault, intent, payment_coin, clock, price_info, MAX_U64)` → Receipt
6. `payment::register(receipt, suins, clock)` → SuinsRegistration NFT
7. `controller::set_target_address(suins, nft, Some(deployer), clock)` (TX0 later repoints it to the operator)
8. `transferObjects([nft], deployer)`

Registration price (read from the chain via simulation): base 1,000,000 USDC micro-units ($1) → **0.8477 SUI** at the
live Pyth price, plus ~0.02 SUI gas. The shared PriceInfoObject goes stale between keeper updates
(`pyth::check_price_is_fresh` abort 3); the script retries until it is fresh.

### Steps TX0–TX4

The EAC principal is a dedicated **operator** address (`SUI_OPERATOR_PRIVATE_KEY` in `.env`), not the deployer:
`bucket::has_role` intentionally treats the Bucket owner as holding every role, so revoking a role from the owner
can never take effect and would not test anything.

- TX0: `controller::set_target_address(nft → operator)` + fund operator with 0.05 SUI gas
- TX2: `update_policy(...)` (see note) + `owner_grant_roles_by_suins(ac, bucket, owner_cap, suins, "bucketprotocol.sui", ROLE_PAY, clock)` + `issue_capability(operator, PERM_PAY, asset_mask=0x01, 7-day window, payee=deployer)` + `deposit<SUI>(0.1 SUI)`
- TX3: `pay<SUI>(bucket, ac, op_cap, deployer, 1000, deadline, clock)` — signed by the operator, authorized
- TX4: `owner_revoke_roles(ac, bucket, owner_cap, ROLE_PAY, operator, clock)`
- dry5: `simulateTransaction(pay)` as the operator after revoke — rejected

**Policy note:** TestBucket was created with the asset string `"0x2::sui::SUI"`, but `accepted_type` compares against
`type_name::with_defining_ids<T>().into_string()` = `0000…0002::sui::SUI`, so every SUI deposit/pay aborted with
611. TX2 reinstalls the identical policy (same limits, delegable = 7) with the canonical string via the owner's
`update_policy`. No contract change.

### Result: VERIFIED on Testnet (2026-09-26)

| Item | Value |
|---|---|
| SuiNS name | `bucketprotocol.sui` |
| SuinsRegistration NFT | `0x88ce39063084dbfc494fa5f288adfa80d0bf955adedd8c85703f6cf764e2af58` (owned by deployer, expires 2027-09-25) |
| Resolves to (operator) | `0xea272f9f358837531ead9250cbfcb615c034ec5492ca84cd900889d423b6110f` |
| OperatorCap | `0x8d81b2b4891679533b8bf5d5c8b8e10575b38b393e882986f19885c311afa361` |
| Post-revoke `pay` | **Rejected** — `MoveAbort 621 (ENotAuthorizedRole)` in `bucket::require_role` |

| Transaction | Digest | Explorer |
|---|---|---|
| TX1 register `bucketprotocol.sui` | `B7BJpjtWk3JXFVCEC5VFasebyHGEeBsSzLKjgsCTKVWJ` | [link](https://suiscan.xyz/testnet/tx/B7BJpjtWk3JXFVCEC5VFasebyHGEeBsSzLKjgsCTKVWJ) |
| TX0 target → operator + fund | `CLsykr3SGSUhpASLZYxrHrtTgvmkUHBEDcRWpDEyspg2` | [link](https://suiscan.xyz/testnet/tx/CLsykr3SGSUhpASLZYxrHrtTgvmkUHBEDcRWpDEyspg2) |
| TX2 policy fix + grant by SuiNS + cap + deposit | `2DpjUqjWxZ88ME9WGBwUrnUANYyb2cAXZaKcm8JUui44` | [link](https://suiscan.xyz/testnet/tx/2DpjUqjWxZ88ME9WGBwUrnUANYyb2cAXZaKcm8JUui44) |
| TX3 authorized `pay<SUI>` | `9YRKeYji695uTPuMu6DYCTVgnSaK3tgYRwN1kVPtq4F4` | [link](https://suiscan.xyz/testnet/tx/9YRKeYji695uTPuMu6DYCTVgnSaK3tgYRwN1kVPtq4F4) |
| TX4 `owner_revoke_roles` | `4yPjJnxiWsdkZ6F1Sp7ec1pzNG6s92eFF5aziF96befZ` | [link](https://suiscan.xyz/testnet/tx/4yPjJnxiWsdkZ6F1Sp7ec1pzNG6s92eFF5aziF96befZ) |

Earlier runs (superseded; the name then targeted the deployer, so the post-revoke check was not meaningful):
`FJYaZCWsvUF9t53ezLTcszU8krM61T172gHyP4s4KT1y`, `79R3HV36TrD2heFsvfSjAW5NumTRnYLLuRFkKxBeeaG7`,
`GvCG7R3yVuhPWFY44YjieKRnTFypseg2db35diuUyRci`, `FxKdJ4RrQSXtMTJAUCQN66iPBLQDgDAamtQT82pMpTtz`.

Re-run: `npx tsx scripts/register_suins.ts` (skips registration if the NFT exists; each run bumps the policy version).

---

## All Relevant Object IDs (Summary)

| Name | Object ID | Explorer |
|---|---|---|
| Package | `0x145ba9b61b1e7c022af62b0fb3160a835d8592eacfd1c5e96f261fc44b4b1153` | [link](https://suiscan.xyz/testnet/object/0x145ba9b61b1e7c022af62b0fb3160a835d8592eacfd1c5e96f261fc44b4b1153) |
| AccessControl | `0xf763e21898521dfd4cf7e4b7eb725ad8eb6f4414d3e4b39f02e230e0e244bfe5` | [link](https://suiscan.xyz/testnet/object/0xf763e21898521dfd4cf7e4b7eb725ad8eb6f4414d3e4b39f02e230e0e244bfe5) |
| UpgradeCap | `0xecc62450b45c1fbb9eeab5d3d5665532e9361941d8bed5df8397d7e4da00c35e` | [link](https://suiscan.xyz/testnet/object/0xecc62450b45c1fbb9eeab5d3d5665532e9361941d8bed5df8397d7e4da00c35e) |
| Bucket (TestBucket) | `0x03ca254481432de995613bfa31314c7d5f4cbefdeb1cfc8859c0540543809314` | [link](https://suiscan.xyz/testnet/object/0x03ca254481432de995613bfa31314c7d5f4cbefdeb1cfc8859c0540543809314) |
| OwnerCap (TestBucket) | `0x882bf79499a189cb3972b3553590b655a3873a45b847aa98e87cd1956087c5c5` | [link](https://suiscan.xyz/testnet/object/0x882bf79499a189cb3972b3553590b655a3873a45b847aa98e87cd1956087c5c5) |

| Transaction | Digest | Explorer |
|---|---|---|
| Publish | `BUYwLkVRfNgjbiZQNJyvDVZfxufabSiot4EonUf3yVa3` | [link](https://suiscan.xyz/testnet/tx/BUYwLkVRfNgjbiZQNJyvDVZfxufabSiot4EonUf3yVa3) |
| Create Bucket | `HLaDw8LRx6DyyDhpDm92q8rn46M3SQjc5GBYvJs8yus3` | [link](https://suiscan.xyz/testnet/tx/HLaDw8LRx6DyyDhpDm92q8rn46M3SQjc5GBYvJs8yus3) |
