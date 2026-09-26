
import { randomBytes } from 'node:crypto'

function optional(name: string): string | null {
  const v = process.env[name]?.trim()
  return v ? v : null
}

function required(name: string): string {
  const v = optional(name)
  if (!v) throw new Error(`${name} is not set in the repository .env`)
  return v
}

// A per-process fallback keeps BYOK cookies unreadable without configuration; they simply stop decrypting after a
// restart when AGENT_COOKIE_SECRET is unset.
const ephemeralCookieSecret = randomBytes(32).toString('hex')

export const serverEnv = {
  sepoliaRpcUrl: () => required('SEPOLIA_RPC_URL'),
  suiGrpcUrl: () => optional('SUI_GRPC_URL'),
  /** Agent operator on EVM: the account behind the capability's ENSv2 operator name. Never sent to the browser. */
  evmAgentKey: () => optional('OPERATOR_PRIVATE_KEY'),
  /** Deployer/faucet key: seeds a brand-new owner wallet with gas + test tokens for onboarding. Never exposed. */
  deployerKey: () => optional('DEPLOYER_PRIVATE_KEY'),
  /** ENSv2 label of the agent operator name registered under each Bucket (e.g. `agent` in agent.trading.you.eth). */
  ensOperatorLabel: () => optional('ENS_OPERATOR_LABEL') ?? 'agent',
  /** Years a new `.eth` name is registered for during onboarding. */
  ensRegistrationYears: () => Number(optional('ENS_REGISTRATION_YEARS') ?? '1'),
  /** Agent operator on Sui (holder of the OperatorCap). Never sent to the browser. */
  suiAgentKey: () => optional('SUI_OPERATOR_PRIVATE_KEY'),
  openaiKey: () => optional('OPENAI_API_KEY'),
  openaiModel: () => optional('OPENAI_MODEL') ?? 'gpt-4o-mini',
  cookieSecret: () => optional('AGENT_COOKIE_SECRET') ?? ephemeralCookieSecret,
  logsBlockRange: () => BigInt(optional('EVM_LOGS_BLOCK_RANGE') ?? '10'),
}
