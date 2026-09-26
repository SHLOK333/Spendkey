#[test_only]
/// Tests for BUCKET Enhanced Access Control (ENSv2 semantics): resource isolation, nybble-packed role bitmaps,
/// per-role admin semantics, ROOT_RESOURCE fallback, grant/revoke, unauthorized principals, real SuiNS resolution,
/// EAC ∧ capability/policy/state layering, and privilege-escalation prevention.
module bucket::access_tests;

use bucket::{
    access::{Self, AccessControl},
    bucket::{Self, Bucket, OwnerCap, OperatorCap},
    capability::{Self, Limits},
    permissions,
    policy::{Self, Policy}
};
use std::type_name;
use sui::{clock::{Self, Clock}, coin, test_scenario::{Self as ts, Scenario}, test_utils};
use suins::{domain, registry::{Self, Registry}, suins::{Self, SuiNS}};

public struct USDC has drop {}

const OWNER: address = @0xA1;
const OPERATOR_A: address = @0xB2;
const OPERATOR_B: address = @0xC3;
const ADMIN_A: address = @0xD4;
const ADMIN_B: address = @0xE5;
const GUARDIAN_C: address = @0xF6;
const RECIPIENT: address = @0x77;

const DAY_SECS: u64 = 31_536_000;

fun usdc_policy(): Policy {
    let ct = type_name::with_defining_ids<USDC>().into_string();
    let assets = policy::new_assets(vector[ct], vector[10_000]);
    policy::new(1_000_000, 5_000_000, 10_000_000, 10_000, permissions::delegable(), assets)
}

fun op_limits(): Limits { capability::new_limits(1_000_000, 5_000_000, 10_000_000, 10_000, 0) }

fun small_limits(): Limits { capability::new_limits(1_000, 1_000, 1_000, 10_000, 0) }

fun new_clock(scenario: &mut Scenario): Clock {
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(1_000);
    c
}

/// Creates a shared, funded Bucket owned by OWNER; returns the OwnerCap. Leaves the scenario in an OWNER tx.
fun setup(scenario: &mut Scenario, clock: &Clock): OwnerCap {
    let owner_cap = bucket::create_bucket(
        b"treasury@shlok".to_string(),
        usdc_policy(),
        clock,
        scenario.ctx(),
    );
    scenario.next_tx(OWNER);
    let mut b = scenario.take_shared<Bucket>();
    let coin = coin::mint_for_testing<USDC>(1_000_000_000, scenario.ctx());
    bucket::deposit(&mut b, coin, clock, scenario.ctx());
    ts::return_shared(b);
    scenario.next_tx(OWNER);
    owner_cap
}

fun issue_pay_cap(
    b: &mut Bucket,
    owner_cap: &OwnerCap,
    clock: &Clock,
    operator: address,
    limits: Limits,
    ctx: &mut TxContext,
) {
    bucket::issue_capability(
        b,
        owner_cap,
        operator,
        b"agent.treasury@shlok".to_string(),
        permissions::pay(),
        1,
        0,
        DAY_SECS,
        RECIPIENT,
        limits,
        clock,
        ctx,
    );
}

fun do_pay(
    scenario: &mut Scenario,
    ac: &AccessControl,
    clock: &Clock,
    operator: address,
    amount: u64,
) {
    scenario.next_tx(operator);
    let mut b = scenario.take_shared<Bucket>();
    let op_cap = scenario.take_from_sender<OperatorCap>();
    bucket::pay<USDC>(&mut b, ac, &op_cap, RECIPIENT, amount, DAY_SECS, clock, scenario.ctx());
    scenario.return_to_sender(op_cap);
    ts::return_shared(b);
}

// === role bitmap: multiple roles in one grant ===

#[test]
fun owner_can_grant_multiple_roles_at_once() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    let mut b = scenario.take_shared<Bucket>();
    let bitmap = access::pay() | access::rebalance();
    bucket::owner_grant_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        bitmap,
        OPERATOR_A,
        &clock,
        scenario.ctx(),
    );
    assert!(bucket::has_role(&ac, &b, OPERATOR_A, access::pay()), 0);
    assert!(bucket::has_role(&ac, &b, OPERATOR_A, access::rebalance()), 1);
    assert!(bucket::has_role(&ac, &b, OPERATOR_A, bitmap), 2); // both bits at once
    assert!(!bucket::has_role(&ac, &b, OPERATOR_A, access::guardian()), 3);
    ts::return_shared(b);

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === authorized operator can pay (EAC ∧ capability) ===

