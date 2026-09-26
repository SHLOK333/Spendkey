# Implementation summary

> **Superseded.** This is a point-in-time log from an earlier implementation pass, before the custody model moved
> to the owner's own wallet and Financial Capabilities replaced ENSv2 role-based operator authority (see
> `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`). Kept for history; the specifics below (ENS roles, a
> per-Bucket vault account, single-opcode `BucketRebalance`) no longer match the current contracts.

BUCKET is built. The whole flow was run once, start to finish, on a **local fork of Sepolia** plus a **local Sui
network**. The trading Bucket started at USDC 70% / ETH 20% / SUI 10% and ended at **50.10% / 29.95% / 19.95%**
after two rebalances. Each rebalance stayed under the $500 execution limit, and each was recorded on Sui.

Nothing is deployed on live Sepolia or Sui testnet yet, because that needs your keys and RPC URL.

## How each track is used

- **ENSv2 (who)**
  - The Bucket's owner is whoever currently owns `trading.<name>.eth`.
  - The operator is `agent.trading.<name>.eth`, which holds scoped roles from ENSv2's Enhanced Access Control.
  - Authority is re-checked against the ENS registry on every call, so transferring or removing a name cancels the
    authority immediately.
  - The execution step (the new SwapVM opcode) also checks the operator's ENS permission.
- **Sui (what)**
  - A Move `Bucket` object holds the canonical policy, an explicit link to the EVM side, the positions and an
    execution log.
  - It re-checks every recorded rebalance itself: correct order, same policy, balances add up, and allocation
    improved.
- **Aqua + SwapVM (how)**
  - **New opcode:** `BucketRebalance` (`0xd0`) in a new "Buckets" opcode range, combined with the existing `Deadline`
    and `Salt` instructions. It prices trades at reference prices, with a price concession that can never exceed the
    policy's max slippage. It also enforces the execution limit, no overshooting the target, and the Aqua budget.
  - **Budget and settlement:** the Aqua virtual balance *is* the rebalance budget, and tokens stay in the Bucket's
    account until a trade executes.
  - **After-trade check:** two SwapVM maker hooks verify that exactly two balances changed, by exactly the traded
    amounts.
- **Identity mapping:** the EVM and Sui sides point at each other explicitly, and both store the same policy hash.
  Nothing assumes an EVM address equals a Sui address.

## Aqua on Sepolia

Aqua isn't officially deployed on Sepolia, but ENSv2 lives there. So the deploy script deploys Aqua's official,
unmodified source, and the SwapVM router is built from the swap-vm `main` branch plus the new opcode.

## Bugs caught by the end-to-end fork run (all fixed)

- **Contract size:** the controller was 1,130 bytes over the EVM size limit. Account creation was split into a
  separate `BucketAccountFactory`.
- **Foundry config:** the deploy script couldn't write its output file (duplicate `fs_permissions` entries).
- **Leftover order:** after a Bucket got back within policy, its last rebalance order stayed live. It now closes
  automatically during settlement.
- **Frontend:** a browser wallet extension crashed the page, then caused a render loop. The page now survives any
  wallet extension, and an error boundary contains render failures.

## Things to know

- **No tests were written**, as requested. The codebase is ready for the separate testing and audit pass.
- **Router size:** the SwapVM router is only 66 bytes under the contract size limit, so adding another opcode will
  need a split opcode set or a lower optimizer run count.
- **Prices:** asset prices come from a feed whose prices are posted by an authorized account, because the test tokens
  have no market. Any oracle implementing `IBucketPriceFeed` can replace it.
- **Test assets:** the USDC/ETH/SUI assets on the EVM side are clearly labelled test tokens (`tUSDC`, `tETH`, `tSUI`).
- **Sui CLI side effect:** the newer Sui CLI (downloaded to `.tools/`) created `~/.sui/sui_config/client.yaml` with a
  new, unfunded keypair on first run. Its recovery phrase appeared in tool output — delete it or don't use it.
- **Fork run keys:** anvil's well-known dev addresses carry code on real Sepolia (EIP-7702 delegations) and can't
  receive ENSv2 name tokens; use freshly generated keys on a fork (see `DEPLOYMENT.md`).
- The temporary fork deployment files were removed. Nothing is committed yet (the git repo is initialized but empty).

## To go live

Fill in `.env` (a Sepolia RPC URL, three funded EVM keys and a funded Sui testnet key; `.env.example` lists them),
then run:

```
pnpm deploy:evm
pnpm deploy:sui
pnpm configure:ens
pnpm demo
pnpm web
```

## Where to read more

- `README.md` — overview, quickstart, SDK usage, invariants
- `docs/ARCHITECTURE.md` — identity mapping, policy commitment, authority model, Aqua lifecycle
- `docs/BUCKET_VM.md` — the `0xd0` opcode: encoding, execution steps, settlement hooks
- `docs/SECURITY.md` — invariants, trust assumptions, known limitations
- `docs/DEPLOYMENT.md` — deployment steps, local fork mode
- `FEEDBACK.md` — feedback for 1inch, ENS and Sui
- `contracts/evm/lib/VENDORED.md` — pinned upstream sources and the single modified file
