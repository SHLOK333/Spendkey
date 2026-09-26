import type { SuiAssetPolicy, SuiBucketState, SuiEvmBinding, SuiPolicy, SuiReceivingPolicy } from '@bucket/protocol-types'
import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'
import { Transaction, type TransactionArgument } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { bytesToHex, getAddress, hexToBytes, type Address, type Hex } from 'viem'

import { BucketBcs, BytesBcs, CapabilityBcs, OperatorCapBcs, OwnerCapBcs, StringVectorBcs, U16VectorBcs } from './bcs'

export const SUI_CLOCK = '0x6'

function target(
  packageId: string,
  module: 'bucket' | 'policy' | 'capability' | 'access',
  fn: string,
): `${string}::${string}::${string}` {
  return `${packageId}::${module}::${fn}`
}

function bytesHex(bytes: readonly number[] | Uint8Array): Hex {
  return bytesToHex(Uint8Array.from(bytes))
}

function toU128(value: bigint): bigint {
  if (value < 0n || value >= 1n << 128n) throw new RangeError(`${value} does not fit in u128`)
  return value
}

function evmAddressBytes(address: Address): Uint8Array {
  return hexToBytes(getAddress(address))
}

/** Financial Capability limits (`bucket::capability::Limits`), in native raw units of whatever coin type the
 *  capability's `assetMask` selects — there is no price oracle on the Sui side (see the Bucket module doc). */
export interface SuiLimits {
  readonly maxPerTx: bigint
  readonly maxHourlySpend: bigint
  readonly maxDailySpend: bigint
  readonly maxDailyTurnoverBps: number
  readonly maxExecutions: number
}

export interface SuiCapabilityGrantInput {
  readonly operator: string
  readonly operatorName: string
  readonly permissions: number
  readonly assetMask: number
  readonly validAfter: bigint
  readonly validUntil: bigint
  readonly payee: string
  readonly limits: SuiLimits
}

function limitsArgument(tx: Transaction, packageId: string, limits: SuiLimits): TransactionArgument {
  return tx.moveCall({
    target: target(packageId, 'capability', 'new_limits'),
    arguments: [
      tx.pure.u128(toU128(limits.maxPerTx)),
      tx.pure.u128(toU128(limits.maxHourlySpend)),
      tx.pure.u128(toU128(limits.maxDailySpend)),
      tx.pure.u16(limits.maxDailyTurnoverBps),
      tx.pure.u32(limits.maxExecutions),
    ],
  })
}

/** Builds the Move `vector<AssetPolicy>` + `Policy` values inside a transaction. */
export function buildPolicyArgument(tx: Transaction, packageId: string, policy: SuiPolicy): TransactionArgument {
  const assets = tx.moveCall({
    target: target(packageId, 'policy', 'new_assets'),
    arguments: [
      tx.pure(StringVectorBcs.serialize(policy.assets.map((a) => a.coinType))),
      tx.pure(U16VectorBcs.serialize(policy.assets.map((a) => a.targetBps))),
    ],
  })
  return tx.moveCall({
    target: target(packageId, 'policy', 'new'),
    arguments: [
      tx.pure.u128(toU128(policy.maxPerTx)),
      tx.pure.u128(toU128(policy.maxHourlySpend)),
      tx.pure.u128(toU128(policy.maxDailySpend)),
      tx.pure.u16(policy.maxDailyTurnoverBps),
      tx.pure.u32(policy.delegablePermissions),
      assets,
    ],
  })
}

/** `bucket::create_bucket`; the `OwnerCap` is sent to `owner` (normally the transaction sender). */
export function buildCreateBucketTx(input: { packageId: string; name: string; policy: SuiPolicy; owner: string }): Transaction {
  const tx = new Transaction()
  const policy = buildPolicyArgument(tx, input.packageId, input.policy)
  const cap = tx.moveCall({
    target: target(input.packageId, 'bucket', 'create_bucket'),
    arguments: [tx.pure.string(input.name), policy, tx.object(SUI_CLOCK)],
  })
  tx.transferObjects([cap], input.owner)
  return tx
}