#[test]
fun authorized_operator_can_pay() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    let mut b = scenario.take_shared<Bucket>();
    issue_pay_cap(&mut b, &owner_cap, &clock, OPERATOR_A, op_limits(), scenario.ctx());
    bucket::owner_grant_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        access::pay(),
        OPERATOR_A,
        &clock,
        scenario.ctx(),
    );
    ts::return_shared(b);

    do_pay(&mut scenario, &ac, &clock, OPERATOR_A, 500_000);

    scenario.next_tx(RECIPIENT);
    assert!(scenario.has_most_recent_for_sender<coin::Coin<USDC>>(), 0);

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === unauthorized principal (valid capability, no EAC role) ===

#[test]
#[expected_failure(abort_code = 621)] // bucket::ENotAuthorizedRole
fun operator_without_role_cannot_pay() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    let mut b = scenario.take_shared<Bucket>();
    issue_pay_cap(&mut b, &owner_cap, &clock, OPERATOR_B, op_limits(), scenario.ctx());
    ts::return_shared(b);

    do_pay(&mut scenario, &ac, &clock, OPERATOR_B, 500_000); // aborts at require_role

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === resource isolation: role on #42 does not authorize #43 ===

#[test]
fun role_is_scoped_per_bucket() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());

    let owner_cap42 = bucket::create_bucket(
        b"b42".to_string(),
        usdc_policy(),
        &clock,
        scenario.ctx(),
    );
    scenario.next_tx(OWNER);
    let mut b42 = scenario.take_shared<Bucket>();
    bucket::owner_grant_roles(
        &mut ac,
        &mut b42,
        &owner_cap42,
        access::pay(),
        OPERATOR_A,
        &clock,
        scenario.ctx(),
    );
    assert!(bucket::has_role(&ac, &b42, OPERATOR_A, access::pay()), 0);
    ts::return_shared(b42);

    let owner_cap43 = bucket::create_bucket(
        b"b43".to_string(),
        usdc_policy(),
        &clock,
        scenario.ctx(),
    );
    scenario.next_tx(OWNER);
    let b43 = scenario.take_shared<Bucket>();
    assert!(!bucket::has_role(&ac, &b43, OPERATOR_A, access::pay()), 1); // NOT authorized on #43
    ts::return_shared(b43);

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap42);
    test_utils::destroy(owner_cap43);
    clock.destroy_for_testing();
    scenario.end();
}

// === grant + revoke: revoked role cannot execute ===

#[test]
#[expected_failure(abort_code = 621)] // bucket::ENotAuthorizedRole
fun revoked_role_cannot_pay() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    let mut b = scenario.take_shared<Bucket>();
    issue_pay_cap(&mut b, &owner_cap, &clock, OPERATOR_A, op_limits(), scenario.ctx());
    bucket::owner_grant_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        access::pay(),
        OPERATOR_A,
        &clock,
        scenario.ctx(),
    );
    bucket::owner_revoke_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        access::pay(),
        OPERATOR_A,
        &clock,
        scenario.ctx(),
    );
    assert!(!bucket::has_role(&ac, &b, OPERATOR_A, access::pay()), 0);
    ts::return_shared(b);

    do_pay(&mut scenario, &ac, &clock, OPERATOR_A, 500_000); // aborts: role gone

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === admin-role semantics: holder of an admin role may grant the regular role, and the admin role itself ===

#[test]
fun admin_role_holder_can_grant_regular_and_admin() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    // Owner (root authority for the resource) seeds ADMIN_A with PAY's admin role.
    let mut b = scenario.take_shared<Bucket>();
    bucket::owner_grant_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        access::admin(access::pay()),
        ADMIN_A,
        &clock,
        scenario.ctx(),
    );
    let resource = bucket::bucket_resource(&b);
    ts::return_shared(b);

    // ADMIN_A grants the regular PAY role to OPERATOR_B (allowed: holds PAY's admin role).
    scenario.next_tx(ADMIN_A);
    let b = scenario.take_shared<Bucket>();
    access::grant_roles(&mut ac, resource, access::pay(), OPERATOR_B, scenario.ctx());
    assert!(bucket::has_role(&ac, &b, OPERATOR_B, access::pay()), 0);
    // ADMIN_A also grants PAY's admin role to ADMIN_B (admin role implies authority over itself).
    access::grant_roles(&mut ac, resource, access::admin(access::pay()), ADMIN_B, scenario.ctx());
    assert!(access::roles(&ac, resource, ADMIN_B) & access::admin(access::pay()) != 0, 1);
    ts::return_shared(b);

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === privilege escalation: a regular-role holder has no admin authority ===

