// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025.

import { concat, getAddress, isAddressEqual, numberToHex, size, zeroAddress, type Address, type Hex } from 'viem'

/** Taker trait flags (SwapVM `TakerTraitsLib`). */
export const TakerTraitFlag = {
  IsExactIn: 0x0001,
  ShouldUnwrapWeth: 0x0002,
  HasPreTransferInCallback: 0x0004,
  HasPreTransferOutCallback: 0x0008,
  IsStrictThresholdAmount: 0x0010,
  IsFirstTransferFromTaker: 0x0020,
  UseTransferFromAndAquaPush: 0x0040,
  IsAToB: 0x0080,
  AllowPartialFill: 0x0100,
} as const

export interface TakerTraitsArgs {
  readonly taker: Address
  readonly isExactIn: boolean
  readonly isAToB: boolean
  /** Minimum amountOut (exact-in) or maximum amountIn (exact-out); `null` for none. */
  readonly threshold: bigint | null
  readonly isStrictThresholdAmount?: boolean
  readonly allowPartialFill?: boolean
  readonly useTransferFromAndAquaPush?: boolean
  readonly isFirstTransferFromTaker?: boolean
  readonly to?: Address
  /** Unix seconds, 0 for none. */
  readonly deadline?: number
  readonly instructionsArgs?: Hex
  readonly signature?: Hex
}

/**
 * Byte-exact port of `TakerTraitsLib.build`: a 22-byte header (ten uint16 slice end-offsets, index9 first, then
 * uint16 flags) followed by the packed slices. Hook and callback slices are always empty for Bucket fills.
 */
export function buildTakerTraits(args: TakerTraitsArgs): Hex {
  const threshold: Hex = args.threshold === null ? '0x' : numberToHex(args.threshold, { size: 32 })
  const to = args.to !== undefined && !isAddressEqual(args.to, zeroAddress) && !isAddressEqual(args.to, args.taker)
    ? getAddress(args.to)
    : null
  const deadline = args.deadline ?? 0
  const instructionsArgs = args.instructionsArgs ?? '0x'
  const signature = args.signature ?? '0x'

  const index0 = size(threshold)
  const index1 = index0 + (to ? 20 : 0)
  const index2 = index1 + (deadline !== 0 ? 5 : 0)
  // index3..index8: pre/post transfer hook data and callback data, all empty.
  const index8 = index2
  const index9 = index8 + size(instructionsArgs)
  const indexes = [index9, index8, index8, index8, index8, index8, index8, index2, index1, index0]
  for (const index of indexes) {
    if (index > 0xffff) throw new RangeError('taker data exceeds uint16 offsets')
  }

  let flags = 0
  if (args.isExactIn) flags |= TakerTraitFlag.IsExactIn
  if (args.isStrictThresholdAmount) flags |= TakerTraitFlag.IsStrictThresholdAmount
  if (args.isFirstTransferFromTaker) flags |= TakerTraitFlag.IsFirstTransferFromTaker
  if (args.useTransferFromAndAquaPush) flags |= TakerTraitFlag.UseTransferFromAndAquaPush
  if (args.isAToB) flags |= TakerTraitFlag.IsAToB
  if (args.allowPartialFill) flags |= TakerTraitFlag.AllowPartialFill

  return concat([
    ...indexes.map((index) => numberToHex(index, { size: 2 })),
    numberToHex(flags, { size: 2 }),
    threshold,
    to ?? '0x',
    deadline !== 0 ? numberToHex(deadline, { size: 5 }) : '0x',
    instructionsArgs,
    signature,
  ])
}