/** `bucket::bind_evm`: attaches an independently governed EVM twin for attribution only. Owner only, once. */
export function buildBindEvmTx(input: {
  packageId: string
  bucketObjectId: string
  ownerCapId: string
  chainId: bigint
  controller: Address
  evmBucketId: Hex
  holder: Address
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'bind_evm'),
    arguments: [
      tx.object(input.bucketObjectId),
      tx.object(input.ownerCapId),
      tx.pure.u64(input.chainId),
      tx.pure(BytesBcs.serialize(evmAddressBytes(input.controller))),
      tx.pure(BytesBcs.serialize(hexToBytes(input.evmBucketId))),
      tx.pure(BytesBcs.serialize(evmAddressBytes(input.holder))),
      tx.object(SUI_CLOCK),
    ],
  })
  return tx
}

export function buildUpdatePolicyTx(input: { packageId: string; bucketObjectId: string; ownerCapId: string; policy: SuiPolicy }): Transaction {
  const tx = new Transaction()
  const policy = buildPolicyArgument(tx, input.packageId, input.policy)
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'update_policy'),
    arguments: [tx.object(input.bucketObjectId), tx.object(input.ownerCapId), policy, tx.object(SUI_CLOCK)],
  })
  return tx
}

/** `bucket::issue_capability`; the `OperatorCap` is sent to `grant.operator`. */
export function buildIssueCapabilityTx(input: {
  packageId: string
  bucketObjectId: string
  ownerCapId: string
  grant: SuiCapabilityGrantInput
}): Transaction {
  const tx = new Transaction()
  const limits = limitsArgument(tx, input.packageId, input.grant.limits)
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'issue_capability'),
    arguments: [
      tx.object(input.bucketObjectId),
      tx.object(input.ownerCapId),
      tx.pure.address(input.grant.operator),
      tx.pure.string(input.grant.operatorName),
      tx.pure.u32(input.grant.permissions),
      tx.pure.u8(input.grant.assetMask),
      tx.pure.u64(input.grant.validAfter),
      tx.pure.u64(input.grant.validUntil),
      tx.pure.address(input.grant.payee),
      limits,
      tx.object(SUI_CLOCK),
    ],
  })
  return tx
}

/** `bucket::delegate_capability`; the caller must hold `parentOperatorCapId`. The child `OperatorCap` is sent to
 *  `grant.operator`. */
export function buildDelegateCapabilityTx(input: {
  packageId: string
  bucketObjectId: string
  parentOperatorCapId: string
  grant: SuiCapabilityGrantInput
}): Transaction {
  const tx = new Transaction()
  const limits = limitsArgument(tx, input.packageId, input.grant.limits)
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'delegate_capability'),
    arguments: [
      tx.object(input.bucketObjectId),
      tx.object(input.parentOperatorCapId),
      tx.pure.address(input.grant.operator),
      tx.pure.string(input.grant.operatorName),
      tx.pure.u32(input.grant.permissions),
      tx.pure.u8(input.grant.assetMask),
      tx.pure.u64(input.grant.validAfter),
      tx.pure.u64(input.grant.validUntil),
      tx.pure.address(input.grant.payee),
      limits,
      tx.object(SUI_CLOCK),
    ],
  })
  return tx
}

export function buildRevokeCapabilityTx(input: { packageId: string; bucketObjectId: string; nonce: bigint }): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'revoke_capability'),
    arguments: [tx.object(input.bucketObjectId), tx.pure.u64(input.nonce), tx.object(SUI_CLOCK)],
  })
  return tx
}

/** Kill switch: invalidates every capability of the Bucket at once. Owner or guardian. */
export function buildRevokeAllTx(input: { packageId: string; bucketObjectId: string }): Transaction {
  const tx = new Transaction()
  tx.moveCall({ target: target(input.packageId, 'bucket', 'revoke_all'), arguments: [tx.object(input.bucketObjectId), tx.object(SUI_CLOCK)] })
  return tx
}

