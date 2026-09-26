import { Permission, hasPermissions, type SuiBucketState } from '@bucket/protocol-types'
import type { Transaction } from '@mysten/sui/transactions'

import {
  buildAddGuardianTx,
  buildBindEvmTx,
  buildCreateBucketTx,
  buildDelegateCapabilityTx,
  buildDepositTx,
  buildGrantRolesTx,
  buildGrantRootRolesTx,
  buildIssueCapabilityTx,
  buildOwnerGrantRolesBySuinsTx,
  buildOwnerGrantRolesTx,
  buildOwnerRevokeRolesTx,
  buildPauseTx,
  buildPayBucketToBucketTx,
  buildPayManyTx,
  buildPayTx,
  buildResumeTx,
  buildRevokeAllTx,
  buildRevokeCapabilityTx,
  buildRevokeRolesTx,
  buildRevokeRootRolesTx,
  buildUpdatePolicyTx,
  buildWithdrawTx,
  BucketSui,
  type SuiCapabilityGrantInput,
} from './sui/bucket'
/** Executes a Sui transaction with whatever signer the host has (keypair in scripts, wallet in the browser). */
export type SuiExecutor = (tx: Transaction) => Promise<{
  digest: string
  created: (suffix: '::bucket::Bucket' | '::bucket::OwnerCap' | '::bucket::OperatorCap') => string[]
}>

export class SuiClientError extends Error {
  override name = 'SuiClientError'
}

/**
 * High-level Sui-native Bucket API: native capability issuance/delegation/revocation and native payments
 * (single, multi-recipient atomic, Bucket-to-Bucket), independent of the EVM stack. `bind_evm` on the underlying
 * Bucket module attaches an EVM twin for attribution only — it never makes the two chains share enforcement.
 */
export class SuiBucketClient {
  constructor(
    readonly sui: BucketSui,
    readonly executor: SuiExecutor,
  ) {}

  async createBucket(input: Parameters<typeof buildCreateBucketTx>[0]) {
    const result = await this.executor(buildCreateBucketTx(input))
    const [objectId] = result.created('::bucket::Bucket')
    const [ownerCapId] = result.created('::bucket::OwnerCap')
    if (!objectId || !ownerCapId) throw new SuiClientError('Bucket creation produced no objects')
    return { objectId, ownerCapId, digest: result.digest }
  }

  async bindEvm(input: Parameters<typeof buildBindEvmTx>[0]) {
    return this.executor(buildBindEvmTx(input))
  }

  async updatePolicy(input: Parameters<typeof buildUpdatePolicyTx>[0]) {
    return this.executor(buildUpdatePolicyTx(input))
  }

  /** Issues a root capability directly to `grant.operator` (resolved off-chain, e.g. from a SuiNS name). */
  async issueCapability(input: { packageId: string; bucketObjectId: string; ownerCapId: string; grant: SuiCapabilityGrantInput }) {
    const result = await this.executor(buildIssueCapabilityTx(input))
    const [operatorCapId] = result.created('::bucket::OperatorCap')
    return { operatorCapId, digest: result.digest }
  }

  /** Delegates a child of the caller's own capability. Requires `PERM_DELEGATE` on the parent. */
  async delegateCapability(input: { packageId: string; bucketObjectId: string; parentOperatorCapId: string; grant: SuiCapabilityGrantInput }) {
    const result = await this.executor(buildDelegateCapabilityTx(input))
    const [operatorCapId] = result.created('::bucket::OperatorCap')
    return { operatorCapId, digest: result.digest }
  }

  async revokeCapability(input: Parameters<typeof buildRevokeCapabilityTx>[0]) {
    return this.executor(buildRevokeCapabilityTx(input))
  }

  /** Kill switch: invalidates every capability of the Bucket at once. */
  async revokeAll(input: Parameters<typeof buildRevokeAllTx>[0]) {
    return this.executor(buildRevokeAllTx(input))
  }

  async pause(input: Parameters<typeof buildPauseTx>[0]) {
    return this.executor(buildPauseTx(input))
  }

  async resume(input: Parameters<typeof buildResumeTx>[0]) {
    return this.executor(buildResumeTx(input))
  }

