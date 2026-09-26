import {
  ENSV2_SEPOLIA,
  SUBNAME_OWNER_ROLES,
  USER_REGISTRY_OWNER_ROLES,
  ethRegistrarAbi,
  mintableErc20Abi,
  userRegistryAbi,
  verifiableFactoryAbi,
  type BucketClient,
  type EvmWallet,
} from '@bucket/sdk'
import { labelId, permissionMask, usd, type CapabilityGrant, type Deployment, type PolicyParams } from '@bucket/protocol-types'
import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  maxUint256,
  parseEventLogs,
  stringToBytes,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

// The onboarding replays, from a brand-new MetaMask wallet, the exact ENSv2 + Bucket sequence proven in
// scripts/configure/ens.ts and scripts/demo/run.ts — so the new owner ends up owning their own `<label>.eth`,
// their own UserRegistry hierarchy, and their own trading Bucket, with the shared agent operator authorized.
// Every transaction is signed by the owner; nothing here holds a key. Limits are enforced on-chain.

const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n
const CAPABILITY_DURATION_SECONDS = 24 * 3_600
const REBALANCE_LIMITS = { maxExecutionValue: usd('490'), maxHourlyValue: usd('1500'), maxDailyValue: usd('2000'), maxSlippageBps: 50, maxDailyTurnoverBps: 5_000, maxExecutions: 0 }

interface PolicyAsset {
  readonly token: Address
  readonly decimals: number
  readonly targetBps: number
  readonly minBps: number
  readonly maxBps: number
}

/** Same trading policy the demo uses: USDC 50/30–70, ETH 30/15–45, SUI 20/10–30. */
function tradingPolicy(deployment: Deployment): { params: PolicyParams; assets: PolicyAsset[] } {
  const asset = (symbol: string, targetBps: number, minBps: number, maxBps: number): PolicyAsset => {
    const d = deployment.evm.tokens.find((x) => x.symbol === symbol)
    if (!d) throw new Error(`token ${symbol} is missing from the deployment`)
    return { token: d.address, decimals: d.decimals, targetBps, minBps, maxBps }
  }
  return {
    params: {
      rebalanceThresholdBps: 500,
      maxSlippageBps: 100,
      maxPriceAge: 3_600,
      auctionDuration: 300,
      venueMask: 1,
      maxDailyTurnoverBps: 8_000,
      delegablePermissions: permissionMask(['Rebalance', 'Swap', 'Pay', 'Delegate']),
      maxExecutionValue: usd('1000'),
      maxHourlyValue: usd('3000'),
      maxDailyValue: usd('5000'),
    },
    assets: [asset('USDC', 5000, 3000, 7000), asset('ETH', 3000, 1500, 4500), asset('SUI', 2000, 1000, 3000)],
  }
}

export type StepKey = 'fund' | 'name' | 'registry' | 'bucketname' | 'operator' | 'bucket' | 'strategies' | 'capability'

export const ONBOARD_STEPS: Array<{ key: StepKey; label: string }> = [
  { key: 'fund', label: 'Fund the new wallet' },
  { key: 'name', label: 'Register your .eth name' },
  { key: 'registry', label: 'Deploy your name registry' },
  { key: 'bucketname', label: 'Create the trading name' },
  { key: 'operator', label: 'Register the agent operator' },
  { key: 'bucket', label: 'Create the trading Bucket' },
  { key: 'strategies', label: 'Approve & ship strategies' },
  { key: 'capability', label: 'Grant the agent capability' },
]

export type Progress =
  | { type: 'step'; key: StepKey; status: 'active' | 'done'; detail?: string }
  | { type: 'tx'; key: StepKey; label: string; hash: Hex }
  | { type: 'wait'; key: StepKey; secondsLeft: number }

export interface OnboardContext {
  readonly wallet: EvmWallet
  readonly publicClient: PublicClient
  readonly bucket: BucketClient
  readonly deployment: Deployment
  readonly label: string
}