#[test]
#[expected_failure(abort_code = 701)] // access::ECannotGrantRoles
fun non_admin_cannot_grant() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    let mut b = scenario.take_shared<Bucket>();
    bucket::owner_grant_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        access::pay(),
        OPERATOR_A,
        &clock,
        scenario.ctx(),
    );
    let resource = bucket::bucket_resource(&b);
    ts::return_shared(b);

    // OPERATOR_A holds PAY (regular) but not PAY_ADMIN → cannot grant PAY to anyone.
    scenario.next_tx(OPERATOR_A);
    access::grant_roles(&mut ac, resource, access::pay(), OPERATOR_B, scenario.ctx());

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === privilege escalation: an admin can only grant the specific role(s) it administers ===

#[test]
#[expected_failure(abort_code = 701)] // access::ECannotGrantRoles
fun admin_cannot_grant_role_it_lacks_admin_for() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    let mut b = scenario.take_shared<Bucket>();
    bucket::owner_grant_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        access::admin(access::pay()),
        ADMIN_A,
        &clock,
        scenario.ctx(),
    );
    let resource = bucket::bucket_resource(&b);
    ts::return_shared(b);

    // ADMIN_A administers PAY only; granting GUARDIAN must abort.
    scenario.next_tx(ADMIN_A);
    access::grant_roles(&mut ac, resource, access::guardian(), OPERATOR_B, scenario.ctx());

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === ROOT_RESOURCE: a root grant applies to every Bucket ===

#[test]
fun root_resource_roles_apply_to_all_buckets() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());

    // Two independent Buckets.
    let owner_cap42 = bucket::create_bucket(
        b"b42".to_string(),
        usdc_policy(),
        &clock,
        scenario.ctx(),
    );
    scenario.next_tx(OWNER);
    let b42 = scenario.take_shared<Bucket>();
    ts::return_shared(b42);
    let owner_cap43 = bucket::create_bucket(
        b"b43".to_string(),
        usdc_policy(),
        &clock,
        scenario.ctx(),
    );
    scenario.next_tx(OWNER);

    // Seed a PAY role on the ROOT resource (test-only unchecked seed).
    access::grant_unchecked_for_testing(
        &mut ac,
        access::root_resource(),
        access::pay(),
        OPERATOR_A,
    );

    // OPERATOR_A is now authorized on BOTH buckets via the root fallback, without any per-bucket grant.
    let b42 = scenario.take_shared<Bucket>();
    assert!(bucket::has_role(&ac, &b42, OPERATOR_A, access::pay()), 0);
    assert!(!bucket::has_role(&ac, &b42, OPERATOR_B, access::pay()), 1);
    ts::return_shared(b42);
    scenario.next_tx(OWNER);
    let b43 = scenario.take_shared<Bucket>();
    assert!(bucket::has_role(&ac, &b43, OPERATOR_A, access::pay()), 2);
    assert!(access::has_root_roles(&ac, access::pay(), OPERATOR_A), 3);
    ts::return_shared(b43);

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap42);
    test_utils::destroy(owner_cap43);
    clock.destroy_for_testing();
    scenario.end();
}

// === ROOT_RESOURCE: grant_roles refuses the root resource (must use grant_root_roles) ===

#[test]
#[expected_failure(abort_code = 703)] // access::ERootResourceNotAllowed
fun grant_roles_rejects_root_resource() {
    let mut scenario = ts::begin(OWNER);
    let mut ac = access::new_for_testing(scenario.ctx());
    scenario.next_tx(OWNER);
    access::grant_roles(
        &mut ac,
        access::root_resource(),
        access::pay(),
        OPERATOR_A,
        scenario.ctx(),
    );
    test_utils::destroy(ac);
    scenario.end();
}

// === EAC ∧ capability: expired capability still fails even with the role ===

