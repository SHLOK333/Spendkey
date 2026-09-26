// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025.

import type { SwapVmOrder } from '@bucket/protocol-types'
import { getAddress, hexToNumber, isAddressEqual, size, slice, type Address, type Hex } from 'viem'

import { compileBucketProgram, type BucketProgramParams } from '../compiler'
import { decodeInstructionArgs, type Instruction } from '../instructions'

export class ProgramDecodingError extends Error {
  override name = 'ProgramDecodingError'
}

/** Decodes SwapVM bytecode into instructions. Mirrors `ContextLib.runLoop` bounds checks. */
export function decodeProgram(program: Hex): Instruction[] {
  const length = size(program)
  const instructions: Instruction[] = []
  let pc = 0
  while (pc < length) {
    if (pc + 2 > length) throw new ProgramDecodingError(`truncated header at pc=${pc}`)
    const opcode = hexToNumber(slice(program, pc, pc + 1))
    const argsLength = hexToNumber(slice(program, pc + 1, pc + 2))
    const end = pc + 2 + argsLength
    if (end > length) throw new ProgramDecodingError(`args overflow program at pc=${pc}`)
    const args: Hex = argsLength === 0 ? '0x' : slice(program, pc + 2, end)
    instructions.push(decodeInstructionArgs(opcode, args))
    pc = end
  }
  return instructions
}

/** Maker trait flags (SwapVM `MakerTraitsLib`). */
export const MakerTraitFlag = {
  ShouldUnwrapWeth: 1n << 255n,
  UseAquaInsteadOfSignature: 1n << 254n,
  AllowZeroAmountIn: 1n << 253n,
  HasPreTransferInHook: 1n << 252n,
  HasPostTransferInHook: 1n << 251n,
  HasPreTransferOutHook: 1n << 250n,
  HasPostTransferOutHook: 1n << 249n,
  PreTransferInHookHasTarget: 1n << 248n,
  PostTransferInHookHasTarget: 1n << 247n,
  PreTransferOutHookHasTarget: 1n << 246n,
  PostTransferOutHookHasTarget: 1n << 245n,
} as const

const SLICE_INDEXES_OFFSET = 160n
const U16_MASK = 0xffffn
const ADDRESS_MASK = (1n << 160n) - 1n

export interface DecodedOrder {
  readonly maker: Address
  readonly receiver: Address
  readonly tokenA: Address
  readonly tokenB: Address
  readonly useAqua: boolean
  readonly preTransferOutHook: Address | null
  readonly postTransferInHook: Address | null
  readonly program: Hex
  readonly instructions: Instruction[]
}

function hasFlag(traits: bigint, flag: bigint): boolean {
  return (traits & flag) !== 0n
}

function sliceOffset(traits: bigint, index: number): number {
  return Number((traits >> SLICE_INDEXES_OFFSET >> BigInt(index * 16)) & U16_MASK)
}

function hookTarget(
  order: SwapVmOrder,
  start: number,
  end: number,
  enabled: bigint,
  targetFlag: bigint,
): Address | null {
  if (!hasFlag(order.traits, enabled)) return null
  if (!hasFlag(order.traits, targetFlag)) return getAddress(order.maker)
  if (end - start < 20) throw new ProgramDecodingError('hook target missing')
  return getAddress(slice(order.data, start, start + 20))
}

/** Decodes a SwapVM order's data slices (`MakerTraitsLib` layout). */
export function decodeOrder(order: SwapVmOrder): DecodedOrder {
  const dataLength = size(order.data)
  if (dataLength < 40) throw new ProgramDecodingError('order data shorter than token pair')
  const o0 = sliceOffset(order.traits, 0)
  const o1 = sliceOffset(order.traits, 1)
  const o2 = sliceOffset(order.traits, 2)
  const o3 = sliceOffset(order.traits, 3)
  if (!(40 <= o0 && o0 <= o1 && o1 <= o2 && o2 <= o3 && o3 <= dataLength)) {
    throw new ProgramDecodingError('inconsistent order data slice offsets')
  }
  const receiverBits = order.traits & ADDRESS_MASK
  const program: Hex = o3 === dataLength ? '0x' : slice(order.data, o3, dataLength)

  return {
    maker: getAddress(order.maker),
    receiver: receiverBits === 0n ? getAddress(order.maker) : getAddress(`0x${receiverBits.toString(16).padStart(40, '0')}`),
    tokenA: getAddress(slice(order.data, 0, 20)),
    tokenB: getAddress(slice(order.data, 20, 40)),
    useAqua: hasFlag(order.traits, MakerTraitFlag.UseAquaInsteadOfSignature),
    preTransferOutHook: hookTarget(
      order,
      o1,
      o2,
      MakerTraitFlag.HasPreTransferOutHook,
      MakerTraitFlag.PreTransferOutHookHasTarget,
    ),
    postTransferInHook: hookTarget(
      order,
      o0,
      o1,
      MakerTraitFlag.HasPostTransferInHook,
      MakerTraitFlag.PostTransferInHookHasTarget,
    ),
    program,
    instructions: decodeProgram(program),
  }
}

export class BucketOrderVerificationError extends Error {
  override name = 'BucketOrderVerificationError'
}

/**
 * Verifies that an order announced by the controller is exactly the canonical Bucket program for the intent,
 * settled through Aqua, with both verification hooks pointing at the controller. Takers must never fill an order
 * they have not verified.
 */
export function verifyBucketOrder(
  order: SwapVmOrder,
  expected: BucketProgramParams & { readonly holder: Address },
): DecodedOrder {
  const decoded = decodeOrder(order)
  const fail = (reason: string): never => {
    throw new BucketOrderVerificationError(reason)
  }
  if (!isAddressEqual(decoded.maker, expected.holder)) fail('maker is not the Bucket holder')
  if (!decoded.useAqua) fail('order is not Aqua-settled')
  if (!isAddressEqual(decoded.receiver, expected.holder)) fail('custom receiver is not allowed')
  if (decoded.preTransferOutHook === null || !isAddressEqual(decoded.preTransferOutHook, expected.controller)) {
    fail('preTransferOut hook is not the controller')
  }
  if (decoded.postTransferInHook === null || !isAddressEqual(decoded.postTransferInHook, expected.controller)) {
    fail('postTransferIn hook is not the controller')
  }
  if (decoded.program.toLowerCase() !== compileBucketProgram(expected).toLowerCase()) {
    fail('program differs from the canonical Bucket program')
  }
  return decoded
}
