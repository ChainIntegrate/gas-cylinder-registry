# GasTrace (gas-cylinder-registry)

Tracking of technical gas cylinders on LUKSO, for gas suppliers and their drivers. Each cylinder is an
LSP8 token in the supplier's own register; its data is encrypted on-chain with the register's data key,
made by the supplier at the first sign-in and opened by their password (and held by the authorized
phones: see [DESIGN.md](DESIGN.md), "Who holds the data key"). Drivers scan the barcodes with an Android
app at delivery and collection; the supplier manages the register from a web page; nobody at the
supplier ever holds LYX.

**Status: live on LUKSO mainnet for a demo** (Argonia Gas Tecnici, a fictional supplier). A first
external review (2026-11-13) is closed for the demo: what was fixed, documented or planned is in
[docs/security-review-2026-11.md](docs/security-review-2026-11.md). Version 2 of the contracts (deployed
on 2026-11-17, [DESIGN.md §10.1](DESIGN.md)) is what the app 0.3.0, the pages and the relayer use in this
repository: the cylinder's owner, the periodic test, corrections, handovers with their wait, a replaceable
data key. Before real customer data: the server's update
([DEPLOY.md](DEPLOY.md), "Version 2 online").

## The parts

| Part | What it is | Where | Guide |
|---|---|---|---|
| **Contracts** | The register (one LSP8 collection per supplier) and the factory that creates them | `contracts/` | [DESIGN.md](DESIGN.md) |
| **Shared library** | Encryption, key wraps, identifiers, formats, EIP-712 types, the signed e-mail | `shared/` | [DESIGN.md](DESIGN.md) |
| **Drivers' app "GasTrace"** | Android (Capacitor): scan, deliver, collect, stock count, refill; signs with a key kept on the phone | `app/`, `android/` | [docs/app.md](docs/app.md) |
| **Admin page "GasTrace"** | The supplier's web page: the data key prepared at the first sign-in, overview, cylinders and their history, documents, customers, phones, settings, data download (CSV); signed in with the ChainIntegrate Account extension | `admin/` | [docs/admin.md](docs/admin.md) |
| **Relayer** | Sends the signed operations, pays the gas, sends each document's e-mail | `relayer/` | [relayer/README.md](relayer/README.md) |
| **Operator page** | ChainIntegrate's page to create a supplier's register from the browser (`operator.html`), signed by ChainIntegrate's Universal Profile | `admin/` | [docs/admin.md](docs/admin.md#the-operator-page-chainintegrate-only) |
| **ChainIntegrate's tools** | Command line: deploy the factory, hand it to ChainIntegrate's profile, create registers, verify the source, owner operations for an owner using a key file | `scripts/` | [docs/owner-tools.md](docs/owner-tools.md) |

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
| Factory | [`0xA128e7162fa8Dc779bf31EF569F06B53a499A50e`](https://explorer.execution.mainnet.lukso.network/address/0xA128e7162fa8Dc779bf31EF569F06B53a499A50e) (block 8774243, source verified), owned by ChainIntegrate's Universal Profile `0x4a26…8c27` |
| Operator page | https://gastrace.chainintegrate.it/operator.html (ChainIntegrate only) |
| Users' guide | https://gastrace.chainintegrate.it/guida.html (Italian), [guide.html](https://gastrace.chainintegrate.it/guide.html) (English): the owner's page and the drivers' app in plain words |
| Register implementation | [`0x3075ED17F09E0006cECC0D7e67Fe7E7A4Dc95b00`](https://explorer.execution.mainnet.lukso.network/address/0x3075ED17F09E0006cECC0D7e67Fe7E7A4Dc95b00) (source verified; registers are its clones) |
| Factory, version 2 | [`0xd60146C03f288fCeEEdB90731f162fF57F7ebdd2`](https://explorer.execution.mainnet.lukso.network/address/0xd60146C03f288fCeEEdB90731f162fF57F7ebdd2) (block 8803983, source verified), owned by ChainIntegrate's Universal Profile `0x4a26…8c27`; no registers yet ([DESIGN.md §10.1](DESIGN.md)) |
| Register implementation, version 2 | [`0xaC0D8EffB68C5FE9F291dd34570dD2f6c53026af`](https://explorer.execution.mainnet.lukso.network/address/0xaC0D8EffB68C5FE9F291dd34570dD2f6c53026af) (source verified) |
| Demo register | [`0xEae1a8B84977694e5c9925028a23599bc345b801`](https://explorer.execution.mainnet.lukso.network/address/0xEae1a8B84977694e5c9925028a23599bc345b801), owned by Argonia Gas Tecnici's ChainIntegrate account `0xC335…D773` |
| App | [Releases](https://github.com/ChainIntegrate/gas-cylinder-registry/releases) (`gastrace-v<version>.apk`) |

How it was published, step by step: [DEPLOY.md](DEPLOY.md).

## Repository

```
contracts/   GasCylinderRegistry.sol, GasCylinderRegistryFactory.sol (version 1, the demo); their V2 files (version 2,
             DESIGN.md §10.1); test-only accounts (a mock, and LUKSO's LSP0 and LSP6 for version 2's tests)
shared/      encryption, identifiers, formats, EIP-712, e-mail; used by the app, the page, the relayer, the tools
app/         the drivers' app: logic, interface, native bridge, icon (built into app/www)
android/     the Capacitor Android project: the phone key plugin (DeviceKeyPlugin), signing
admin/       the admin and operator pages (src/), the users' guide (guida.html, guide.html), their build (www/, committed)
relayer/     the relayer service, its systemd unit and configuration example
scripts/     ChainIntegrate's tools, builds, the browser tests (ui-demo, admin-demo, operator-demo), source verification
test/        contract (versions 1 and 2), library, relayer, owner tools, app logic, admin export and phone vault tests (Hardhat)
tools/nginx/ the site's nginx configuration
docs/        the guides of the app, the admin page and the tools; the external review's record
```

## Development

What the tests need (review A22): Linux or macOS (CI runs Ubuntu 24.04; on Windows use WSL), Node.js 22,
port 8545 free for the local chain, Chromium for the browser tests
(`npx playwright@1.56.1 install chromium`, then `npm install --no-save playwright@1.56.1`), and for the
admin page test a clone of up-onboarding at the release CI uses (`UPONBOARDING_REF` in
`.github/workflows/android.yml`), given as `UPONBOARDING_DIR` (without it the page is tested without
the extension's catalog). The Android build needs Java 21 and the Android SDK.

```bash
npm ci
npx hardhat compile                 # solc 0.8.28 from npm (solc-js), no compiler download
npx hardhat test                    # contracts, library, tools, relayer, app logic
npx hardhat node &                  # then the three browser tests:
node scripts/ui-demo.js [shots]     #   the app's interface, the demo step by step
UPONBOARDING_DIR=<clone> node scripts/admin-demo.js [shots]  # the admin page, against the extension's catalog
node scripts/operator-demo.js [shots] # the operator page: a register created from the browser
node scripts/build-app.js           # app/www
node scripts/build-admin.js         # admin/www
node scripts/export-abi.js          # after changing the contracts: ABIs for the tools, relayer, app, page
```

GitHub Actions runs all of it at every push and builds the APK; a release `v<versionName>` attaches the
signed APK ([docs/app.md](docs/app.md#releases-and-signing)).

## Rules of this repository

- Everything in the repository is written in English: code, comments, documents, commits, release
  notes. The app's and the page's Italian texts are translations, in their `i18n.js` files.
- The examples use the fictional supplier Argonia Gas Tecnici. Real company names never appear here:
  not in code, tests, fixtures, commits or pull requests.
- Key files, passwords and the tools' `gcr-registry.json` never enter the repository (`.gitignore`).

## License

Source available, all rights reserved: see [LICENSE](LICENSE). Third-party components:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
