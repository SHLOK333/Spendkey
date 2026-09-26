# Builder feedback

Notes collected while building BUCKET on 1inch Aqua + SwapVM, ENSv2 and Sui.

## 1inch Aqua / SwapVM

- **SDK and `main` disagree on opcode numbering.** `@1inch/swap-vm-sdk` builds programs against an index-based
  instruction table (v1.0 router), while `swap-vm` `main` uses the fixed `OpcodeList` banks (e.g. `Deadline = 0x20`,
  `Salt = 0x02`). Programs built with the SDK do not run on a router compiled from `main`. A versioned opcode map
  exported by the SDK (or the router exposing its table) would remove the ambiguity.
- **No Sepolia deployment.** Aqua and the SwapVM router are deterministic on many mainnets but not on Sepolia, where
  ENSv2 lives. A testnet deployment would let hackathon projects compose with ENSv2 without redeploying Aqua.
- **Custom opcodes require a custom router.** The design is clean (`_dispatch` + opcode libraries) but a router with
  one extra instruction lands within ~66 bytes of EIP-170 at the default optimizer settings. Guidance on splitting
  opcode sets would help extension authors.
- **Maker hooks are the right place for post-settlement checks** — `preTransferOut` + `postTransferIn` let a maker
  verify exact balance deltas. Documenting the ordering guarantees (and that `isFirstTransferFromTaker` flips them)
  in the README would save time.
- The Aqua README's explanation of immutability and `dock` → `ship` re-parameterisation mapped directly onto Bucket
  intents; `Salt` being necessary to re-ship an identical program after docking is worth calling out.

## ENSv2

- `EnhancedAccessControl` with an overridable `_getRoles` is an excellent integration point: BUCKET derives
  authority from live registry state without duplicating ownership.
- The deployment artifacts in `contracts-v2/contracts/deployments/sepolia` were the most reliable source of
  addresses; linking them from the docs site would help.
- Resolving names top-down requires `getSubregistry` per label and `getParent` for the reverse walk; a small helper
  in the docs for "find the registry and labelhash of a name" would be useful for contract developers.

## Sui

- The Sui CLI now creates a client config and keypair automatically on first `sui move build` in non-interactive
  environments; `--build-env` is required for implicit framework dependencies. Worth highlighting for CI users.
- `@mysten/sui` 2.x with the gRPC client and BCS-first object content made decoding deterministic across transports.
- `@mysten/dapp-kit` 1.x is JSON-RPC based while `@mysten/dapp-kit-react` 2.x works with the gRPC client; the naming
  makes it easy to pick the older package.