#[test]
#[expected_failure(abort_code = 415)] // capability::EExpired
fun expired_capability_fails_with_role() {
    let mut scenario = ts::begin(OWNER);
    let mut clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    let mut b = scenario.take_shared<Bucket>();
    bucket::issue_capability(
        &mut b,
        &owner_cap,
        OPERATOR_A,
        b"a".to_string(),
        permissions::pay(),
        1,
        0,
        100,
        RECIPIENT,
        op_limits(),
        &clock,
        scenario.ctx(),
    );
    bucket::owner_grant_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        access::pay(),
        OPERATOR_A,
        &clock,
        scenario.ctx(),
    );
    ts::return_shared(b);

    clock.set_for_testing(1_000_000); // 1000s > 100s
    do_pay(&mut scenario, &ac, &clock, OPERATOR_A, 500_000); // aborts EExpired, not the role

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === EAC ∧ capability: financial limit still applies even with the role ===

#[test]
#[expected_failure(abort_code = 616)] // bucket::ECapabilityLimitExceeded
fun capability_limit_applies_with_role() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    let mut b = scenario.take_shared<Bucket>();
    issue_pay_cap(&mut b, &owner_cap, &clock, OPERATOR_A, small_limits(), scenario.ctx());
    bucket::owner_grant_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        access::pay(),
        OPERATOR_A,
        &clock,
        scenario.ctx(),
    );
    ts::return_shared(b);

    do_pay(&mut scenario, &ac, &clock, OPERATOR_A, 500_000); // exceeds cap limit despite role

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === EAC ∧ Bucket state: paused Bucket rejects protected execution ===

#[test]
#[expected_failure(abort_code = 603)] // bucket::EBucketNotActive
fun paused_bucket_rejects_pay() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    let mut b = scenario.take_shared<Bucket>();
    issue_pay_cap(&mut b, &owner_cap, &clock, OPERATOR_A, op_limits(), scenario.ctx());
    bucket::owner_grant_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        access::pay(),
        OPERATOR_A,
        &clock,
        scenario.ctx(),
    );
    bucket::pause(&mut b, &clock, scenario.ctx());
    ts::return_shared(b);

    do_pay(&mut scenario, &ac, &clock, OPERATOR_A, 500_000); // aborts: not active

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === guardian bridge: EAC GUARDIAN grant lets the principal pause via the existing guardian set ===

#[test]
fun eac_guardian_can_pause() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);

    let mut b = scenario.take_shared<Bucket>();
    bucket::owner_grant_roles(
        &mut ac,
        &mut b,
        &owner_cap,
        access::guardian(),
        GUARDIAN_C,
        &clock,
        scenario.ctx(),
    );
    assert!(bucket::has_role(&ac, &b, GUARDIAN_C, access::guardian()), 0);
    ts::return_shared(b);

    scenario.next_tx(GUARDIAN_C);
    let mut b = scenario.take_shared<Bucket>();
    bucket::pause(&mut b, &clock, scenario.ctx());
    assert!(bucket::status(&b) == bucket::status_paused(), 1);
    ts::return_shared(b);

    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === capability delegation: child cannot exceed parent (unchanged by EAC) ===

#[test]
#[expected_failure(abort_code = 406)] // capability::ELimitExceedsCeiling
fun child_cannot_exceed_parent_limits() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let owner_cap = setup(&mut scenario, &clock);

    let parent_limits = capability::new_limits(1_000, 1_000, 1_000, 10_000, 0);
    let mut b = scenario.take_shared<Bucket>();
    bucket::issue_capability(
        &mut b,
        &owner_cap,
        OPERATOR_A,
        b"a".to_string(),
        permissions::pay() | permissions::delegate(),
        1,
        0,
        DAY_SECS,
        RECIPIENT,
        parent_limits,
        &clock,
        scenario.ctx(),
    );
    ts::return_shared(b);

    scenario.next_tx(OPERATOR_A);
    let mut b = scenario.take_shared<Bucket>();
    let parent_cap = scenario.take_from_sender<OperatorCap>();
    let child_limits = capability::new_limits(1_000_000, 1_000_000, 1_000_000, 10_000, 0);
    bucket::delegate_capability(
        &mut b,
        &parent_cap,
        OPERATOR_B,
        b"b".to_string(),
        permissions::pay(),
        1,
        0,
        DAY_SECS,
        RECIPIENT,
        child_limits,
        &clock,
        scenario.ctx(),
    );
    scenario.return_to_sender(parent_cap);
    ts::return_shared(b);

    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