export function buildPauseTx(input: { packageId: string; bucketObjectId: string }): Transaction {
  const tx = new Transaction()
  tx.moveCall({ target: target(input.packageId, 'bucket', 'pause'), arguments: [tx.object(input.bucketObjectId), tx.object(SUI_CLOCK)] })
  return tx
}

export function buildResumeTx(input: { packageId: string; bucketObjectId: string; ownerCapId: string }): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'resume'),
    arguments: [tx.object(input.bucketObjectId), tx.object(input.ownerCapId), tx.object(SUI_CLOCK)],
  })
  return tx
}

export function buildAddGuardianTx(input: { packageId: string; bucketObjectId: string; ownerCapId: string; guardian: string }): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'add_guardian'),
    arguments: [tx.object(input.bucketObjectId), tx.object(input.ownerCapId), tx.pure.address(input.guardian), tx.object(SUI_CLOCK)],
  })
  return tx
}

// ------------------------------------------------------------------------------------ EAC (ENSv2 semantics)
//
// Roles are ENSv2-style nybble-packed `u256` bitmaps: each regular role occupies one nybble (value 1<<(N*4)); its
// admin role is `role << 128`. Bitmaps OR together. The resource is a Bucket's own object address; `ROOT_RESOURCE`
// (0x0) roles apply to every Bucket. See `bucket::access`.

const ADMIN_ROLE_SHIFT = 128n

/** BUCKET EAC regular role bits (`u256` as bigint). `adminOf(role)` yields the admin role that governs it. */
export const SuiRole = {
  VIEW: 0x1n,
  PAY: 0x10n,
  REBALANCE: 0x100n,
  EXECUTE: 0x1000n,
  GUARDIAN: 0x10000n,
} as const
export type SuiRoleName = keyof typeof SuiRole

/** The admin role governing `role` (ENSv2: `role << 128`). Holding it authorizes granting/revoking `role`. */
export function suiAdminOf(role: bigint): bigint {
  return role << ADMIN_ROLE_SHIFT
}

/** The ENSv2 ROOT_RESOURCE: roles granted here apply to every resource (Bucket). */
export const SUI_ROOT_RESOURCE = normalizeSuiAddress('0x0')

/** A Bucket's EAC resource id — its own object address. */
export function bucketResource(bucketObjectId: string): string {
  return normalizeSuiAddress(bucketObjectId)
}

/** `bucket::owner_grant_roles`: the Bucket owner (registrar-equivalent) seeds `roleBitmap` for `principal` on this
 *  Bucket's resource, no pre-existing admin role required. `accessControlId` is the shared `AccessControl` object. */
export function buildOwnerGrantRolesTx(input: {
  packageId: string
  accessControlId: string
  bucketObjectId: string
  ownerCapId: string
  roleBitmap: bigint
  principal: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'owner_grant_roles'),
    arguments: [
      tx.object(input.accessControlId),
      tx.object(input.bucketObjectId),
      tx.object(input.ownerCapId),
      tx.pure.u256(input.roleBitmap),
      tx.pure.address(input.principal),
      tx.object(SUI_CLOCK),
    ],
  })
  return tx
}

/** `bucket::owner_grant_roles_by_suins`: owner seeds `roleBitmap` for the address `name` resolves to on the real
 *  on-chain SuiNS registry. `suinsObjectId` is the shared SuiNS object; the name is identity only. */
export function buildOwnerGrantRolesBySuinsTx(input: {
  packageId: string
  accessControlId: string
  bucketObjectId: string
  ownerCapId: string
  suinsObjectId: string
  name: string
  roleBitmap: bigint
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'owner_grant_roles_by_suins'),
    arguments: [
      tx.object(input.accessControlId),
      tx.object(input.bucketObjectId),
      tx.object(input.ownerCapId),
      tx.object(input.suinsObjectId),
      tx.pure.string(input.name),
      tx.pure.u256(input.roleBitmap),
      tx.object(SUI_CLOCK),
    ],
  })
  return tx
}

