# Deployment

## Environment

All secrets and endpoints come from `.env` (see `.env.example`); nothing is hardcoded. Required per step:

| Step | Command | Needs |
|---|---|---|
| Compile | `pnpm evm:build && pnpm abi` | Foundry |
| EVM | `pnpm deploy:evm` | `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (Sepolia ETH) |
| Sui | `pnpm deploy:sui` | `SUI_PRIVATE_KEY` (testnet SUI), Sui CLI ≥ 1.60 (`SUI_BIN`, or a fetched build at `.tools/sui.exe`) |
| ENSv2 | `pnpm configure:ens` | `OWNER_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY` (address only), Sepolia ETH on owner |
| Prices | `pnpm --filter @bucket/scripts configure:prices` | deployer or `PRICE_REPORTER_PRIVATE_KEY` |
| Demo | `pnpm demo` | all of the above; `SUI_OPERATOR_PRIVATE_KEY` optional |

Outputs:

- `contracts/evm/deployments/evm-<chainId>.json` (Foundry)
- `deployments/<EVM_NETWORK>.json` — full manifest, validated by `DeploymentSchema`
- `apps/web/public/deployment.json` — copy served to the web app

## What gets deployed

| Contract | Notes |
|---|---|
| `AquaRouter` | official source, unmodified (skipped when `AQUA_ADDRESS` is set) |
| `BucketSwapVMRouter` | the minimal Bucket instruction set only (`Deadline`, `Salt`, `0xd0`-`0xd2`); `WETH_ADDRESS` defaults to Sepolia WETH |
| `BucketReferencePriceFeed` | deployer is owner and initial reporter (`PRICE_REPORTER`) |
| `BucketAuthority` | constructed with the precomputed controller address; ENSv2 owner + guardian resolution |
| `BucketCapabilities` | constructed with the authority and the precomputed controller address; Financial Capability registry |
| `BucketController` | immutable references to Aqua, router, authority, capabilities, feed. Holds no funds — a Bucket's assets are its owner's own wallet balances |
| `tUSDC`, `tETH`, `tSUI` | test ERC-20s |
| `tPEPE` | test ERC-20, deliberately never added to any Bucket policy (unapproved-asset rejection demo) |

ENSv2 is **not** deployed; `configure:ens` uses the official Sepolia contracts:

1. `<ENS_OWNER_LABEL>.eth` via `ETHRegistrar` commit/reveal, paid with Sepolia `MockUSDC` (public mint)
2. `UserRegistry` proxies via the official `VerifiableFactory`, with `setSubregistry` + `setParent` so names are
   canonical and resolvable top-down
3. `trading`, `savings`, `payments` subnames (owner) and `agent.trading` (operator, no token roles)

## Local fork

```bash
anvil --fork-url "$SEPOLIA_RPC_URL" --chain-id 11155111
EVM_NETWORK=sepolia-fork pnpm deploy:evm
EVM_NETWORK=sepolia-fork pnpm configure:ens
EVM_NETWORK=sepolia-fork pnpm demo
```

Use freshly generated keys on the fork (fund them with `anvil_setBalance`). Anvil's well-known dev addresses carry
code on real Sepolia (EIP-7702 delegations), and ENSv2 names are ERC-1155 tokens, so registering to such an address
reverts with `ERC1155InvalidReceiver`. The same applies to any owner or operator account that delegates to a
contract without an ERC-1155 receiver.

The manifest is written to `deployments/sepolia-fork.json` and the UI shows a `LOCAL FORK · Sepolia` badge. Only
the ENSv2 commit/reveal delay is time-travelled; all contracts are the real forked deployments. Sui has no fork mode:
use `SUI_NETWORK=testnet` (or `localnet` with `sui start --with-faucet`).

## Web app

```bash
cp apps/web/.env.example apps/web/.env    # VITE_EVM_RPC_URL (read-only), VITE_SUI_GRPC_URL
pnpm web
```

Connect an EVM wallet on Sepolia; an account holding a live `PERM_REBALANCE` capability for a Bucket can execute
rebalances against it (checked live by `BucketCapabilities`, not by the frontend). Sui-native Buckets are shown
read-only in this pass — see `docs/SECURITY.md`'s "Known limitations".
