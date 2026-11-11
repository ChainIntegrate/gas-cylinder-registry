# Third-party notices

This project uses the following third-party components. Each remains under its own license; the full
license texts are in the packages themselves (`node_modules/<package>/LICENSE` after `npm install`).

## Compiled into the contracts

| Component | Version | Use | License |
|---|---|---|---|
| `@lukso/lsp8-contracts` (with `@lukso/lsp1`, `lsp2`, `lsp4`, `lsp17` contracts and `@erc725/smart-contracts`) | 0.18.1 | LSP8 collection, ERC725Y data, ownership | Apache-2.0 |
| `@lukso/lsp4-contracts` | 0.17.3 | LSP4 constants | Apache-2.0 |
| `@openzeppelin/contracts` | 4.9.6 | Clones, Ownable, ECDSA, SignatureChecker (ERC-1271) | MIT |
| `@openzeppelin/contracts-upgradeable` | 4.9.6 | EIP-712 for clones | MIT |

## Relayer

| Component | Version | Use | License |
|---|---|---|---|
| `ethers` | 6.17.0 | RPC, signatures | MIT |
| `nodemailer` | 10.0.13 | E-mail through SMTP | MIT-0 |

## Development tools

| Component | Version | Use | License |
|---|---|---|---|
| `hardhat`, `@nomicfoundation/hardhat-toolbox` | 2.x, 5.x | Compilation, tests | MIT |
| `solc` | 0.8.28 | Solidity compiler (solc-js) | MIT |
| `ethers` | 6.x | Signing and encoding (tests, shared library) | MIT |

## Planned

| Component | Use | License |
|---|---|---|
| `@capacitor/core` and plugins | Android app shell | MIT |
| `@capacitor-mlkit/barcode-scanning` | Barcode scanning (Google ML Kit) | Apache-2.0 |
