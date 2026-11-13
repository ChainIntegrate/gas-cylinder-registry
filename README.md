# GasTrace (gas-cylinder-registry)

Tracking of technical gas cylinders on LUKSO, for gas suppliers and their drivers. Each cylinder is an
LSP8 token in the supplier's own register; its data is encrypted on-chain with a key only the supplier
holds. Drivers scan the barcodes with an Android app at delivery and collection; the supplier manages
the register from a web page; nobody at the supplier ever holds LYX.

**Status: live on LUKSO mainnet for a demo** (Argonia Gas Tecnici, a fictional supplier). Not audited.

## The parts

| Part | What it is | Where | Guide |
|---|---|---|---|
| **Contracts** | The register (one LSP8 collection per supplier) and the factory that creates them | `contracts/` | [DESIGN.md](DESIGN.md) |
| **Shared library** | Encryption, key wraps, identifiers, formats, EIP-712 types, the signed e-mail | `shared/` | [DESIGN.md](DESIGN.md) |
| **Drivers' app "GasTrace"** | Android (Capacitor): scan, deliver, collect, stock count, refill; signs with a key kept on the phone | `app/`, `android/` | [docs/app.md](docs/app.md) |
| **Admin page "GasTrace"** | The supplier's web page: overview, cylinders and their history, documents, customers, phones, settings; signed in with the ChainIntegrate Account extension | `admin/` | [docs/admin.md](docs/admin.md) |
| **Relayer** | Sends the signed operations, pays the gas, sends each document's e-mail | `relayer/` | [relayer/README.md](relayer/README.md) |
| **ChainIntegrate's tools** | Command line: deploy the factory, create registers, verify the source, and owner operations for an owner using a key file | `scripts/` | [docs/owner-tools.md](docs/owner-tools.md) |

How they fit together:

```
 driver's phone (GasTrace app)          supplier's browser (admin page + ChainIntegrate Account)
        │ signs a document                       │ signs a change (customers, phones, settings)
        └──────────────► relayer (gastrace.chainintegrate.it/gcr/) ◄──────────────┘
                            │ checks, sends, pays the gas; e-mails the document
                            ▼
              register on LUKSO (encrypted data, one token per cylinder)
                            ▲
                            │ reads (decrypted with the data key, in the app or the page)
```

## Live on LUKSO mainnet

| | |
|---|---|
| Admin page | https://gastrace.chainintegrate.it/ |
| Relayer | https://gastrace.chainintegrate.it/gcr/info |
| Factory | [`0xA128e7162fa8Dc779bf31EF569F06B53a499A50e`](https://explorer.execution.mainnet.lukso.network/address/0xA128e7162fa8Dc779bf31EF569F06B53a499A50e) (block 8774243, source verified) |
| Register implementation | [`0x3075ED17F09E0006cECC0D7e67Fe7E7A4Dc95b00`](https://explorer.execution.mainnet.lukso.network/address/0x3075ED17F09E0006cECC0D7e67Fe7E7A4Dc95b00) (source verified; registers are its clones) |
| Demo register | [`0xEae1a8B84977694e5c9925028a23599bc345b801`](https://explorer.execution.mainnet.lukso.network/address/0xEae1a8B84977694e5c9925028a23599bc345b801), owned by Argonia Gas Tecnici's ChainIntegrate account `0xC335…D773` |
| App | [Releases](https://github.com/ChainIntegrate/gas-cylinder-registry/releases) (`gastrace-v<version>.apk`) |

How it was published, step by step: [DEPLOY.md](DEPLOY.md).

## Repository

```
contracts/   GasCylinderRegistry.sol, GasCylinderRegistryFactory.sol (and a test-only contract account)
shared/      encryption, identifiers, formats, EIP-712, e-mail; used by the app, the page, the relayer, the tools
app/         the drivers' app: logic, interface, native bridge, icon (built into app/www)
android/     the Capacitor Android project: the phone key plugin (DeviceKeyPlugin), signing
admin/       the admin page (src/), its build (www/, committed: the server serves it as is)
relayer/     the relayer service, its systemd unit and configuration example
scripts/     ChainIntegrate's tools, builds, the browser tests (ui-demo, admin-demo), source verification
test/        contract, library, relayer, owner tools and app logic tests (Hardhat)
tools/nginx/ the site's nginx configuration
docs/        the guides of the app, the admin page and the tools
```

## Development

```bash
npm ci
npx hardhat compile                 # solc 0.8.28 from npm (solc-js), no compiler download
npx hardhat test                    # contracts, library, tools, relayer, app logic
npx hardhat node &                  # then the two browser tests:
node scripts/ui-demo.js [shots]     #   the app's interface, the demo step by step
node scripts/admin-demo.js [shots]  #   the admin page, checked against the extension's catalog
node scripts/build-app.js           # app/www
node scripts/build-admin.js         # admin/www
node scripts/export-abi.js          # after changing the contracts: ABIs for the tools, relayer, app, page
```

GitHub Actions runs all of it at every push and builds the APK; a release `v<versionName>` attaches the
signed APK ([docs/app.md](docs/app.md#signing)).

## Rules of this repository

- Everything in the repository is written in English: code, comments, documents, commits, release
  notes. The app's and the page's Italian texts are translations, in their `i18n.js` files.
- The examples use the fictional supplier Argonia Gas Tecnici. Real company names never appear here:
  not in code, tests, fixtures, commits or pull requests.
- Key files, passwords and the tools' `gcr-registry.json` never enter the repository (`.gitignore`).

## License

Source available, all rights reserved: see [LICENSE](LICENSE). Third-party components:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
