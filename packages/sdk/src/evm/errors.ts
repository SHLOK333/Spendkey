import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from 'viem'

import {
  aquaAbi,
  bucketAuthorityAbi,
  bucketCapabilitiesAbi,
  bucketCapabilityGuardErrorsAbi,
  bucketControllerAbi,
  bucketEngineAbi,
  bucketInstructionArgsErrorsAbi,
  bucketMathErrorsAbi,
  bucketPolicyErrorsAbi,
  bucketQuoteErrorsAbi,
  bucketSpendLimitErrorsAbi,
  bucketSwapVmRouterAbi,
  permissionedRegistryAbi,
} from '../abi/generated'

type AbiItem = Abi[number]

function errorsOf(abi: Abi): AbiItem[] {
  return abi.filter((item) => item.type === 'error')
}

/**
 * Every custom error a Bucket transaction can surface, across the controller, capability registry, authority
 * (ENSv2 guardian/name binding), SwapVM router, the three Bucket instructions, the engine and policy libraries,
 * and Aqua.
 */
export const bucketErrorsAbi: Abi = [
  ...errorsOf(bucketControllerAbi),
  ...errorsOf(bucketCapabilitiesAbi),
  ...errorsOf(bucketAuthorityAbi),
  ...errorsOf(bucketSwapVmRouterAbi),
  ...errorsOf(bucketCapabilityGuardErrorsAbi),
  ...errorsOf(bucketQuoteErrorsAbi),
  ...errorsOf(bucketSpendLimitErrorsAbi),
  ...errorsOf(bucketInstructionArgsErrorsAbi),
  ...errorsOf(bucketEngineAbi),
  ...errorsOf(bucketMathErrorsAbi),
  ...errorsOf(bucketPolicyErrorsAbi),
  ...errorsOf(aquaAbi),
  ...errorsOf(permissionedRegistryAbi),
].filter(
  (item, index, all) =>
    item.type === 'error' && all.findIndex((other) => other.type === 'error' && other.name === item.name) === index,
)

export class BucketProtocolError extends Error {
  constructor(
    readonly errorName: string,
    readonly args: readonly unknown[],
    override readonly cause: unknown,
  ) {
    super(`${errorName}(${args.map((arg) => String(arg)).join(', ')})`)
    this.name = 'BucketProtocolError'
  }
}

/** Extracts revert data from a viem error and decodes it against every Bucket-related error definition. */
export function decodeBucketError(error: unknown): BucketProtocolError | null {
  if (!(error instanceof BaseError)) return null
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
  let data: Hex | undefined
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.data?.errorName) {
      return new BucketProtocolError(reverted.data.errorName, reverted.data.args ?? [], error)
    }
    data = reverted.raw
  }
  if (!data) {
    const withData = error.walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex } | null
    data = withData?.data
  }
  if (!data || data === '0x') return null
  try {
    const decoded = decodeErrorResult({ abi: bucketErrorsAbi, data })
    return new BucketProtocolError(decoded.errorName, decoded.args ?? [], error)
  } catch {
    return null
  }
}

/** Re-throws `error` as a decoded `BucketProtocolError` when possible. */
export function rethrowDecoded(error: unknown): never {
  throw decodeBucketError(error) ?? error
}
