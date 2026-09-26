/**
 * Full SuiNS integration test for BUCKET:
 *  TX1: Register "bucketprotocol.sui" (SUI payment via keeper-maintained PriceInfoObject)
 *  TX2: owner_grant_roles_by_suins + issue_capability + deposit SUI vault
 *  TX3: authorized pay<SUI>
 *  TX4: owner_revoke_roles
 *  dry5: devInspect pay → verify ENotAuthorizedRole
 */
import * as dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { bcs } from '@mysten/sui/bcs'
import { SuinsClient } from '@mysten/suins'

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

// ─── SuiNS Testnet constants (SDK 2.0.12 verified) ──────────────────────────
const SUINS_PKG_V2  = '0x40eee27b014a872f5c3330dcd5329aa55c7fe0fcc6e70c6498852e2e3727172e'
const SUINS_PKG_V1  = '0x22fa05f21b1ad71442491220bb9338f7b7095fe35000ef88d5400d28523bdd93'
const PAYMENTS_PKG  ='0x4f33a0e1e30530f2aa500a41b9e3d502f8af3ef2c20bd0a1e42374e329da7cb0'
const SUINS_OBJECT  = '0x300369e8909b9a6464da265b9a5a9ab6fe2158a040e84e808628cde7a07ee5a3'
const SUINS_ISV     = 22205838
const BBB_VAULT     = '0xa0b7a4dcbb85209c9096a4e0e85e43b716377c605743193abe915e9c9f3043e5'
const BBB_ISV       = 503149575
const PRICE_INFO    = '0x867877562b5d8ac262d93b02062e04b428a2f9bfbb2f05b8af52e04cd98bd241'
const PRICE_ISV     = 854938920
const CLOCK_ID      = '0x0000000000000000000000000000000000000000000000000000000000000006'
const SUI_TYPE      = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'

// ─── BUCKET Testnet deployment ───────────────────────────────────────────────
const BUCKET_PKG     = '0x145ba9b61b1e7c022af62b0fb3160a835d8592eacfd1c5e96f261fc44b4b1153'
const ACCESS_CONTROL = '0xf763e21898521dfd4cf7e4b7eb725ad8eb6f4414d3e4b39f02e230e0e244bfe5'
const AC_ISV         = 349181961
const TEST_BUCKET    = '0x03ca254481432de995613bfa31314c7d5f4cbefdeb1cfc8859c0540543809314'
const TB_ISV         = 1029742250
const OWNER_CAP      = '0x882bf79499a189cb3972b3553590b655a3873a45b847aa98e87cd1956087c5c5'

const DOMAIN_NAME   = 'bucketprotocol.sui'
const MAX_U64       = BigInt('18446744073709551615')
const ROLE_PAY      = BigInt(0x10)  // access.move: const ROLE_PAY: u256 = 0x10
const PERM_PAY      = 4             // permissions.move: const PERM_PAY: u32 = 4

const GRPC_URL = 'https://fullnode.testnet.sui.io:443'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clock(tx: Transaction) {
  return tx.sharedObjectRef({ objectId: CLOCK_ID, initialSharedVersion: 1, mutable: false })
}

type SimResult = { ok: true } | { ok: false; error: string }

async function simulate(
  client: SuiGrpcClient, tx: Transaction, sender: string
): Promise<SimResult> {
  tx.setSenderIfNotSet(sender)
  const r = await client.simulateTransaction({ transaction: tx })
  if (r.$kind === 'Transaction') {
    if (r.Transaction.status.success === true) return { ok: true }
    return { ok: false, error: JSON.stringify(r.Transaction.status) }
  }
  return { ok: false, error: JSON.stringify((r as { FailedTransaction: unknown }).FailedTransaction ?? r) }
}

const STALE_ORACLE_RE = /check_price_is_fresh|PriceStale|price.*stale|stale.*price/i