/** `bucket::owner_revoke_roles`: owner removes `roleBitmap` from `principal` on this Bucket's resource. */
export function buildOwnerRevokeRolesTx(input: {
  packageId: string
  accessControlId: string
  bucketObjectId: string
  ownerCapId: string
  roleBitmap: bigint
  principal: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'owner_revoke_roles'),
    arguments: [
      tx.object(input.accessControlId),
      tx.object(input.bucketObjectId),
      tx.object(input.ownerCapId),
      tx.pure.u256(input.roleBitmap),
      tx.pure.address(input.principal),
      tx.object(SUI_CLOCK),
    ],
  })
  return tx
}

/** `access::grant_roles` (ENSv2): the caller must hold the admin role for every bit in `roleBitmap`. `resource` is
 *  a Bucket's resource id (see `bucketResource`); it cannot be `SUI_ROOT_RESOURCE` (use `buildGrantRootRolesTx`). */
export function buildGrantRolesTx(input: {
  packageId: string
  accessControlId: string
  resource: string
  roleBitmap: bigint
  account: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'access', 'grant_roles'),
    arguments: [
      tx.object(input.accessControlId),
      tx.pure.address(input.resource),
      tx.pure.u256(input.roleBitmap),
      tx.pure.address(input.account),
    ],
  })
  return tx
}

/** `access::revoke_roles` (ENSv2): admin-role checked; rejects the root resource. */
export function buildRevokeRolesTx(input: {
  packageId: string
  accessControlId: string
  resource: string
  roleBitmap: bigint
  account: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'access', 'revoke_roles'),
    arguments: [
      tx.object(input.accessControlId),
      tx.pure.address(input.resource),
      tx.pure.u256(input.roleBitmap),
      tx.pure.address(input.account),
    ],
  })
  return tx
}

/** `access::grant_root_roles` (ENSv2): grants `roleBitmap` on the ROOT_RESOURCE (applies to every Bucket). The
 *  caller must hold the corresponding admin roles on the root resource. */
export function buildGrantRootRolesTx(input: {
  packageId: string
  accessControlId: string
  roleBitmap: bigint
  account: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'access', 'grant_root_roles'),
    arguments: [tx.object(input.accessControlId), tx.pure.u256(input.roleBitmap), tx.pure.address(input.account)],
  })
  return tx
}

/** `access::revoke_root_roles` (ENSv2). */
export function buildRevokeRootRolesTx(input: {
  packageId: string
  accessControlId: string
  roleBitmap: bigint
  account: string
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'access', 'revoke_root_roles'),
    arguments: [tx.object(input.accessControlId), tx.pure.u256(input.roleBitmap), tx.pure.address(input.account)],
  })
  return tx
}

/** Deposits a `Coin<T>` (a pre-split coin object) into the Bucket vault. Anyone may fund a Bucket. */
export function buildDepositTx(input: { packageId: string; bucketObjectId: string; coinType: string; coin: string }): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'deposit'),
    typeArguments: [input.coinType],
    arguments: [tx.object(input.bucketObjectId), tx.object(input.coin), tx.object(SUI_CLOCK)],
  })
  return tx
}

/** Unrestricted withdrawal (owner only); the resulting `Coin<T>` is sent to the owner. */
export function buildWithdrawTx(input: {
  packageId: string
  bucketObjectId: string
  ownerCapId: string
  coinType: string
  amount: bigint
  recipient: string
}): Transaction {
  const tx = new Transaction()
  const coin = tx.moveCall({
    target: target(input.packageId, 'bucket', 'withdraw'),
    typeArguments: [input.coinType],
    arguments: [tx.object(input.bucketObjectId), tx.object(input.ownerCapId), tx.pure.u64(input.amount), tx.object(SUI_CLOCK)],
  })
  tx.transferObjects([coin], input.recipient)
  return tx
}

/** Pays `amount` of `coinType` from the vault to the capability's fixed payee. `deadline` is Unix seconds. The
 *  operator must hold EAC `ROLE_PAY` (checked against `accessControlId`) in addition to a live PAY capability. */
