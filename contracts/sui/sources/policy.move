/// Canonical policy of a Sui-native Bucket: the ceiling every Financial Capability issued under it must respect.
///
/// This is a payment/settlement policy (assets, per-transaction and velocity limits, what may be delegated) — Sui
/// enforces its own execution here rather than mirroring the EVM's Aqua/SwapVM rebalancing policy. A cross-chain
/// Bucket keeps this and its EVM policy as two independently enforced instances of the same "Financial Capability"
/// concept, not one shared object.
module bucket::policy;

use bucket::codec;
use bucket::permissions;
use std::ascii::String;
use sui::hash::keccak256;

// === Limits ===

const MAX_ASSETS: u64 = 8;
const BPS: u64 = 10_000;

/// `keccak256("BUCKET_SUI_POLICY_V1")`, this module's commitment domain tag.
const POLICY_DOMAIN_TAG: vector<u8> = b"BUCKET_SUI_POLICY_V1";

// === Abort codes ===

const EAssetCount: u64 = 100;
const ETypeEmpty: u64 = 102;
const ETypeDuplicate: u64 = 103;
const ETargetSum: u64 = 106;
const EValueLimits: u64 = 109;
const ETurnover: u64 = 114;
const EDelegable: u64 = 116;
const EVectorLength: u64 = 115;

/// A coin type this Bucket holds, with its target allocation (informational for the UI; Sui-native payments do
/// not currently self-rebalance) and whether it accepts inbound payments as a receiving Bucket.
public struct AssetPolicy has copy, drop, store {
    /// Fully qualified Move coin type, e.g. `0x2::sui::SUI` or a package's `USDC` type.
    coin_type: String,
    target_bps: u16,
}

/// Complete Bucket policy.
public struct Policy has copy, drop, store {
    version: u32,
    max_per_tx: u128,
    max_hourly_spend: u128,
    max_daily_spend: u128,
    max_daily_turnover_bps: u16,
    delegable_permissions: u32,
    assets: vector<AssetPolicy>,
}

// === Construction ===

public fun new_asset(coin_type: String, target_bps: u16): AssetPolicy {
    AssetPolicy { coin_type, target_bps }
}

/// Builds the asset list from parallel vectors (PTB-friendly).
public fun new_assets(mut coin_types: vector<String>, mut targets: vector<u16>): vector<AssetPolicy> {
    let count = coin_types.length();
    assert!(targets.length() == count, EVectorLength);
    let mut assets = vector[];
    while (!coin_types.is_empty()) {
        assets.push_back(new_asset(coin_types.pop_back(), targets.pop_back()));
    };
    assets.reverse();
    assets
}

/// Builds and validates a policy. The version is assigned when the policy is installed on a Bucket.
public fun new(
    max_per_tx: u128,
    max_hourly_spend: u128,
    max_daily_spend: u128,
    max_daily_turnover_bps: u16,
    delegable_permissions: u32,
    assets: vector<AssetPolicy>,
): Policy {
    let policy = Policy {
        version: 0,
        max_per_tx,
        max_hourly_spend,
        max_daily_spend,
        max_daily_turnover_bps,
        delegable_permissions,
        assets,
    };
    validate(&policy);
    policy
}