export interface OnboardResult {
  readonly ownerName: string
  readonly ownerRegistry: Address
  readonly bucketId: Hex
  readonly capabilityId: Hex
}

interface FaucetResponse {
  readonly operator: Address | null
  readonly operatorLabel: string
  readonly registrationYears: number
  readonly funded?: Array<{ what: string; txHash: Hex }>
  readonly error?: string
}

/** Runs the full new-owner onboarding, emitting progress. Re-runnable: completed on-chain state is detected and skipped. */
export async function runOnboarding(ctx: OnboardContext, emit: (p: Progress) => void): Promise<OnboardResult> {
  const { wallet, publicClient, bucket, deployment, label } = ctx
  const owner = wallet.account.address
  const ethRegistry = ENSV2_SEPOLIA.ethRegistry as Address
  const ethRegistrar = ENSV2_SEPOLIA.ethRegistrar as Address
  const mockUsdc = ENSV2_SEPOLIA.mockUsdc as Address

  // A minimal simulate -> sign -> wait, mirroring configure/ens.ts `send`, but signed by the connected wallet.
  const send = async (key: StepKey, txLabel: string, call: Parameters<PublicClient['simulateContract']>[0]): Promise<Hex> => {
    const { request } = await publicClient.simulateContract({ ...call, account: wallet.account })
    const hash = await wallet.writeContract(request as Parameters<EvmWallet['writeContract']>[0])
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${txLabel} reverted (${hash})`)
    emit({ type: 'tx', key, label: txLabel, hash })
    return hash
  }

  // ---- fund ---------------------------------------------------------------------------------------------------
  emit({ type: 'step', key: 'fund', status: 'active', detail: 'Seeding gas and test tokens…' })
  const res = await fetch('/api/onboard/faucet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: owner }) })
  const faucet = (await res.json()) as FaucetResponse
  if (faucet.error) throw new Error(faucet.error)
  if (!faucet.operator) throw new Error('No agent operator is configured on the server')
  for (const f of faucet.funded ?? []) emit({ type: 'tx', key: 'fund', label: f.what, hash: f.txHash })
  const operatorAddress = faucet.operator
  const operatorLabel = faucet.operatorLabel
  const duration = BigInt(faucet.registrationYears) * SECONDS_PER_YEAR
  emit({ type: 'step', key: 'fund', status: 'done', detail: 'Wallet funded' })

  // ---- name: register <label>.eth via commit/reveal -----------------------------------------------------------
  emit({ type: 'step', key: 'name', status: 'active' })
  const nameOwner = await publicClient.readContract({ address: ethRegistry, abi: userRegistryAbi, functionName: 'getOwner', args: [labelId(label)] })
  if (isAddressEqual(nameOwner, zeroAddress)) {
    const [base, premium] = await publicClient.readContract({ address: ethRegistrar, abi: ethRegistrarAbi, functionName: 'getRegisterPrice', args: [label, duration, mockUsdc] })
    const price = base + premium
    await send('name', 'approve MockUSDC', { address: mockUsdc, abi: mintableErc20Abi, functionName: 'approve', args: [ethRegistrar, price] })

    const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const commitment = await publicClient.readContract({ address: ethRegistrar, abi: ethRegistrarAbi, functionName: 'makeCommitment', args: [label, owner, secret, zeroAddress, zeroAddress, duration, zeroHash] })
    await send('name', 'commit', { address: ethRegistrar, abi: ethRegistrarAbi, functionName: 'commit', args: [commitment] })

    const [committedAt, minAge] = await Promise.all([
      publicClient.readContract({ address: ethRegistrar, abi: ethRegistrarAbi, functionName: 'commitmentAt', args: [commitment] }),
      publicClient.readContract({ address: ethRegistrar, abi: ethRegistrarAbi, functionName: 'MIN_COMMITMENT_AGE' }),
    ])
    const readyAt = committedAt + minAge + 1n
    for (;;) {
      const block = await publicClient.getBlock({ blockTag: 'latest' })
      const left = Number(readyAt - block.timestamp)
      if (left <= 0) break
      emit({ type: 'wait', key: 'name', secondsLeft: left })
      await new Promise((r) => setTimeout(r, Math.min(left * 1_000 + 1_500, 5_000)))
    }
    await send('name', `register ${label}.eth`, {
      address: ethRegistrar,
      abi: ethRegistrarAbi,
      functionName: 'register',
      args: [label, owner, secret, zeroAddress, zeroAddress, duration, mockUsdc, zeroHash],
    })
  } else if (!isAddressEqual(nameOwner, owner)) {
    throw new Error(`${label}.eth is already owned by ${nameOwner}. Pick a different name.`)
  }
  const expiry = await publicClient.readContract({ address: ethRegistry, abi: userRegistryAbi, functionName: 'getExpiry', args: [labelId(label)] })
  emit({ type: 'step', key: 'name', status: 'done', detail: `${label}.eth is yours` })

  // ---- ENS helpers (owner-signed, idempotent) -----------------------------------------------------------------
  const deployRegistry = async (key: StepKey, purpose: string): Promise<Address> => {
    const salt = BigInt(keccak256(stringToBytes(`bucket:${owner}:${purpose}`)))
    const hash = await send(key, `deploy registry (${purpose})`, {
      address: ENSV2_SEPOLIA.verifiableFactory as Address,
      abi: verifiableFactoryAbi,
      functionName: 'deployProxy',
      args: [ENSV2_SEPOLIA.userRegistryImpl as Address, salt, encodeFunctionData({ abi: userRegistryAbi, functionName: 'initialize', args: [owner, USER_REGISTRY_OWNER_ROLES] })],
    })
    const receipt = await publicClient.getTransactionReceipt({ hash })
    const [deployed] = parseEventLogs({ abi: verifiableFactoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs })
    if (!deployed) throw new Error('registry deployment did not emit ProxyDeployed')
    return deployed.args.proxyAddress
  }
  const ensureSubregistry = async (key: StepKey, parent: Address, sublabel: string, purpose: string): Promise<Address> => {
    const existing = await publicClient.readContract({ address: parent, abi: userRegistryAbi, functionName: 'getSubregistry', args: [sublabel] })
    if (!isAddressEqual(existing, zeroAddress)) return existing
    const registry = await deployRegistry(key, purpose)
    await send(key, `link ${sublabel} subregistry`, { address: parent, abi: userRegistryAbi, functionName: 'setSubregistry', args: [labelId(sublabel), registry] })
    await send(key, `set ${sublabel} parent`, { address: registry, abi: userRegistryAbi, functionName: 'setParent', args: [parent, sublabel] })
    return registry
  }
  const ensureSubname = async (key: StepKey, registry: Address, sublabel: string, holder: Address, roles: bigint) => {
    const current = await publicClient.readContract({ address: registry, abi: userRegistryAbi, functionName: 'getOwner', args: [labelId(sublabel)] })
    if (isAddressEqual(current, holder)) return
    if (!isAddressEqual(current, zeroAddress)) throw new Error(`${sublabel} is already owned by ${current}`)
    await send(key, `register ${sublabel}`, { address: registry, abi: userRegistryAbi, functionName: 'register', args: [sublabel, holder, zeroAddress, zeroAddress, roles, expiry] })
  }

  // ---- registry: <label>.eth subregistry (owner-controlled) ---------------------------------------------------
  emit({ type: 'step', key: 'registry', status: 'active' })
  const ownerRegistry = await ensureSubregistry('registry', ethRegistry, label, `${label}.eth`)
  emit({ type: 'step', key: 'registry', status: 'done', detail: 'Name registry live' })

  // ---- bucketname: trading.<label>.eth (owned by the owner) ---------------------------------------------------
  emit({ type: 'step', key: 'bucketname', status: 'active' })
  await ensureSubname('bucketname', ownerRegistry, 'trading', owner, SUBNAME_OWNER_ROLES)
  emit({ type: 'step', key: 'bucketname', status: 'done', detail: `trading.${label}.eth` })

  // ---- operator: agent.trading.<label>.eth (owned by the agent operator key) -----------------------------------
  emit({ type: 'step', key: 'operator', status: 'active' })
  const bucketRegistry = await ensureSubregistry('operator', ownerRegistry, 'trading', `trading.${label}.eth`)
  await ensureSubname('operator', bucketRegistry, operatorLabel, operatorAddress, 0n)
  emit({ type: 'step', key: 'operator', status: 'done', detail: `${operatorLabel}.trading.${label}.eth` })

  // ---- bucket: create the trading Bucket over the owner's own wallet -------------------------------------------
  emit({ type: 'step', key: 'bucket', status: 'active' })
  const { params, assets } = tradingPolicy(deployment)
  const strategyExpiry = Math.floor(Date.now() / 1_000) + 365 * 24 * 3_600
  let bucketId = await bucket.evm.computeBucketId(ownerRegistry, labelId('trading'))
  const existing = await bucket.evm.getBucket(bucketId).catch(() => null)
  if (!existing || isAddressEqual(existing.holder, zeroAddress)) {
    const created = await bucket.createBucket({ wallet, registry: ownerRegistry, label: 'trading', strategyExpiry, params, assets })
    bucketId = created.bucketId
    emit({ type: 'tx', key: 'bucket', label: 'create Bucket', hash: created.evmTx })
  }
  emit({ type: 'step', key: 'bucket', status: 'done', detail: 'Bucket created' })

  // ---- strategies: approvals + Aqua strategy per pair ---------------------------------------------------------
  emit({ type: 'step', key: 'strategies', status: 'active' })
  const aqua = bucket.evm.contracts.aqua
  for (const a of assets) {
    const allowance = await publicClient.readContract({ address: a.token, abi: mintableErc20Abi, functionName: 'allowance', args: [owner, aqua] })
    if (allowance < maxUint256 / 2n) await send('strategies', 'approve Aqua', { address: a.token, abi: mintableErc20Abi, functionName: 'approve', args: [aqua, maxUint256] })
  }
  const orderAbiType = { type: 'tuple', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] } as const
  const pairs: Array<[Address, Address]> = [
    [assets[0]!.token, assets[1]!.token],
    [assets[0]!.token, assets[2]!.token],
    [assets[1]!.token, assets[2]!.token],
  ]
  for (const [tokenX, tokenY] of pairs) {
    const { order, orderHash } = await bucket.evm.strategyOrder(bucketId, tokenX, tokenY)
    const { tokensCount } = await bucket.evm.aquaBalance(owner, orderHash, tokenX)
    if (tokensCount === 0) {
      const strategyBytes = encodeAbiParameters([orderAbiType], [[order.maker, order.traits, order.data]])
      const hash = await bucket.evm.shipAqua(wallet, strategyBytes, [tokenX, tokenY], [10n ** 30n, 10n ** 30n])
      emit({ type: 'tx', key: 'strategies', label: 'ship Aqua strategy', hash })
    }
  }
  emit({ type: 'step', key: 'strategies', status: 'done', detail: 'Strategies shipped' })

  // ---- capability: grant the agent REBALANCE + SWAP -----------------------------------------------------------
  emit({ type: 'step', key: 'capability', status: 'active' })
  const now = Math.floor(Date.now() / 1_000)
  const grant: CapabilityGrant = {
    operatorLabel,
    permissions: permissionMask(['Rebalance', 'Swap']),
    assetMask: 0b111,
    venueMask: 1,
    validAfter: now - 60,
    validUntil: now + CAPABILITY_DURATION_SECONDS,
    payee: zeroAddress,
    limits: REBALANCE_LIMITS,
  }
  const issued = await bucket.evm.issueCapability(wallet, bucketId, grant)
  emit({ type: 'tx', key: 'capability', label: 'issue capability', hash: issued.hash })
  emit({ type: 'step', key: 'capability', status: 'done', detail: 'Agent authorized' })

  return { ownerName: `${label}.eth`, ownerRegistry, bucketId, capabilityId: issued.value.capabilityId }
}
