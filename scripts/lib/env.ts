import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config as loadDotenv } from 'dotenv'
import { isHex } from 'viem'
import { z } from 'zod'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const envFile = join(ROOT, '.env')
if (existsSync(envFile)) loadDotenv({ path: envFile, quiet: true })

const privateKey = z
  .string()
  .refine((value) => isHex(value) && value.length === 66, 'expected a 0x-prefixed 32-byte hex private key')
  .transform((value) => value as `0x${string}`)

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

const EnvSchema = z.object({
  EVM_NETWORK: z.enum(['sepolia', 'sepolia-fork']).default('sepolia'),
  SEPOLIA_RPC_URL: optional(z.string().url()),
  LOCAL_FORK_RPC_URL: z.string().url().default('http://127.0.0.1:8545'),
  DEPLOYER_PRIVATE_KEY: optional(privateKey),
  OWNER_PRIVATE_KEY: optional(privateKey),
  OPERATOR_PRIVATE_KEY: optional(privateKey),
  PRICE_REPORTER_PRIVATE_KEY: optional(privateKey),
  ETHERSCAN_API_KEY: optional(z.string()),

  ENS_OWNER_LABEL: z.string().regex(/^[a-z0-9-]{3,}$/).default('shlok'),
  ENS_OPERATOR_LABEL: z.string().regex(/^[a-z0-9-]+$/).default('agent'),
  ENS_REGISTRATION_YEARS: z.coerce.number().int().min(1).max(5).default(1),

  PRICE_USDC: z.string().default('1'),
  PRICE_ETH: z.string().default('2500'),
  PRICE_SUI: z.string().default('3.5'),
  PRICE_PEPE: z.string().default('0.001'),

  DEMO_FUNDING_USD: z.string().default('2000'),
})

export type Env = z.infer<typeof EnvSchema>

export const env: Env = EnvSchema.parse(process.env)

export class MissingConfigurationError extends Error {
  override name = 'MissingConfigurationError'
}

/** Returns a required configuration value or fails with the exact variable to set. */
export function required<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env[key]
  if (value === undefined || value === null || value === '') {
    throw new MissingConfigurationError(`${String(key)} is not set. Add it to .env (see .env.example).`)
  }
  return value as NonNullable<Env[K]>
}

export function evmRpcUrl(): string {
  return env.EVM_NETWORK === 'sepolia-fork' ? env.LOCAL_FORK_RPC_URL : required('SEPOLIA_RPC_URL')
}
