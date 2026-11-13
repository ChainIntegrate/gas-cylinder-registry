# The admin page: GasTrace for the supplier

The register owner's page, at **https://gastrace.chainintegrate.it/**. The supplier manages the register
there and sees it in plain words; Italian and English (button at the top right), light and dark.

## Sign-in: the ChainIntegrate Account extension

The supplier signs in with the **ChainIntegrate Account** browser extension
([up-onboarding](https://github.com/ChainIntegrate/up-onboarding)). The page finds it through EIP-6963
(`rdns` `it.chainintegrate.account`), asks for the account and finds, through the factory, the registers
that account owns. The register's owner is that account (a Universal Profile); its key signs each change
in the extension's own confirmation window, and the register checks the signature through the account
(ERC-1271). The supplier never holds LYX: the relayer sends every change and pays for it.

Any key of the account with the SIGN permission can sign in: a second computer can restore the same
access from the extension's backup copy, or, once the extension offers it, add a key of its own.

**The extension's catalog.** The extension serves only the sites and requests declared in its catalog
(`extension/shared/catalog.js` in up-onboarding). For GasTrace the four requests (`SetOperator`,
`SetData`, `TransferOwnership`, `AcceptOwnership`) are declared; the factory and the site must be set
there, and a release of the extension made, before the page can sign in:

```js
const CYLINDER_FACTORY = "0xA128e7162fa8Dc779bf31EF569F06B53a499A50e";
// in the "gas-cylinders" project:
sites: ["gastrace.chainintegrate.it"],
```

Until then the page says it cannot find the extension.

## What the supplier does there

| Section | What |
|---|---|
| **Overview** | Cylinders in total, at the depot, at customers, being refilled, defective; by gas; the latest documents |
| **Cylinders** | Every cylinder with its gas, where it is, its condition and last movement; search; click for its history (each movement with its document) |
| **Documents** | Delivery notes, stock counts and refill notes, each with its cylinders and the warnings the driver confirmed |
| **Customers** | Customers and refill plants: add, edit (name, e-mails: they receive that customer's documents), remove |
| **Phones** | The authorized phones; authorize one by the code the app shows; revoke; the setup QR the app scans at its first start |
| **Settings** | The company name (shown in the app and the e-mails) and the company's own e-mails (they receive a copy of every document); a new data password |

The data password opens the register's data **in the page only**: it is never sent anywhere, and closing
the page forgets it. "I lost the password" opens the data with the 24-word recovery code and sets a new
password.

## Build and publish

```bash
# admin/admin-config.json: rpc, chainId, relayer, factory and the factory's deployment block
node scripts/build-admin.js      # admin/www: index.html, admin.js, admin.css, logo, favicon
```

`admin/www` is committed: the server serves it from its clone (`/var/www/gas-cylinder-registry`) with no
build, so a change to the page is `build-admin`, commit, push, then `git pull` on the server. The site
(page and relayer under `/gcr/`) is described in [DEPLOY.md](../DEPLOY.md), its nginx files are in
`tools/nginx/`. The page connects only to LUKSO's public node and to its own site (its
Content-Security-Policy allows nothing else).

## Test

```bash
npx hardhat node &
UPONBOARDING_DIR=../up-onboarding node scripts/admin-demo.js [screenshots-dir]
```

The test runs the page in Chromium with a simulated extension whose account is a contract that validates
signatures with ERC-1271, as a ChainIntegrate account does, and checks every request against the
extension's own catalog (from up-onboarding; CI clones it). Steps: sign-in, the data password, settings,
customers, a refill plant, a phone authorized by its code; the driver's app records a stock count and a
delivery note; the page shows them (overview, cylinders, a cylinder's history, documents); the password
is changed. It also checks that no technical word appears and that the page fits a phone's width.
