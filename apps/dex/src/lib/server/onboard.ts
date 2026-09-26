
import { ENSV2_SEPOLIA, mintableErc20Abi } from '@bucket/sdk'
import { usd } from '@bucket/protocol-types'
import { amountOf } from '@bucket/vm'
import { createWalletClient, formatEther, http, isAddressEqual, parseEther, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import { loadDeployment } from './deployment'
import { serverEnv } from './env'

/**
 * New-owner onboarding faucet (deployer key). A brand-new MetaMask wallet has no Sepolia ETH and no test
 * tokens, so it cannot sign a single transaction of the ENSv2 + Bucket setup. The deployer therefore seeds it
 * with gas, the MockUSDC the `.eth` registrar charges, and an out-of-policy trading allocation — and tops up
 * the shared agent operator so it can act as the Aqua taker on the new Bucket's first rebalance.
 *
 * This is a testnet-only convenience: every token here is a public-mint mock with no value.
 */

const GAS_TOP_UP = parseEther('0.05')
const GAS_MIN = parseEther('0.03')
const FUNDING_USD = usd('1000')
/** USDC-heavy start so the new Bucket opens out of policy and there is a real rebalance to run. */
const INITIAL_BPS: Record<string, bigint> = { USDC: 7000n, ETH: 2000n, SUI: 1000n }
/** Test-token float for the operator so it can supply tokenIn (ETH/SUI) on the first fills. */
const OPERATOR_TOKENS: Record<string, bigint> = { ETH: 2n * 10n ** 18n, SUI: 500n * 10n ** 9n }

function deployerWallet() {
  const key = serverEnv.deployerKey()
  if (!key) throw new Error('DEPLOYER_PRIVATE_KEY is not set in the repository .env')
  return createWalletClient({ account: privateKeyToAccount(key as Hex), chain: sepolia, transport: http(serverEnv.sepoliaRpcUrl()) })
}

/** Public onboarding config: the agent operator identity a new owner grants their trading capability to. */
export function onboardConfig(): { operator: Address | null; operatorLabel: string; registrationYears: number } {
  const key = serverEnv.evmAgentKey()
  const operator = key ? privateKeyToAccount(key as Hex).address : null
  return {
    operator,
    operatorLabel: serverEnv.ensOperatorLabel(),
    registrationYears: serverEnv.ensRegistrationYears(),
  }
}

export interface FaucetResult {
  readonly funded: Array<{ what: string; txHash: Hash }>
  readonly operator: Address | null
  readonly operatorLabel: string
  readonly registrationYears: number
}
type Hash = Hex

/** Seed a new owner wallet (and top up the operator) so the client-side onboarding can run end to end. */
export async function onboardFaucet(recipient: Address): Promise<FaucetResult> {
  const { publicClient, bucket } = await import('./evm').then((m) => m.evmServer())
  const deployment = loadDeployment()
  const deployer = deployerWallet()
  const funded: Array<{ what: string; txHash: Hash }> = []

  async function mint(token: Address, to: Address, amount: bigint, what: string) {
    const { request } = await publicClient.simulateContract({ address: token, abi: mintableErc20Abi, functionName: 'mint', args: [to, amount], account: deployer.account })
    const hash = await deployer.writeContract(request as Parameters<typeof deployer.writeContract>[0])
    await publicClient.waitForTransactionReceipt({ hash })
    funded.push({ what, txHash: hash })
  }

  // 1 — Sepolia gas for the new owner (they sign ~19 transactions).
  const gas = await publicClient.getBalance({ address: recipient })
  if (gas < GAS_MIN) {
    const hash = await deployer.sendTransaction({ to: recipient, value: GAS_TOP_UP })
    await publicClient.waitForTransactionReceipt({ hash })
    funded.push({ what: `gas ${formatEther(GAS_TOP_UP)} ETH`, txHash: hash })
  }

  // 2 — MockUSDC for the `.eth` registrar (a generous buffer covers any short-name price).
  await mint(ENSV2_SEPOLIA.mockUsdc as Address, recipient, 10n ** 24n, 'MockUSDC (name registration)')

  // 3 — An out-of-policy USDC/ETH/SUI allocation, priced by the protocol feed exactly like the demo.
  for (const symbol of ['USDC', 'ETH', 'SUI'] as const) {
    const t = deployment.evm.tokens.find((x) => x.symbol === symbol)
    if (!t) continue
    const { priceWad } = await bucket.evm.price(t.address).catch(() => ({ priceWad: 0n }))
    if (priceWad === 0n) continue
    const valueWad = (FUNDING_USD * (INITIAL_BPS[symbol] ?? 0n)) / 10_000n
    const amount = amountOf(valueWad, t.decimals, priceWad, 'floor')
    if (amount > 0n) await mint(t.address, recipient, amount, `${symbol} (starting balance)`)
  }

  // 4 — Top up the shared agent operator so it can supply tokenIn on the new Bucket's first fills.
  const cfg = onboardConfig()
  if (cfg.operator && !isAddressEqual(cfg.operator, recipient)) {
    const opGas = await publicClient.getBalance({ address: cfg.operator })
    if (opGas < GAS_MIN) {
      const hash = await deployer.sendTransaction({ to: cfg.operator, value: GAS_TOP_UP })
      await publicClient.waitForTransactionReceipt({ hash })
      funded.push({ what: 'operator gas', txHash: hash })
    }
    for (const symbol of ['ETH', 'SUI'] as const) {
      const t = deployment.evm.tokens.find((x) => x.symbol === symbol)
      if (!t) continue
      const bal = await publicClient.readContract({ address: t.address, abi: mintableErc20Abi, functionName: 'balanceOf', args: [cfg.operator] })
      if (bal < (OPERATOR_TOKENS[symbol] ?? 0n)) await mint(t.address, cfg.operator, OPERATOR_TOKENS[symbol] ?? 0n, `operator ${symbol}`)
    }
  }

  return { funded, ...cfg }
}
