// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025.

import { Opcode } from '@bucket/protocol-types'
import { concat, getAddress, numberToHex, size, slice, type Address, type Hex } from 'viem'

/**
 * SwapVM instruction wire format: `[opcode: 1 byte][argsLength: 1 byte][args: argsLength bytes]`.
 * Opcode numbers follow the fixed SwapVM `OpcodeList` (swap-vm `main`) extended with the Bucket bank at 0xd0-0xd3.
 *
 * The four Bucket instructions share one 52-byte argument layout: `[address controller][bytes32 bucketId]`.
 * They differ only in what the controller is asked for (see `BucketInstructionArgs.sol`).
 */

export interface SaltInstruction {
  readonly opcode: typeof Opcode.Salt
  readonly salt: bigint
}

export interface DeadlineInstruction {
  readonly opcode: typeof Opcode.Deadline
  readonly deadline: number
}

export interface BucketInstructionArgs {
  readonly controller: Address
  readonly bucketId: Hex
}

export interface BucketCapabilityGuardInstruction extends BucketInstructionArgs {
  readonly opcode: typeof Opcode.BucketCapabilityGuard
}

export interface BucketQuoteInstruction extends BucketInstructionArgs {
  readonly opcode: typeof Opcode.BucketQuote
}

export interface BucketSpendLimitInstruction extends BucketInstructionArgs {
  readonly opcode: typeof Opcode.BucketSpendLimit
}

export interface BucketWalletBalanceCheckInstruction extends BucketInstructionArgs {
  readonly opcode: typeof Opcode.BucketWalletBalanceCheck
}

export interface UnknownInstruction {
  readonly opcode: number
  readonly args: Hex
}

export type BucketOpcodeInstruction =
  | BucketCapabilityGuardInstruction
  | BucketQuoteInstruction
  | BucketSpendLimitInstruction
  | BucketWalletBalanceCheckInstruction

export type BucketProgramInstruction = SaltInstruction | DeadlineInstruction | BucketOpcodeInstruction

export type Instruction = BucketProgramInstruction | UnknownInstruction

export const BUCKET_ARGS_LENGTH = 20 + 32
const U40 = 2 ** 40 - 1
const U64 = (1n << 64n) - 1n

export class InstructionEncodingError extends Error {
  override name = 'InstructionEncodingError'
}

function header(opcode: number, args: Hex): Hex {
  const length = size(args)
  if (length > 255) throw new InstructionEncodingError(`args of opcode 0x${opcode.toString(16)} exceed 255 bytes`)
  return concat([numberToHex(opcode, { size: 1 }), numberToHex(length, { size: 1 }), args])
}

export function encodeSalt(salt: bigint): Hex {
  if (salt < 0n || salt > U64) throw new InstructionEncodingError(`salt ${salt} is not a uint64`)
  return header(Opcode.Salt, numberToHex(salt, { size: 8 }))
}

export function encodeDeadline(deadline: number): Hex {
  if (!Number.isInteger(deadline) || deadline < 0 || deadline > U40) {
    throw new InstructionEncodingError(`deadline ${deadline} is not a uint40`)
  }
  return header(Opcode.Deadline, numberToHex(deadline, { size: 5 }))
}

function encodeBucketArgs(opcode: number, args: BucketInstructionArgs): Hex {
  if (size(args.bucketId) !== 32) throw new InstructionEncodingError('bucketId must be 32 bytes')
  return header(opcode, concat([getAddress(args.controller), args.bucketId]))
}

export function encodeBucketCapabilityGuard(args: BucketInstructionArgs): Hex {
  return encodeBucketArgs(Opcode.BucketCapabilityGuard, args)
}

export function encodeBucketQuote(args: BucketInstructionArgs): Hex {
  return encodeBucketArgs(Opcode.BucketQuote, args)
}

export function encodeBucketSpendLimit(args: BucketInstructionArgs): Hex {
  return encodeBucketArgs(Opcode.BucketSpendLimit, args)
}

export function encodeBucketWalletBalanceCheck(args: BucketInstructionArgs): Hex {
  return encodeBucketArgs(Opcode.BucketWalletBalanceCheck, args)
}

export function encodeInstruction(ix: BucketProgramInstruction): Hex {
  switch (ix.opcode) {
    case Opcode.Salt:
      return encodeSalt(ix.salt)
    case Opcode.Deadline:
      return encodeDeadline(ix.deadline)
    case Opcode.BucketCapabilityGuard:
      return encodeBucketCapabilityGuard(ix)
    case Opcode.BucketQuote:
      return encodeBucketQuote(ix)
    case Opcode.BucketSpendLimit:
      return encodeBucketSpendLimit(ix)
    case Opcode.BucketWalletBalanceCheck:
      return encodeBucketWalletBalanceCheck(ix)
  }
}

export function decodeInstructionArgs(opcode: number, args: Hex): Instruction {
  const length = size(args)
  switch (opcode) {
    case Opcode.Salt:
      if (length === 8) return { opcode, salt: BigInt(args) }
      break
    case Opcode.Deadline:
      if (length === 5) return { opcode, deadline: Number(BigInt(args)) }
      break
    case Opcode.BucketCapabilityGuard:
    case Opcode.BucketQuote:
    case Opcode.BucketSpendLimit:
    case Opcode.BucketWalletBalanceCheck:
      if (length === BUCKET_ARGS_LENGTH) {
        return {
          opcode,
          controller: getAddress(slice(args, 0, 20)),
          bucketId: slice(args, 20, 52),
        } as BucketOpcodeInstruction
      }
      throw new InstructionEncodingError(`Bucket instruction args must be ${BUCKET_ARGS_LENGTH} bytes`)
  }
  return { opcode, args }
}

export function isBucketOpcode(ix: Instruction): ix is BucketOpcodeInstruction {
  return (
    (ix.opcode === Opcode.BucketCapabilityGuard ||
      ix.opcode === Opcode.BucketQuote ||
      ix.opcode === Opcode.BucketSpendLimit ||
      ix.opcode === Opcode.BucketWalletBalanceCheck) &&
    'controller' in ix
  )
}
