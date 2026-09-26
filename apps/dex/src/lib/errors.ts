/** Human-readable explanations of BUCKET protocol failures (EVM custom errors, simulator failures, Move aborts). */
export interface Explained {
  readonly title: string
  readonly message: string
}

const EVM: Record<string, Explained> = {
  // Capability layer
  CapabilityRevokedError: { title: 'Authority revoked', message: 'This operator is no longer authorized for this Bucket.' },
  CapabilityEpochRevoked: { title: 'Authority revoked', message: 'The owner revoked every capability on this Bucket (kill switch).' },
  CapabilityExpired: { title: 'Authority expired', message: 'This capability has passed its expiry.' },
  CapabilityNotYetValid: { title: 'Not active yet', message: 'This capability only becomes valid later.' },
  CapabilityPolicySuperseded: { title: 'Policy changed', message: 'The Bucket policy was updated after this capability was issued; it must be re-issued.' },
  CapabilityOperatorMismatch: { title: 'Wrong operator', message: 'This account is not the operator named by the capability.' },
  CapabilityOperatorNameLost: { title: 'Operator name moved', message: "The operator's ENSv2 name no longer points to this account, so its authority is gone." },
  CapabilityIssuerChanged: { title: 'Owner changed', message: 'The Bucket name changed hands after this capability was issued.' },
  CapabilityPermissionDenied: { title: 'Not permitted', message: 'This capability does not grant this kind of action.' },
  CapabilityAssetNotAllowed: { title: 'Asset not allowed', message: 'This capability does not cover this asset.' },
  CapabilityVelocityExceeded: { title: 'Velocity limit reached', message: "This would exceed the capability's hourly or daily limit." },
  CapabilityExhaustedError: { title: 'Execution count used up', message: 'This capability has reached its maximum number of executions.' },
  CapabilityUnknown: { title: 'Unknown capability', message: 'No capability with this id exists.' },
  CapabilityLimitExceedsParent: { title: 'Limit too high', message: 'A delegated capability cannot exceed its parent.' },
  CapabilityPermissionsNotDelegable: { title: 'Permission not delegable', message: 'The Bucket policy does not allow delegating this permission.' },
  CapabilityPayeeInvalid: { title: 'Payee required', message: 'A payment capability must name exactly one payee.' },
  CapabilityWindowInvalid: { title: 'Invalid validity window', message: 'Expiry must be after the start time.' },
  CapabilityLimitsInvalid: { title: 'Invalid limits', message: 'Limits must be positive and per-execution ≤ hourly ≤ daily.' },
  OperatorNameNotRegistered: { title: 'Operator name not found', message: 'That ENSv2 name is not registered under this Bucket.' },
  OperatorIsIssuer: { title: 'Operator is the owner', message: 'The owner cannot be their own operator.' },
  NotBucketOwner: { title: 'Not the owner', message: 'Only the Bucket owner (the live ENSv2 name owner) can do this.' },
  // Controller layer
  SpendLimitExceeded: { title: 'Execution blocked', message: 'This action exceeds your Bucket limit.' },
  BucketVelocityExceeded: { title: 'Execution blocked', message: "This would exceed the Bucket's hourly or daily velocity limit." },
  InsufficientHolderBalance: { title: 'Execution blocked', message: 'Your wallet does not have enough of the required asset.' },
  AssetNotAllowed: { title: 'Asset not in policy', message: "This asset is not part of the Bucket's policy." },
  BucketNotActive: { title: 'Bucket paused', message: 'This Bucket is paused or closed.' },
  WithinPolicy: { title: 'Nothing to rebalance', message: 'Your allocation is already within policy.' },
  NothingToRebalance: { title: 'Nothing to rebalance', message: 'Your allocation is already within policy.' },
  LimitsExhausted: { title: 'Limits used up', message: 'No execution budget remains for this capability right now.' },
  NoOpenIntent: { title: 'No open intent', message: 'There is no open intent to fill.' },
  BucketMathPriceStale: { title: 'Prices are stale', message: 'Reference prices are older than the policy allows; nothing can be priced until they are refreshed.' },
  ERC20InsufficientAllowance: { title: 'Allowance missing', message: 'Your wallet has not approved this spender for enough of the asset.' },
  ERC20InsufficientBalance: { title: 'Insufficient balance', message: 'Not enough of the asset in the wallet.' },
  // SwapVM instructions (0xd0-0xd3) and the matching off-chain simulator failures
  BucketExecutionLimitExceeded: { title: 'Execution blocked', message: 'This action exceeds your Bucket limit.' },
  BucketHourlyLimitExceeded: { title: 'Execution blocked', message: 'This would exceed the hourly limit.' },
  BucketDailyLimitExceeded: { title: 'Execution blocked', message: 'This would exceed the daily limit.' },
  BucketTurnoverLimitExceeded: { title: 'Execution blocked', message: 'This would exceed the daily turnover limit.' },
  BucketIntentBudgetExceeded: { title: 'Execution blocked', message: 'This exceeds what the open intent allows.' },
  BucketAquaBudgetExceeded: { title: 'Execution blocked', message: "This exceeds the strategy's Aqua budget." },
  BucketInsufficientWalletBalance: { title: 'Execution blocked', message: 'Your wallet does not have enough of the required asset.' },
  BucketTakerNotOperator: { title: 'Wrong operator', message: 'Only the intent operator can fill it.' },
  BucketTargetOvershoot: { title: 'Too large', message: 'This would push the allocation past its target.' },
  BucketWithinPolicy: { title: 'Nothing to rebalance', message: 'Your allocation is already within policy.' },
  BucketDirectionInvalid: { title: 'Wrong direction', message: 'This trade would move the allocation away from its targets.' },
  BucketZeroAmount: { title: 'Amount too small', message: 'The amount rounds to zero.' },
  PostStateNotImproved: { title: 'Would worsen allocation', message: 'This trade would increase deviation from your policy.' },
  PostStateOutOfBand: { title: 'Outside allocation band', message: "This trade would push an asset outside its policy band." },
}

