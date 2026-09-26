# Vendored upstream sources

Pinned copies of the official sources. Only `swap-vm/contracts/libs/OpcodeList.sol` is modified.

| Directory | Upstream | Commit | License | Changes |
|---|---|---|---|---|
| `aqua/src` | https://github.com/1inch/aqua | `ef24220ed9647555727b06867bf509cd6959d84b` | LicenseRef-Degensoft-Aqua-Source-1.1 | none |
| `swap-vm/contracts` | https://github.com/1inch/swap-vm (`main`) | `3b3da7d66e4f865e4c57279f89727ec4b96e4d7e` | LicenseRef-Degensoft-SwapVM-1.1 | `OpcodeList.sol`: new `0xd0-0xdf` Buckets bank with slots `0xd0` `BucketCapabilityGuard`, `0xd1` `BucketQuote`, `0xd2` `BucketSpendLimit`; `contracts/mocks` removed |
| `ens-contracts-v2/src` | https://github.com/ensdomains/contracts-v2 | `48b3e2d39513b9dd32ef1850877a29009bc807b9` | MIT | minimal closure: `EnhancedAccessControl`, EAC interfaces/libs, registry interfaces, `RegistryRolesLib` |

npm dependencies (`contracts/evm/package.json`): `@1inch/solidity-utils@6.9.10`, `@openzeppelin/contracts@5.4.0`,
`forge-std@1.11.0` — the same versions pinned by swap-vm.

Powered by SwapVM — © Degensoft Ltd 2025.