export function buildPayTx(input: {
  packageId: string
  bucketObjectId: string
  accessControlId: string
  operatorCapId: string
  coinType: string
  recipient: string
  amount: bigint
  deadline: bigint
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'pay'),
    typeArguments: [input.coinType],
    arguments: [
      tx.object(input.bucketObjectId),
      tx.object(input.accessControlId),
      tx.object(input.operatorCapId),
      tx.pure.address(input.recipient),
      tx.pure.u64(input.amount),
      tx.pure.u64(input.deadline),
      tx.object(SUI_CLOCK),
    ],
  })
  return tx
}

/** Atomic multi-recipient settlement: every payment succeeds or the whole call aborts. Requires EAC `ROLE_PAY`. */
export function buildPayManyTx(input: {
  packageId: string
  bucketObjectId: string
  accessControlId: string
  operatorCapId: string
  coinType: string
  recipients: readonly string[]
  amounts: readonly bigint[]
  deadline: bigint
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'pay_many'),
    typeArguments: [input.coinType],
    arguments: [
      tx.object(input.bucketObjectId),
      tx.object(input.accessControlId),
      tx.object(input.operatorCapId),
      tx.pure.vector('address', [...input.recipients]),
      tx.pure.vector('u64', input.amounts.map(String)),
      tx.pure.u64(input.deadline),
      tx.object(SUI_CLOCK),
    ],
  })
  return tx
}

/** Bucket-to-Bucket payment: moves `Balance<T>` directly between two vaults in one atomic call. Requires EAC
 *  `ROLE_PAY` on the source Bucket. */
export function buildPayBucketToBucketTx(input: {
  packageId: string
  sourceObjectId: string
  accessControlId: string
  operatorCapId: string
  destObjectId: string
  coinType: string
  amount: bigint
  deadline: bigint
}): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'pay_bucket_to_bucket'),
    typeArguments: [input.coinType],
    arguments: [
      tx.object(input.sourceObjectId),
      tx.object(input.accessControlId),
      tx.object(input.operatorCapId),
      tx.object(input.destObjectId),
      tx.pure.u64(input.amount),
      tx.pure.u64(input.deadline),
      tx.object(SUI_CLOCK),
    ],
  })
  return tx
}

// ------------------------------------------------------------------------------------------------ reads

/** Decodes a Sui-native Bucket's own inline fields. `capabilities`/`vault` are dynamic-field collections whose
 *  entries are NOT part of this object's BCS — see `BucketSui.getCapability` / `vaultBalance`. */
export function decodeBucket(objectId: string, content: Uint8Array): SuiBucketState {
  const raw = BucketBcs.parse(content)
  const assets: SuiAssetPolicy[] = raw.policy.assets.map((a) => ({ coinType: a.coin_type, targetBps: a.target_bps }))
  const evm: SuiEvmBinding | null = raw.evm
    ? {
        chainId: Number(raw.evm.chain_id),
        controller: getAddress(bytesHex(raw.evm.controller)),
        bucketId: bytesHex(raw.evm.bucket_id),
        holder: getAddress(bytesHex(raw.evm.holder)),
      }
    : null
  const receivingPolicy: SuiReceivingPolicy | null = raw.receiving_policy
    ? {
        acceptedSenders: raw.receiving_policy.accepted_senders
          ? raw.receiving_policy.accepted_senders.map((a) => normalizeSuiAddress(a))
          : null,
        minAmount: BigInt(raw.receiving_policy.min_amount),
        maxAmount: BigInt(raw.receiving_policy.max_amount),
      }
    : null

  return {
    objectId: normalizeSuiAddress(objectId),
    name: raw.name,
    owner: normalizeSuiAddress(raw.owner),
    evm,
    policy: {
      version: raw.policy.version,
      maxPerTx: BigInt(raw.policy.max_per_tx),
      maxHourlySpend: BigInt(raw.policy.max_hourly_spend),
      maxDailySpend: BigInt(raw.policy.max_daily_spend),
      maxDailyTurnoverBps: raw.policy.max_daily_turnover_bps,
      delegablePermissions: raw.policy.delegable_permissions,
      assets,
    },
    policyHash: bytesHex(raw.policy_hash),
    capabilityEpoch: raw.capability_epoch,
    capabilityNonce: BigInt(raw.capability_nonce),
    usage: {
      hourWindow: Number(raw.usage.hour_window),
      dayWindow: Number(raw.usage.day_window),
      hourValue: BigInt(raw.usage.hour_value),
      dayValue: BigInt(raw.usage.day_value),
    },
    guardians: raw.guardians.map((g) => normalizeSuiAddress(g)),
    receivingPolicy,
    evmExecutionNonce: BigInt(raw.evm_execution_nonce),
    evmReceiptsRecorded: BigInt(raw.evm_receipts_recorded),
    lastEvmTx: raw.last_evm_tx.length === 32 ? bytesHex(raw.last_evm_tx) : null,
    status: raw.status as SuiBucketState['status'],
    version: BigInt(raw.version),
    createdAtMs: BigInt(raw.created_at_ms),
    updatedAtMs: BigInt(raw.updated_at_ms),
  }
}

