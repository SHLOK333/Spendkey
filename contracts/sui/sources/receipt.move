/// Execution receipts: the EVM `ExecutionReceipt`, submitted to the Sui Bucket for independent re-verification.
///
/// A receipt answers WHO executed (operator, capability), WHY it was allowed (kind, policy version and hash,
/// strategy hash), WHAT changed (pre/post balances at reference prices, committed by state hashes) and HOW MUCH
/// moved. Sui cannot read Ethereum; `bucket::record_receipt` therefore checks every receipt against the canonical
/// policy and the capability mirror before it becomes part of the Bucket's history.
module bucket::receipt;

use bucket::codec;

const KIND_REBALANCE: u8 = 1;
const KIND_SWAP: u8 = 2;
const KIND_PAY: u8 = 3;

const EKind: u64 = 500;
const ELength: u64 = 501;

public struct Receipt has copy, drop {
    evm_tx_hash: vector<u8>,
    /// `keccak256(abi.encode(receipt))` as emitted by `BucketController.ExecutionRecorded`.
    evm_receipt_hash: vector<u8>,
    execution_nonce: u64,
    kind: u8,
    capability_id: vector<u8>,
    operator: vector<u8>,
    policy_version: u32,
    policy_hash: vector<u8>,
    strategy_hash: vector<u8>,
    token_out_index: u64,
    /// Ignored for PAY receipts.
    token_in_index: u64,
    amount_out: u128,
    amount_in: u128,
    value_out: u256,
    recipient: vector<u8>,
    pre_balances: vector<u128>,
    post_balances: vector<u128>,
    prices_wad: vector<u128>,
    pre_state_hash: vector<u8>,
    post_state_hash: vector<u8>,
    /// EVM block timestamp of the execution, seconds.
    timestamp: u64,
}

public fun new(
    evm_tx_hash: vector<u8>,
    evm_receipt_hash: vector<u8>,
    execution_nonce: u64,
    kind: u8,
    capability_id: vector<u8>,
    operator: vector<u8>,
    policy_version: u32,
    policy_hash: vector<u8>,
    strategy_hash: vector<u8>,
    token_out_index: u64,
    token_in_index: u64,
    amount_out: u128,
    amount_in: u128,
    value_out: u256,
    recipient: vector<u8>,
    pre_balances: vector<u128>,
    post_balances: vector<u128>,
    prices_wad: vector<u128>,
    pre_state_hash: vector<u8>,
    post_state_hash: vector<u8>,
    timestamp: u64,
): Receipt {
    assert!(kind == KIND_REBALANCE || kind == KIND_SWAP || kind == KIND_PAY, EKind);
    codec::assert_word(&evm_tx_hash);
    codec::assert_word(&evm_receipt_hash);
    codec::assert_word(&capability_id);
    codec::assert_address(&operator);
    codec::assert_word(&policy_hash);
    codec::assert_word(&strategy_hash);
    codec::assert_address(&recipient);
    codec::assert_word(&pre_state_hash);
    codec::assert_word(&post_state_hash);
    assert!(
        pre_balances.length() == post_balances.length() && pre_balances.length() == prices_wad.length(),
        ELength,
    );
    Receipt {
        evm_tx_hash,
        evm_receipt_hash,
        execution_nonce,
        kind,
        capability_id,
        operator,
        policy_version,
        policy_hash,
        strategy_hash,
        token_out_index,
        token_in_index,
        amount_out,
        amount_in,
        value_out,
        recipient,
        pre_balances,
        post_balances,
        prices_wad,
        pre_state_hash,
        post_state_hash,
        timestamp,
    }
}

public fun kind_rebalance(): u8 { KIND_REBALANCE }

public fun kind_swap(): u8 { KIND_SWAP }

public fun kind_pay(): u8 { KIND_PAY }

public fun evm_tx_hash(r: &Receipt): vector<u8> { r.evm_tx_hash }

public fun evm_receipt_hash(r: &Receipt): vector<u8> { r.evm_receipt_hash }

public fun execution_nonce(r: &Receipt): u64 { r.execution_nonce }

public fun kind(r: &Receipt): u8 { r.kind }

public fun is_swap(r: &Receipt): bool { r.kind != KIND_PAY }

public fun capability_id(r: &Receipt): vector<u8> { r.capability_id }

public fun operator(r: &Receipt): vector<u8> { r.operator }

public fun policy_version(r: &Receipt): u32 { r.policy_version }

public fun policy_hash(r: &Receipt): vector<u8> { r.policy_hash }

public fun strategy_hash(r: &Receipt): vector<u8> { r.strategy_hash }

public fun token_out_index(r: &Receipt): u64 { r.token_out_index }

public fun token_in_index(r: &Receipt): u64 { r.token_in_index }

public fun amount_out(r: &Receipt): u128 { r.amount_out }

public fun amount_in(r: &Receipt): u128 { r.amount_in }

public fun value_out(r: &Receipt): u256 { r.value_out }

public fun recipient(r: &Receipt): vector<u8> { r.recipient }

public fun pre_balances(r: &Receipt): &vector<u128> { &r.pre_balances }

public fun post_balances(r: &Receipt): &vector<u128> { &r.post_balances }

public fun prices_wad(r: &Receipt): &vector<u128> { &r.prices_wad }

public fun pre_state_hash(r: &Receipt): vector<u8> { r.pre_state_hash }

public fun post_state_hash(r: &Receipt): vector<u8> { r.post_state_hash }

public fun timestamp(r: &Receipt): u64 { r.timestamp }