  async addGuardian(input: Parameters<typeof buildAddGuardianTx>[0]) {
    return this.executor(buildAddGuardianTx(input))
  }

  // --- BUCKET Enhanced Access Control (ENSv2 semantics): resource-scoped role bitmaps, enforced in Move ---

  /** Owner bootstrap: seeds `roleBitmap` for `principal` on this Bucket's resource (no pre-existing admin role
   *  required — the OwnerCap is the resource's root authority). */
  async ownerGrantRoles(input: Parameters<typeof buildOwnerGrantRolesTx>[0]) {
    return this.executor(buildOwnerGrantRolesTx(input))
  }

  /** Owner bootstrap by SuiNS name: Move resolves the name to its live target address on-chain, then seeds the
   *  role bitmap to that address (never to the string). */
  async ownerGrantRolesBySuins(input: Parameters<typeof buildOwnerGrantRolesBySuinsTx>[0]) {
    return this.executor(buildOwnerGrantRolesBySuinsTx(input))
  }

  /** Owner bootstrap revoke. */
  async ownerRevokeRoles(input: Parameters<typeof buildOwnerRevokeRolesTx>[0]) {
    return this.executor(buildOwnerRevokeRolesTx(input))
  }

  /** ENSv2 `grantRoles`: the caller must hold the admin role for every bit granted. `resource` is a Bucket's
   *  resource id; use `grantRootRoles` for the root resource. */
  async grantRoles(input: Parameters<typeof buildGrantRolesTx>[0]) {
    return this.executor(buildGrantRolesTx(input))
  }

  /** ENSv2 `revokeRoles`: admin-role checked; rejects the root resource. */
  async revokeRoles(input: Parameters<typeof buildRevokeRolesTx>[0]) {
    return this.executor(buildRevokeRolesTx(input))
  }

  /** ENSv2 `grantRootRoles`: grants on the ROOT_RESOURCE, applying to every Bucket. */
  async grantRootRoles(input: Parameters<typeof buildGrantRootRolesTx>[0]) {
    return this.executor(buildGrantRootRolesTx(input))
  }

  /** ENSv2 `revokeRootRoles`. */
  async revokeRootRoles(input: Parameters<typeof buildRevokeRootRolesTx>[0]) {
    return this.executor(buildRevokeRootRolesTx(input))
  }

  async deposit(input: Parameters<typeof buildDepositTx>[0]) {
    return this.executor(buildDepositTx(input))
  }

  async withdraw(input: Parameters<typeof buildWithdrawTx>[0]) {
    return this.executor(buildWithdrawTx(input))
  }

  /** Pays `amount` of `coinType` from the vault to the capability's fixed payee. Rejects if the caller's
   *  capability lacks `PAY`, is expired/revoked/exhausted, or the amount exceeds its limits — checked on-chain;
   *  this only pre-validates what's cheap to check off-chain first. */
  async pay(input: Parameters<typeof buildPayTx>[0]) {
    return this.executor(buildPayTx(input))
  }

  /** Atomic multi-recipient settlement: every payment succeeds or the whole call aborts. */
  async payMany(input: Parameters<typeof buildPayManyTx>[0]) {
    return this.executor(buildPayManyTx(input))
  }

  /** Bucket-to-Bucket payment: moves value directly between two vaults in one atomic call. */
  async payBucketToBucket(input: Parameters<typeof buildPayBucketToBucketTx>[0]) {
    return this.executor(buildPayBucketToBucketTx(input))
  }

  async getBucket(objectId: string): Promise<SuiBucketState> {
    return this.sui.getBucket(objectId)
  }

  /** True when `operator` is the live operator of a capability nonce and it grants `permission`. Reads the
   *  capability through the caller-supplied `OperatorCap` id, which the SDK does not yet decode on its own
   *  (see `BucketSui.getCapability`) — pass the decoded capability instead once that read path is wired up. */
  hasPermission(capabilityPermissions: number, permission: number): boolean {
    return hasPermissions(capabilityPermissions, permission)
  }
}

export { Permission as SuiPermission }