// ---------------------------------------------------------------------------------- EAC reads (devInspect)

/** Read-only sender for `devInspect` calls (never charged; the call mutates nothing). */
const READ_SENDER = normalizeSuiAddress('0x0')

async function firstReturnBytes(client: SuiJsonRpcClient, tx: Transaction, sender: string): Promise<Uint8Array> {
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: tx })
  const rv = res.results?.[0]?.returnValues
  if (!rv || !rv[0]) throw new Error(res.error ?? 'devInspect returned no value')
  return Uint8Array.from(rv[0][0])
}

/** Resolves a SuiNS `name` to the address BUCKET EAC would authorize, via the on-chain `bucket::resolve_suins_principal`
 *  view. Aborts (rejected devInspect) if the name is unregistered, expired, or has no target address. */
export async function resolveSuinsPrincipal(
  client: SuiJsonRpcClient,
  input: { packageId: string; suinsObjectId: string; name: string; sender?: string },
): Promise<string> {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'resolve_suins_principal'),
    arguments: [tx.object(input.suinsObjectId), tx.pure.string(input.name), tx.object(SUI_CLOCK)],
  })
  const bytes = await firstReturnBytes(client, tx, input.sender ?? READ_SENDER)
  return normalizeSuiAddress(bytesToHex(bytes))
}

function u256le(bytes: Uint8Array): bigint {
  let v = 0n
  let i = bytes.length
  while (i > 0) {
    i -= 1
    v = (v << 8n) | BigInt(bytes[i] ?? 0)
  }
  return v
}

/** True if `principal` holds every bit of `roleBitmap` on this Bucket, applying the ENSv2 root-resource fallback
 *  and the owner's implicit authority. Reads `bucket::has_role` against the shared `accessControlId`. */
export async function hasRole(
  client: SuiJsonRpcClient,
  input: { packageId: string; accessControlId: string; bucketObjectId: string; principal: string; roleBitmap: bigint; sender?: string },
): Promise<boolean> {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'has_role'),
    arguments: [
      tx.object(input.accessControlId),
      tx.object(input.bucketObjectId),
      tx.pure.address(input.principal),
      tx.pure.u256(input.roleBitmap),
    ],
  })
  const bytes = await firstReturnBytes(client, tx, input.sender ?? READ_SENDER)
  return bytes[0] === 1
}

/** The raw stored role bitmap (`u256`) for `principal` on this Bucket's resource (no root fallback, no owner
 *  implication). Reads `bucket::roles_of` against the shared `accessControlId`. */
export async function getResourceRoles(
  client: SuiJsonRpcClient,
  input: { packageId: string; accessControlId: string; bucketObjectId: string; principal: string; sender?: string },
): Promise<bigint> {
  const tx = new Transaction()
  tx.moveCall({
    target: target(input.packageId, 'bucket', 'roles_of'),
    arguments: [tx.object(input.accessControlId), tx.object(input.bucketObjectId), tx.pure.address(input.principal)],
  })
  const bytes = await firstReturnBytes(client, tx, input.sender ?? READ_SENDER)
  return u256le(bytes)
}

export class SuiObjectNotFoundError extends Error {
  override name = 'SuiObjectNotFoundError'
}