// === SuiNS resolution ===

fun make_suins(scenario: &mut Scenario, clock: &Clock, name: vector<u8>, target: address): SuiNS {
    let (mut suins_obj, admin_cap) = suins::new_for_testing(scenario.ctx());
    let mut reg = registry::new_for_testing(scenario.ctx());
    let d = domain::new(name.to_string());
    let nft = registry::add_record(&mut reg, d, 1, clock, scenario.ctx());
    registry::set_target_address(&mut reg, d, option::some(target));
    suins::add_registry(&admin_cap, &mut suins_obj, reg);
    test_utils::destroy(admin_cap);
    test_utils::destroy(nft);
    suins_obj
}

#[test]
fun suins_resolved_principal_is_authorized() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);
    let suins_obj = make_suins(&mut scenario, &clock, b"treasury.sui", OPERATOR_A);

    let mut b = scenario.take_shared<Bucket>();
    bucket::owner_grant_roles_by_suins(
        &mut ac,
        &mut b,
        &owner_cap,
        &suins_obj,
        b"treasury.sui".to_string(),
        access::pay(),
        &clock,
        scenario.ctx(),
    );
    assert!(bucket::has_role(&ac, &b, OPERATOR_A, access::pay()), 0);
    assert!(
        bucket::resolve_suins_principal(&suins_obj, b"treasury.sui".to_string(), &clock) == OPERATOR_A,
        1,
    );
    ts::return_shared(b);

    test_utils::destroy(suins_obj);
    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun different_principal_not_authorized_via_suins() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);
    let suins_obj = make_suins(&mut scenario, &clock, b"treasury.sui", OPERATOR_A);

    let mut b = scenario.take_shared<Bucket>();
    bucket::owner_grant_roles_by_suins(
        &mut ac,
        &mut b,
        &owner_cap,
        &suins_obj,
        b"treasury.sui".to_string(),
        access::pay(),
        &clock,
        scenario.ctx(),
    );
    assert!(bucket::has_role(&ac, &b, OPERATOR_A, access::pay()), 0);
    assert!(!bucket::has_role(&ac, &b, OPERATOR_B, access::pay()), 1);
    ts::return_shared(b);

    test_utils::destroy(suins_obj);
    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun stale_suins_identity_does_not_transfer_authority() {
    let mut scenario = ts::begin(OWNER);
    let clock = new_clock(&mut scenario);
    let mut ac = access::new_for_testing(scenario.ctx());
    let owner_cap = setup(&mut scenario, &clock);
    let suins_obj = make_suins(&mut scenario, &clock, b"treasury.sui", OPERATOR_A);

    let mut b = scenario.take_shared<Bucket>();
    bucket::owner_grant_roles_by_suins(
        &mut ac,
        &mut b,
        &owner_cap,
        &suins_obj,
        b"treasury.sui".to_string(),
        access::pay(),
        &clock,
        scenario.ctx(),
    );
    ts::return_shared(b);
    scenario.next_tx(OWNER);

    // The same name later resolves to OPERATOR_B, via a fresh registry the test controls.
    let mut reg2 = registry::new_for_testing(scenario.ctx());
    let d = domain::new(b"treasury.sui".to_string());
    let nft2 = registry::add_record(&mut reg2, d, 1, &clock, scenario.ctx());
    registry::set_target_address(&mut reg2, d, option::some(OPERATOR_B));
    assert!(access::resolve_target(&reg2, b"treasury.sui".to_string(), &clock) == OPERATOR_B, 0);

    // The grant never moved: OPERATOR_A keeps authority, OPERATOR_B has none.
    let b = scenario.take_shared<Bucket>();
    assert!(bucket::has_role(&ac, &b, OPERATOR_A, access::pay()), 1);
    assert!(!bucket::has_role(&ac, &b, OPERATOR_B, access::pay()), 2);
    ts::return_shared(b);

    registry::destroy_for_testing(reg2);
    test_utils::destroy(nft2);
    test_utils::destroy(suins_obj);
    test_utils::destroy(ac);
    test_utils::destroy(owner_cap);
    clock.destroy_for_testing();
    scenario.end();
}
