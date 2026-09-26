import { parseAbi } from 'viem'

/**
 * ENSv2 contract fragments not covered by the vendored `IPermissionedRegistry` interface.
 * Signatures are taken from ensdomains/contracts-v2 (Sepolia 2026-09-15 redeploy; interface unchanged from the
 * earlier `sepolia-deployment-2026-06-29` set — only the addresses and payment token moved).
 */

export const ethRegistrarAbi = parseAbi([
  'function MIN_COMMITMENT_AGE() view returns (uint64)',
  'function MAX_COMMITMENT_AGE() view returns (uint64)',
  'function MIN_REGISTER_DURATION() view returns (uint64)',
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)',
  'function commitmentAt(bytes32 commitment) view returns (uint64)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256 tokenId)',
])

export const verifiableFactoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)',
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)',
])

export const userRegistryAbi = parseAbi([
  // 2026-09-15 redeploy: initialize now takes an array of {account, roleBitmap} root grants
  // (was `initialize(address rootAccount, uint256 roleBitmap)`).
  'function initialize((address account, uint256 roleBitmap)[] grants)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256 tokenId)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setParent(address parent, string label)',
  'function getParent() view returns (address parent, string label)',
  'function getSubregistry(string label) view returns (address)',
  'function getOwner(uint256 anyId) view returns (address)',
  'function getExpiry(uint256 anyId) view returns (uint64)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool)',
])

export const mintableErc20Abi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])