/** Not yet implemented: reading one entry of a Move `Table`/`Bag` (here, `Bucket.capabilities` /
 *  `Bucket.vault`) requires either the child object's deterministically derived dynamic-field ID (verified
 *  against a live node — not yet done in this SDK pass) or a `getDynamicFieldObject`-style RPC call, which the
 *  unified core client surface this SDK targets may not expose. Until wired up, read a capability or a vault
 *  balance with a `devInspect`-style call to the Move view functions `bucket::get_capability` /
 *  `bucket::vault_balance` against whatever concrete client (JSON-RPC, gRPC) the host app already has, and decode
 *  the return value with `CapabilityBcs`. */
export class SuiDynamicFieldReadNotImplementedError extends Error {
  override name = 'SuiDynamicFieldReadNotImplementedError'
}

/** Read access to Bucket objects through any Sui client exposing the core API (gRPC, GraphQL, JSON-RPC). */
export class BucketSui {
  constructor(
    readonly client: ClientWithCoreApi,
    readonly packageId: string,
  ) {}

  async getBucket(objectId: string): Promise<SuiBucketState> {
    const { object } = await this.client.core.getObject({ objectId, include: { content: true } })
    if (!object.type.endsWith('::bucket::Bucket')) {
      throw new SuiObjectNotFoundError(`${objectId} is ${object.type}, not a Bucket`)
    }
    return decodeBucket(objectId, object.content)
  }

  async getOwnerCap(objectId: string) {
    const { object } = await this.client.core.getObject({ objectId, include: { content: true } })
    const raw = OwnerCapBcs.parse(object.content)
    return { id: normalizeSuiAddress(raw.id), bucketId: normalizeSuiAddress(raw.bucket_id) }
  }

  async getOperatorCap(objectId: string) {
    const { object } = await this.client.core.getObject({ objectId, include: { content: true } })
    const raw = OperatorCapBcs.parse(object.content)
    return { id: normalizeSuiAddress(raw.id), bucketId: normalizeSuiAddress(raw.bucket_id), capabilityNonce: BigInt(raw.capability_nonce) }
  }

  /** Return values of the first command of `tx`, read with a checks-disabled simulation through the core API (works
   *  on gRPC, where JSON-RPC `devInspect` is no longer served by public fullnodes). */
  private async view(tx: Transaction, sender?: string): Promise<Uint8Array[]> {
    tx.setSenderIfNotSet(sender ?? READ_SENDER)
    const res = await this.client.core.simulateTransaction({
      transaction: tx,
      include: { commandResults: true },
      checksEnabled: false,
    })
    if (res.$kind !== 'Transaction') {
      throw new Error(`view call aborted: ${JSON.stringify(res.FailedTransaction.status)}`)
    }
    const values = res.commandResults?.[0]?.returnValues
    if (!values || values.length === 0) throw new Error('view call returned no value')
    return values.map((v) => v.bcs)
  }

  /** `bucket::vault_balance<T>`: coins of `coinType` held in the Bucket's Move vault. */
  async vaultBalance(bucketObjectId: string, coinType: string): Promise<bigint> {
    const tx = new Transaction()
    tx.moveCall({ target: target(this.packageId, 'bucket', 'vault_balance'), typeArguments: [coinType], arguments: [tx.object(bucketObjectId)] })
    const [bytes] = await this.view(tx)
    return BigInt(bcs.u64().parse(bytes!))
  }