async function execTx(
  client: SuiGrpcClient,
  keypair: Ed25519Keypair,
  tx: Transaction,
  label: string,
  buildTx?: () => Transaction,
): Promise<{ digest: string; created: Array<{ objectId: string; type: string }> } | null> {
  const sender = keypair.toSuiAddress()

  let currentTx = tx
  for (let attempt = 0; attempt < 30; attempt++) {
    currentTx.setSenderIfNotSet(sender)
    const dry = await simulate(client, currentTx, sender)
    if (!dry.ok) {
      const err = (dry as { ok: false; error: string }).error
      if (STALE_ORACLE_RE.test(err) && buildTx) {
        console.log(`  [${label}] oracle stale — waiting 15s for keeper update...`)
        await new Promise(r => setTimeout(r, 15_000))
        currentTx = buildTx()
        continue
      }
      console.error(`  [${label}] simulate FAILED:`, err)
      return null
    }
    break
  }
  console.log(`  [${label}] simulate OK — submitting...`)

  const r = await client.signAndExecuteTransaction({
    transaction: currentTx,
    signer: keypair,
    include: { effects: true, objectTypes: true },
  })

  const executed = r.$kind === 'Transaction' ? r.Transaction : r.FailedTransaction!
  console.log(`  Digest:   ${executed.digest}`)
  console.log(`  Status:   ${JSON.stringify(executed.status)}`)
  console.log(`  Explorer: https://suiscan.xyz/testnet/tx/${executed.digest}`)

  if (!executed.status.success) {
    console.error(`  FAILED`)
    return null
  }
  await client.waitForTransaction({ digest: executed.digest })

  const objectTypes = r.$kind === 'Transaction' ? (r.Transaction.objectTypes ?? {}) : {}
  const changedObjects = r.$kind === 'Transaction' ? (r.Transaction.effects?.changedObjects ?? []) : []
  const created = changedObjects
    .filter(c => c.idOperation === 'Created')
    .map(c => ({ objectId: c.objectId, type: objectTypes[c.objectId] ?? '' }))

  return { digest: executed.digest, created }
}