const SUI: Record<string, Record<number, Explained>> = {
  bucket: {
    603: { title: 'Bucket paused', message: 'This Bucket is paused.' },
    604: { title: 'Bucket closed', message: 'This Bucket is closed.' },
    609: { title: 'Unknown capability', message: 'No capability matches this OperatorCap.' },
    611: { title: 'Asset not in policy', message: "This coin type is not part of the Bucket's policy." },
    612: { title: 'Amount too small', message: 'The amount must be greater than zero.' },
    613: { title: 'Execution blocked', message: "The Bucket's vault does not hold enough of this coin." },
    614: { title: 'Deadline passed', message: 'The payment deadline has passed.' },
    615: { title: 'Recipient not allowed', message: "Payments under this capability can only go to its fixed payee." },
    616: { title: 'Execution blocked', message: 'This payment exceeds your Bucket limit.' },
    617: { title: 'Execution blocked', message: "This exceeds the Bucket-wide limit." },
    621: { title: 'Execution blocked', message: 'This operator is no longer authorized for this Bucket (EAC role revoked).' },
  },
  capability: {
    410: { title: 'Authority revoked', message: 'Every capability on this Bucket was revoked (epoch bumped).' },
    411: { title: 'Policy changed', message: 'The policy changed after this capability was issued.' },
    412: { title: 'Authority revoked', message: 'This capability was revoked.' },
    413: { title: 'Execution count used up', message: 'This capability has reached its execution cap.' },
    414: { title: 'Not active yet', message: 'This capability is not valid yet.' },
    415: { title: 'Authority expired', message: 'This capability has expired.' },
    416: { title: 'Not permitted', message: 'This capability does not grant payments.' },
    417: { title: 'Asset not allowed', message: 'This capability does not cover this asset.' },
    419: { title: 'Velocity limit reached', message: "This exceeds the capability's hourly or daily limit." },
    420: { title: 'Wrong operator', message: 'This account is not the operator of the capability.' },
  },
  access: {
    705: { title: 'Name not registered', message: 'That SuiNS name is not registered.' },
    706: { title: 'Name expired', message: 'That SuiNS name has expired.' },
    707: { title: 'Name has no address', message: 'That SuiNS name does not point to an address.' },
  },
}

export function explainError(name: string | null | undefined): Explained | null {
  return name ? (EVM[name] ?? null) : null
}

/** Parses `MoveAbort ... abort code: N, in '0x..::module::function'` from a Sui status/error string. */
export function explainMoveAbort(text: string): (Explained & { code: number; module: string }) | null {
  const m = /abort code: (\d+), in '0x[0-9a-fA-F]+::(\w+)::/.exec(text) ?? /"abortCode":"(\d+)".*?"module":"(\w+)"/.exec(text)
  if (!m?.[1] || !m[2]) return null
  const code = Number(m[1])
  const module = m[2]
  const known = SUI[module]?.[code]
  return known ? { ...known, code, module } : { title: 'Execution blocked', message: `Move abort ${code} in ${module}.`, code, module }
}