  /** `bucket::get_capability`, or `null` when no capability with `nonce` exists. */
  async getCapability(bucketObjectId: string, nonce: bigint): Promise<SuiCapabilityView | null> {
    const has = new Transaction()
    has.moveCall({ target: target(this.packageId, 'bucket', 'has_capability'), arguments: [has.object(bucketObjectId), has.pure.u64(nonce)] })
    const [exists] = await this.view(has)
    if (exists?.[0] !== 1) return null
    const tx = new Transaction()
    tx.moveCall({ target: target(this.packageId, 'bucket', 'get_capability'), arguments: [tx.object(bucketObjectId), tx.pure.u64(nonce)] })
    const [bytes] = await this.view(tx)
    const raw = CapabilityBcs.parse(bytes!)
    const g = raw.grant
    return {
      nonce: BigInt(g.nonce),
      issuer: normalizeSuiAddress(g.issuer),
      operator: normalizeSuiAddress(g.operator),
      operatorName: g.operator_name,
      depth: g.depth,
      permissions: g.permissions,
      assetMask: g.asset_mask,
      validAfter: BigInt(g.valid_after),
      validUntil: BigInt(g.valid_until),
      policyVersion: g.policy_version,
      epoch: g.epoch,
      payee: normalizeSuiAddress(g.payee),
      limits: {
        maxPerTx: BigInt(g.limits.max_per_tx),
        maxHourlySpend: BigInt(g.limits.max_hourly_spend),
        maxDailySpend: BigInt(g.limits.max_daily_spend),
        maxDailyTurnoverBps: g.limits.max_daily_turnover_bps,
        maxExecutions: g.limits.max_executions,
      },
      status: raw.status,
      executions: BigInt(raw.executions),
      usage: {
        hourWindow: BigInt(raw.usage.hour_window),
        dayWindow: BigInt(raw.usage.day_window),
        hourValue: BigInt(raw.usage.hour_value),
        dayValue: BigInt(raw.usage.day_value),
      },
      issuedAtMs: BigInt(raw.issued_at_ms),
    }
  }

  /** Every capability ever issued on the Bucket (nonces `1..capabilityNonce`) that still exists. */
  async listCapabilities(bucketObjectId: string, capabilityNonce: bigint): Promise<SuiCapabilityView[]> {
    const nonces = Array.from({ length: Number(capabilityNonce) }, (_, i) => BigInt(i + 1))
    const caps = await Promise.all(nonces.map((n) => this.getCapability(bucketObjectId, n)))
    return caps.filter((c): c is SuiCapabilityView => c !== null)
  }

  /** `bucket::has_role` through the core API (owner implication and root fallback applied on-chain). */
  async hasRole(accessControlId: string, bucketObjectId: string, principal: string, roleBitmap: bigint): Promise<boolean> {
    const tx = new Transaction()
    tx.moveCall({
      target: target(this.packageId, 'bucket', 'has_role'),
      arguments: [tx.object(accessControlId), tx.object(bucketObjectId), tx.pure.address(principal), tx.pure.u256(roleBitmap)],
    })
    const [bytes] = await this.view(tx)
    return bytes?.[0] === 1
  }

  /** `bucket::resolve_suins_principal`: the address BUCKET EAC authorizes for a SuiNS name. Throws if the name is
   *  unregistered, expired or has no target. */
  async resolveSuinsPrincipal(suinsObjectId: string, name: string): Promise<string> {
    const tx = new Transaction()
    tx.moveCall({
      target: target(this.packageId, 'bucket', 'resolve_suins_principal'),
      arguments: [tx.object(suinsObjectId), tx.pure.string(name), tx.object(SUI_CLOCK)],
    })
    const [bytes] = await this.view(tx)
    return normalizeSuiAddress(bytesToHex(bytes!))
  }
}

export interface SuiCapabilityView {
  readonly nonce: bigint
  readonly issuer: string
  readonly operator: string
  readonly operatorName: string
  readonly depth: number
  readonly permissions: number
  readonly assetMask: number
  /** Unix seconds. */
  readonly validAfter: bigint
  /** Unix seconds. */
  readonly validUntil: bigint
  readonly policyVersion: number
  readonly epoch: number
  readonly payee: string
  readonly limits: {
    readonly maxPerTx: bigint
    readonly maxHourlySpend: bigint
    readonly maxDailySpend: bigint
    readonly maxDailyTurnoverBps: number
    readonly maxExecutions: number
  }
  /** 1 active, 2 revoked, 3 exhausted (`capability::status_*`). */
  readonly status: number
  readonly executions: bigint
  /** Spend accounting; windows are `clock_ms / 3_600_000` (hour) and `clock_ms / 86_400_000` (day). */
  readonly usage: { readonly hourWindow: bigint; readonly dayWindow: bigint; readonly hourValue: bigint; readonly dayValue: bigint }
  readonly issuedAtMs: bigint
}