async function main(): Promise<void> {
  const privkey = process.env.SUI_PRIVATE_KEY
  if (!privkey) throw new Error('SUI_PRIVATE_KEY not set in .env')

  const { scheme, secretKey } = decodeSuiPrivateKey(privkey)
  if (scheme !== 'ED25519') throw new Error(`unsupported key scheme ${scheme}`)
  const keypair = Ed25519Keypair.fromSecretKey(secretKey)
  const deployer = keypair.toSuiAddress()
  console.log('Deployer:', deployer)

  // The operator must not be the Bucket owner: bucket::has_role treats the owner as holding every role,
  // so revoking ROLE_PAY from the owner can never take effect.
  const opKey = process.env.SUI_OPERATOR_PRIVATE_KEY
  if (!opKey) throw new Error('SUI_OPERATOR_PRIVATE_KEY not set in .env')
  const operatorKp = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(opKey).secretKey)
  const operator = operatorKp.toSuiAddress()
  console.log('Operator:', operator)

  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC_URL })

  // ─── Check for existing SuinsRegistration ─────────────────────────────────
  let nftId: string | null = null
  let registrationDigest: string | null = null

  console.log('\n=== Checking for existing SuinsRegistration NFT ===')
  const ownedRegs = await client.listOwnedObjects({
    owner: deployer,
    type: `${SUINS_PKG_V1}::suins_registration::SuinsRegistration`,
  })
  const firstReg = ownedRegs.objects[0]
  if (firstReg) {
    nftId = firstReg.objectId
    console.log('  Found existing NFT:', nftId, '— skipping TX1')
    registrationDigest = 'already-registered'
  }

  // ─── TX1: Register domain ─────────────────────────────────────────────────
  if (!nftId) {
    console.log('\n=== TX1: Register bucketprotocol.sui ===')

    function buildTx1(): Transaction {
      const tx = new Transaction()
      const suinsMut = tx.sharedObjectRef({ objectId: SUINS_OBJECT, initialSharedVersion: SUINS_ISV, mutable: true })
      const bbbMut   = tx.sharedObjectRef({ objectId: BBB_VAULT,    initialSharedVersion: BBB_ISV,   mutable: true })
      const priceRef = tx.sharedObjectRef({ objectId: PRICE_INFO,   initialSharedVersion: PRICE_ISV, mutable: false })

      // 1a. init_registration(suins: &mut SuiNS, domain: String) → PaymentIntent
      const paymentIntent = tx.moveCall({
        target: `${SUINS_PKG_V2}::payment::init_registration`,
        arguments: [suinsMut, tx.pure.string(DOMAIN_NAME)],
      })[0]!

      // 1b. calculate_price_after_discount<CoinType>(suins, intent) → u64  (generic — type arg required)
      const baseAmount = tx.moveCall({
        target: `${PAYMENTS_PKG}::payments::calculate_price_after_discount`,
        typeArguments: [SUI_TYPE],
        arguments: [suinsMut, paymentIntent],
      })[0]!

      // 1c. calculate_price_pro<SUI>(suins: &SuiNS, base: u64, clock: &Clock, price: &PriceInfoObject) → u64 (SUI mist)
      const suiAmount = tx.moveCall({
        target: `${PAYMENTS_PKG}::payments::calculate_price_pro`,
        typeArguments: [SUI_TYPE],
        arguments: [suinsMut, baseAmount, clock(tx), priceRef],
      })[0]!

      // 1d. Split gas coin
      const paymentCoin = tx.splitCoins(tx.gas, [suiAmount])[0]!

      // 1e. handle_payment_pro<SUI>(suins, vault, intent, payment, clock, price, guard) → Receipt
      const receipt = tx.moveCall({
        target: `${PAYMENTS_PKG}::payments::handle_payment_pro`,
        typeArguments: [SUI_TYPE],
        arguments: [
          suinsMut,
          bbbMut,
          paymentIntent,
          paymentCoin,
          clock(tx),
          priceRef,
          tx.pure(bcs.u64().serialize(MAX_U64)),
        ],
      })[0]!

      // 1f. register(receipt, suins, clock) → SuinsRegistration NFT
      const nft = tx.moveCall({
        target: `${SUINS_PKG_V2}::payment::register`,
        arguments: [receipt, suinsMut, clock(tx)],
      })[0]!

      // 1g. set_target_address(suins, nft, option<address>(deployer), clock)
      tx.moveCall({
        target: `${SUINS_PKG_V2}::controller::set_target_address`,
        arguments: [
          suinsMut,
          nft,
          tx.pure(bcs.option(bcs.Address).serialize(deployer)),
          clock(tx),
        ],
      })

      tx.transferObjects([nft], tx.pure.address(deployer))
      return tx
    }

    const res1 = await execTx(client, keypair, buildTx1(), 'TX1:register', buildTx1)
    if (!res1) { console.error('TX1 failed — aborting'); return }
    registrationDigest = res1.digest

    nftId = res1.created.find(c => c.type.includes('SuinsRegistration'))?.objectId ?? null
    if (!nftId) {
      // Fallback: look in owned objects
      const owned = await client.listOwnedObjects({
        owner: deployer,
        type: `${SUINS_PKG_V1}::suins_registration::SuinsRegistration`,
      })
      nftId = owned.objects[0]?.objectId ?? null
    }
    console.log('  SuinsRegistration NFT:', nftId)
  }

  if (!nftId) { console.error('No SuinsRegistration NFT found — aborting'); return }

  const suinsClient = new SuinsClient({ client, network: 'testnet' })
  let tx0Digest: string | null = null
  if ((await suinsClient.getNameRecord(DOMAIN_NAME))?.targetAddress !== operator) {
    console.log('\n=== TX0: point name at operator + fund operator gas ===')
    const tx0 = new Transaction()
    tx0.moveCall({
      target: `${SUINS_PKG_V2}::controller::set_target_address`,
      arguments: [
        tx0.sharedObjectRef({ objectId: SUINS_OBJECT, initialSharedVersion: SUINS_ISV, mutable: true }),
        tx0.object(nftId),
        tx0.pure(bcs.option(bcs.Address).serialize(operator)),
        clock(tx0),
      ],
    })
    const gasCoin = tx0.splitCoins(tx0.gas, [tx0.pure.u64(50_000_000)])[0]!
    tx0.transferObjects([gasCoin], tx0.pure.address(operator))
    const res0 = await execTx(client, keypair, tx0, 'TX0:target+fund')
    if (!res0) { console.error('TX0 failed — aborting'); return }
    tx0Digest = res0.digest
  }

  const resolved = (await suinsClient.getNameRecord(DOMAIN_NAME))?.targetAddress ?? null
  console.log('\n=== Resolve ===')
  console.log(`  ${DOMAIN_NAME} → ${resolved}`)
  if (resolved !== operator) { console.error('  Name does not resolve to operator — aborting'); return }

  // ─── TX2: Grant + capability + deposit ────────────────────────────────────
  console.log('\n=== TX2: owner_grant_roles_by_suins + issue_capability + deposit ===')
  const tx2 = new Transaction()
  const nowSec = BigInt(Math.floor(Date.now() / 1000))

  // 2-pre. Reinstall the policy with the canonical coin-type string that type_name::into_string() produces
  //        (TestBucket was created with "0x2::sui::SUI", which accepted_type never matches). Same limits.
  const assets = tx2.moveCall({
    target: `${BUCKET_PKG}::policy::new_assets`,
    arguments: [
      tx2.pure.vector('string', [SUI_TYPE.slice(2)]),
      tx2.pure.vector('u16', [10_000]),
    ],
  })[0]!
  const newPolicy = tx2.moveCall({
    target: `${BUCKET_PKG}::policy::new`,
    arguments: [
      tx2.pure.u128(1_000_000_000_000n),
      tx2.pure.u128(1_000_000_000_000n),
      tx2.pure.u128(1_000_000_000_000n),
      tx2.pure.u16(10_000),
      tx2.pure.u32(7),
      assets,
    ],
  })[0]!
  tx2.moveCall({
    target: `${BUCKET_PKG}::bucket::update_policy`,
    arguments: [
      tx2.sharedObjectRef({ objectId: TEST_BUCKET, initialSharedVersion: TB_ISV, mutable: true }),
      tx2.object(OWNER_CAP),
      newPolicy,
      clock(tx2),
    ],
  })

  // 2a. Grant ROLE_PAY to the deployer's SuiNS name
  tx2.moveCall({
    target: `${BUCKET_PKG}::bucket::owner_grant_roles_by_suins`,
    arguments: [
      tx2.sharedObjectRef({ objectId: ACCESS_CONTROL, initialSharedVersion: AC_ISV, mutable: true }),
      tx2.sharedObjectRef({ objectId: TEST_BUCKET,    initialSharedVersion: TB_ISV, mutable: true }),
      tx2.object(OWNER_CAP),
      tx2.sharedObjectRef({ objectId: SUINS_OBJECT,   initialSharedVersion: SUINS_ISV, mutable: false }),
      tx2.pure.string(DOMAIN_NAME),
      tx2.pure(bcs.u256().serialize(ROLE_PAY)),
      clock(tx2),
    ],
  })

  // 2b. Build limits struct
  const limits = tx2.moveCall({
    target: `${BUCKET_PKG}::capability::new_limits`,
    arguments: [
      tx2.pure(bcs.u128().serialize(BigInt('1000000000'))),   // max_per_tx  1 SUI
      tx2.pure(bcs.u128().serialize(BigInt('10000000000'))),  // max_hourly 10 SUI
      tx2.pure(bcs.u128().serialize(BigInt('10000000000'))),  // max_daily  10 SUI
      tx2.pure.u16(10000),  // max_daily_turnover_bps 100 %
      tx2.pure.u32(0),      // max_executions unlimited
    ],
  })

  // 2c. Issue OperatorCap to the operator (payee = deployer)
  tx2.moveCall({
    target: `${BUCKET_PKG}::bucket::issue_capability`,
    arguments: [
      tx2.sharedObjectRef({ objectId: TEST_BUCKET, initialSharedVersion: TB_ISV, mutable: true }),
      tx2.object(OWNER_CAP),
      tx2.pure.address(operator),
      tx2.pure.string(DOMAIN_NAME),
      tx2.pure.u32(PERM_PAY),
      tx2.pure.u8(0x01),  // policy asset index 0 = SUI
      tx2.pure.u64(nowSec - 60n),
      tx2.pure.u64(nowSec + 7n * 86_400n),
      tx2.pure.address(deployer),
      limits[0]!,
      clock(tx2),
    ],
  })

  // 2d. Deposit 0.1 SUI into vault
  const depositCoin = tx2.splitCoins(tx2.gas, [tx2.pure.u64(100_000_000)])[0]!
  tx2.moveCall({
    target: `${BUCKET_PKG}::bucket::deposit`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx2.sharedObjectRef({ objectId: TEST_BUCKET, initialSharedVersion: TB_ISV, mutable: true }),
      depositCoin,
      clock(tx2),
    ],
  })

  const res2 = await execTx(client, keypair, tx2, 'TX2:grant+cap+deposit')
  if (!res2) { console.error('TX2 failed — aborting'); return }

  const operatorCapId = res2.created.find(c => c.type.includes('OperatorCap'))?.objectId ?? null
  if (!operatorCapId) { console.error('OperatorCap not found in TX2 — aborting'); return }
  console.log('  OperatorCap:', operatorCapId)

  // ─── TX3: Authorized pay<SUI> ─────────────────────────────────────────────
  console.log('\n=== TX3: pay<SUI> with OperatorCap ===')
  const tx3 = new Transaction()
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

  tx3.moveCall({
    target: `${BUCKET_PKG}::bucket::pay`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx3.sharedObjectRef({ objectId: TEST_BUCKET,    initialSharedVersion: TB_ISV, mutable: true }),
      tx3.sharedObjectRef({ objectId: ACCESS_CONTROL, initialSharedVersion: AC_ISV, mutable: false }),
      tx3.object(operatorCapId),
      tx3.pure.address(deployer),
      tx3.pure.u64(BigInt(1_000)),
      tx3.pure.u64(deadline),
      clock(tx3),
    ],
  })

  const res3 = await execTx(client, operatorKp, tx3, 'TX3:pay')
  if (!res3) { console.error('TX3 pay() failed — aborting'); return }
  console.log('  Authorized payment succeeded!')

  // ─── TX4: Revoke ROLE_PAY ──────────────────────────────────────────────────
  console.log('\n=== TX4: owner_revoke_roles ===')
  const tx4 = new Transaction()

  // owner_revoke_roles(ac, bucket, cap, role_bitmap, principal, clock, ctx)
  tx4.moveCall({
    target: `${BUCKET_PKG}::bucket::owner_revoke_roles`,
    arguments: [
      tx4.sharedObjectRef({ objectId: ACCESS_CONTROL, initialSharedVersion: AC_ISV, mutable: true }),
      tx4.sharedObjectRef({ objectId: TEST_BUCKET,    initialSharedVersion: TB_ISV, mutable: true }),
      tx4.object(OWNER_CAP),
      tx4.pure(bcs.u256().serialize(ROLE_PAY)),
      tx4.pure.address(operator),
      clock(tx4),
    ],
  })

  const res4 = await execTx(client, keypair, tx4, 'TX4:revoke')
  if (!res4) { console.error('TX4 revoke failed — aborting'); return }
  console.log('  ROLE_PAY revoked!')

  // ─── dry5: Verify pay() rejected after revoke ─────────────────────────────
  console.log('\n=== dry5: Verify pay() rejected after revoke ===')
  const tx5 = new Transaction()
  tx5.moveCall({
    target: `${BUCKET_PKG}::bucket::pay`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx5.sharedObjectRef({ objectId: TEST_BUCKET,    initialSharedVersion: TB_ISV, mutable: true }),
      tx5.sharedObjectRef({ objectId: ACCESS_CONTROL, initialSharedVersion: AC_ISV, mutable: false }),
      tx5.object(operatorCapId),
      tx5.pure.address(deployer),
      tx5.pure.u64(BigInt(1_000)),
      tx5.pure.u64(deadline),
      clock(tx5),
    ],
  })

  const dry5 = await simulate(client, tx5, operator)
  if (dry5.ok) {
    console.error('  ERROR: pay() succeeded after revoke — PERMISSION SYSTEM BROKEN')
  } else {
    console.log('  pay() correctly REJECTED:', dry5.error)
    console.log('  ROLE ENFORCEMENT VERIFIED')
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n=== FINAL SUMMARY ===')
  console.log('Domain:              ', DOMAIN_NAME)
  console.log('SuinsRegistration:   ', nftId)
  console.log('OperatorCap:         ', operatorCapId)
  if (registrationDigest && registrationDigest !== 'already-registered')
    console.log('TX1 register:        https://suiscan.xyz/testnet/tx/' + registrationDigest)
  if (tx0Digest) console.log('TX0 target+fund:     https://suiscan.xyz/testnet/tx/' + tx0Digest)
  console.log('TX2 grant+cap:       https://suiscan.xyz/testnet/tx/' + res2.digest)
  console.log('TX3 pay(authorized): https://suiscan.xyz/testnet/tx/' + res3.digest)
  console.log('TX4 revoke:          https://suiscan.xyz/testnet/tx/' + res4.digest)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})
