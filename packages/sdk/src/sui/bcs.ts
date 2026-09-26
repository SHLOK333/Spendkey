import { bcs } from '@mysten/sui/bcs'

/**
 * BCS layouts of the `bucket` Move package. Field order is load-bearing and mirrors
 * `contracts/sui/sources/{policy,capability,bucket}.move` exactly. Object content is parsed from BCS (not
 * transport JSON) so decoding is identical across gRPC, GraphQL and JSON-RPC.
 *
 * `capabilities: Table<u64, Capability>` and `vault: Bag` are Sui dynamic-field collections: their headers
 * (`{id, size}`) are inline in the `Bucket` object's BCS, but their entries are separate child objects, not part
 * of it. Reading an individual capability or vault balance goes through the Move view functions
 * (`bucket::get_capability`, `bucket::vault_balance`) via `sui/bucket.ts`'s `readView`, not through this BCS layout.
 */

const Bytes = bcs.vector(bcs.u8())

export const AssetPolicyBcs = bcs.struct('AssetPolicy', {
  coin_type: bcs.string(), // ascii::String, same wire encoding as utf8 string (length-prefixed bytes)
  target_bps: bcs.u16(),
})

export const PolicyBcs = bcs.struct('Policy', {
  version: bcs.u32(),
  max_per_tx: bcs.u128(),
  max_hourly_spend: bcs.u128(),
  max_daily_spend: bcs.u128(),
  max_daily_turnover_bps: bcs.u16(),
  delegable_permissions: bcs.u32(),
  assets: bcs.vector(AssetPolicyBcs),
})

export const EvmBindingBcs = bcs.struct('EvmBinding', {
  chain_id: bcs.u64(),
  controller: Bytes,
  bucket_id: Bytes,
  holder: Bytes,
})

export const ReceivingPolicyBcs = bcs.struct('ReceivingPolicy', {
  accepted_senders: bcs.option(bcs.vector(bcs.Address)), // Option<VecSet<address>>; VecSet is `{contents: vector<T>}`
  min_amount: bcs.u64(),
  max_amount: bcs.u64(),
})

const TableHeaderBcs = bcs.struct('Table', { id: bcs.Address, size: bcs.u64() })
const BagHeaderBcs = bcs.struct('Bag', { id: bcs.Address, size: bcs.u64() })

export const UsageBcs = bcs.struct('Usage', {
  hour_window: bcs.u64(),
  day_window: bcs.u64(),
  hour_value: bcs.u128(),
  day_value: bcs.u128(),
})

export const BucketBcs = bcs.struct('Bucket', {
  id: bcs.Address,
  name: bcs.string(),
  owner: bcs.Address,
  evm: bcs.option(EvmBindingBcs),
  policy: PolicyBcs,
  policy_hash: Bytes,
  capability_epoch: bcs.u32(),
  capability_nonce: bcs.u64(),
  capabilities: TableHeaderBcs,
  usage: UsageBcs,
  guardians: bcs.vector(bcs.Address), // VecSet<address> = { contents: vector<address> }
  receiving_policy: bcs.option(ReceivingPolicyBcs),
  vault: BagHeaderBcs,
  evm_execution_nonce: bcs.u64(),
  evm_receipts_recorded: bcs.u64(),
  last_evm_tx: Bytes,
  status: bcs.u8(),
  version: bcs.u64(),
  created_at_ms: bcs.u64(),
  updated_at_ms: bcs.u64(),
})

export const LimitsBcs = bcs.struct('Limits', {
  max_per_tx: bcs.u128(),
  max_hourly_spend: bcs.u128(),
  max_daily_spend: bcs.u128(),
  max_daily_turnover_bps: bcs.u16(),
  max_executions: bcs.u32(),
})

export const GrantBcs = bcs.struct('Grant', {
  capability_id: Bytes,
  parent_id: Bytes,
  issuer: bcs.Address,
  operator: bcs.Address,
  operator_name: bcs.string(),
  depth: bcs.u8(),
  permissions: bcs.u32(),
  asset_mask: bcs.u8(),
  valid_after: bcs.u64(),
  valid_until: bcs.u64(),
  policy_version: bcs.u32(),
  epoch: bcs.u32(),
  nonce: bcs.u64(),
  payee: bcs.Address,
  limits: LimitsBcs,
})

export const CapabilityBcs = bcs.struct('Capability', {
  grant: GrantBcs,
  capability_hash: Bytes,
  status: bcs.u8(),
  executions: bcs.u64(),
  usage: UsageBcs,
  issued_at_ms: bcs.u64(),
})

export const OwnerCapBcs = bcs.struct('OwnerCap', {
  id: bcs.Address,
  bucket_id: bcs.Address,
})

export const OperatorCapBcs = bcs.struct('OperatorCap', {
  id: bcs.Address,
  bucket_id: bcs.Address,
  capability_nonce: bcs.u64(),
})

export const BytesBcs = Bytes
export const BytesVectorBcs = bcs.vector(Bytes)
export const AddressVectorBcs = bcs.vector(bcs.Address)
export const StringVectorBcs = bcs.vector(bcs.string())
export const U16VectorBcs = bcs.vector(bcs.u16())
