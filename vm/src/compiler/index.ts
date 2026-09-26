// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025.

import { Opcode } from '@bucket/protocol-types'
import { concat, type Address, type Hex } from 'viem'

import { encodeInstruction, type BucketProgramInstruction } from '../instructions'

export interface BucketProgramParams {
  readonly controller: Address
  readonly bucketId: Hex
  readonly strategyNonce: number
  readonly strategyExpiry: number
}

/**
 * The canonical Bucket program, byte-identical to `BucketEngine.program`:
 *
 *   Deadline(strategyExpiry)                         strategy generation's Aqua-level expiry    (SwapVM 0x20)
 *   Salt(strategyNonce)                               unique strategy hash per generation         (SwapVM 0x02)
 *   BucketCapabilityGuard(controller, bucketId)       identity, intent, capability chain, ENSv2    (Bucket 0xd0)
 *   BucketQuote(controller, bucketId)                 policy-bound price, direction, no overshoot  (Bucket 0xd1)
 *   BucketSpendLimit(controller, bucketId)            per-execution/hourly/daily/turnover/budget    (Bucket 0xd2)
 *   BucketWalletBalanceCheck(controller, bucketId)    holder ERC-20 balance ≥ amountOut (self-custodial) (Bucket 0xd3)
 */
export function bucketProgramInstructions(params: BucketProgramParams): BucketProgramInstruction[] {
  const args = { controller: params.controller, bucketId: params.bucketId }
  return [
    { opcode: Opcode.Deadline, deadline: params.strategyExpiry },
    { opcode: Opcode.Salt, salt: BigInt(params.strategyNonce) },
    { opcode: Opcode.BucketCapabilityGuard, ...args },
    { opcode: Opcode.BucketQuote, ...args },
    { opcode: Opcode.BucketSpendLimit, ...args },
    { opcode: Opcode.BucketWalletBalanceCheck, ...args },
  ]
}

export function compileProgram(instructions: readonly BucketProgramInstruction[]): Hex {
  return concat(instructions.map(encodeInstruction))
}

export function compileBucketProgram(params: BucketProgramParams): Hex {
  return compileProgram(bucketProgramInstructions(params))
}