/// I1 1 <= assets.length <= MAX_ASSETS, every coin type non-empty and unique, target weights sum to 100%.
/// I2 0 < max_per_tx <= max_hourly_spend <= max_daily_spend.
/// I3 0 < max_daily_turnover_bps <= BPS.
/// I4 delegable_permissions never includes an owner-only permission.
public fun validate(policy: &Policy) {
    let count = policy.assets.length();
    assert!(count > 0 && count <= MAX_ASSETS, EAssetCount);

    let mut target_sum = 0u64;
    let mut i = 0;
    while (i < count) {
        let asset = &policy.assets[i];
        assert!(asset.coin_type.length() > 0, ETypeEmpty);
        let mut j = 0;
        while (j < i) {
            assert!(policy.assets[j].coin_type != asset.coin_type, ETypeDuplicate);
            j = j + 1;
        };
        target_sum = target_sum + (asset.target_bps as u64);
        i = i + 1;
    };
    assert!(target_sum == BPS, ETargetSum);

    assert!(
        policy.max_per_tx > 0 && policy.max_per_tx <= policy.max_hourly_spend
            && policy.max_hourly_spend <= policy.max_daily_spend,
        EValueLimits,
    );
    assert!(
        policy.max_daily_turnover_bps > 0 && (policy.max_daily_turnover_bps as u64) <= BPS,
        ETurnover,
    );
    assert!(permissions::is_valid(policy.delegable_permissions) && policy.delegable_permissions & permissions::owner_only() == 0, EDelegable);
}

// === Commitment ===

/// Policy commitment: keccak256(DOMAIN | bucket_ref(32) | version(4) | max_per_tx(16) | max_hourly_spend(16) |
/// max_daily_spend(16) | turnover(2) | delegable(4) | count(1) | count * [coin_type_len(2) | coin_type | target(2)]).
public fun hash(bucket_ref: &vector<u8>, policy: &Policy): vector<u8> {
    codec::assert_word(bucket_ref);
    let domain_tag = POLICY_DOMAIN_TAG;
    let mut bytes = keccak256(&domain_tag);
    bytes.append(*bucket_ref);
    codec::push_be(&mut bytes, policy.version as u256, 4);
    codec::push_be(&mut bytes, policy.max_per_tx as u256, 16);
    codec::push_be(&mut bytes, policy.max_hourly_spend as u256, 16);
    codec::push_be(&mut bytes, policy.max_daily_spend as u256, 16);
    codec::push_be(&mut bytes, policy.max_daily_turnover_bps as u256, 2);
    codec::push_be(&mut bytes, policy.delegable_permissions as u256, 4);
    codec::push_be(&mut bytes, policy.assets.length() as u256, 1);
    let mut i = 0;
    while (i < policy.assets.length()) {
        let asset = &policy.assets[i];
        let type_bytes = asset.coin_type.as_bytes();
        codec::push_be(&mut bytes, type_bytes.length() as u256, 2);
        bytes.append(*type_bytes);
        codec::push_be(&mut bytes, asset.target_bps as u256, 2);
        i = i + 1;
    };
    keccak256(&bytes)
}

/// Bit mask with one bit per policy asset (index order, `count <= MAX_ASSETS == 8`); bounds `Capability.asset_mask`.
public fun full_asset_mask(p: &Policy): u8 {
    (((1u16 << (p.assets.length() as u8)) - 1) as u8)
}

/// Index of the asset whose coin type is `coin_type`, if the Bucket's policy accepts it.
public fun find_type(p: &Policy, coin_type: &String): Option<u64> {
    let mut i = 0;
    while (i < p.assets.length()) {
        if (&p.assets[i].coin_type == coin_type) return option::some(i);
        i = i + 1;
    };
    option::none()
}

/// Assigns the policy version when a Bucket installs the policy.
public(package) fun set_version(p: &mut Policy, version: u32) { p.version = version }

// === Accessors ===

public fun version(p: &Policy): u32 { p.version }

public fun max_per_tx(p: &Policy): u128 { p.max_per_tx }

public fun max_hourly_spend(p: &Policy): u128 { p.max_hourly_spend }

public fun max_daily_spend(p: &Policy): u128 { p.max_daily_spend }

public fun max_daily_turnover_bps(p: &Policy): u16 { p.max_daily_turnover_bps }

public fun delegable_permissions(p: &Policy): u32 { p.delegable_permissions }

public fun assets(p: &Policy): &vector<AssetPolicy> { &p.assets }

public fun asset_count(p: &Policy): u64 { p.assets.length() }

public fun coin_type(a: &AssetPolicy): String { a.coin_type }

public fun target_bps(a: &AssetPolicy): u16 { a.target_bps }
