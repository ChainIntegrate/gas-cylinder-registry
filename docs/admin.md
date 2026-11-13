# GasTrace admin page

The register owner's page: `https://gastrace.chainintegrate.it/` (planned address). It replaces the owner
tools for everything the owner does day to day, and shows the register to them in plain words.

## Sign-in: the ChainIntegrate Account extension

The owner signs in with the **ChainIntegrate Account** browser extension (`ChainIntegrate/up-onboarding`):
the page finds it through EIP-6963 (`rdns` `it.chainintegrate.account`) and asks for the account. The
registry's owner is that account (a Universal Profile created by up-onboarding); its key signs each change
in the extension's own confirmation window, and the register checks the signature through the account
(ERC-1271). The owner never holds LYX: the relayer sends every change and pays for it.

The extension serves only the pages and the requests of its catalog (`extension/shared/catalog.js` in
up-onboarding). For GasTrace it already declares the four requests (`SetOperator`, `SetData`,
`TransferOwnership`, `AcceptOwnership`), but serves them only once two values are set there:

```js
const CYLINDER_FACTORY = "0x…";                 // the factory deployed with: node scripts/owner.js deploy-factory
// in the "gas-cylinders" project:
sites: ["gastrace.chainintegrate.it"],
```

`scripts/admin-demo.js` checks every request the page makes against that catalog (when up-onboarding is
next to this repository, or with `UPONBOARDING_DIR`), so the page asks only for what the extension accepts.

## What the owner does there

| Section | What |
|---|---|
| **Overview** | Cylinders in total, at the depot, at customers, being refilled, defective; by gas; the latest documents |
| **Cylinders** | Every cylinder with its gas, where it is, its condition and last movement; search; click for its history (each movement with its document) |
| **Documents** | Delivery notes, stock counts and refill notes, each with its cylinders and the warnings the driver confirmed |
| **Customers** | Customers and refill plants: add, edit (name, e-mails), remove |
| **Phones** | The authorized phones, authorize one by the code the app shows, revoke; the setup QR the app scans at its first start |
| **Settings** | The company name and the supplier's e-mails; a new data password |

The data password opens the register's data **in the page only**: it is never sent anywhere, and closing
the page forgets it. "I lost the password" opens the data with the 24-word recovery code and sets a new
password.

## Build and publish

```bash
# admin/admin-config.json: rpc, chainId, relayer, factory and the factory's deployment block
node scripts/build-admin.js      # admin/www: index.html, admin.js, admin.css, logo, favicon
```

`admin/www` is a static site: serve it from the Cross_Chain server (nginx or Apache) as
`gastrace.chainintegrate.it`, with HTTPS. The page talks only to the configured RPC and relayer (its
Content-Security-Policy allows nothing else), so the relayer's `allowedOrigins` must include
`https://gastrace.chainintegrate.it` (`relayer/config.example.json` has it).

nginx, a new `server` block:

```nginx
server {
    listen 443 ssl;
    server_name gastrace.chainintegrate.it;
    root /var/www/gastrace;          # the contents of admin/www
    index index.html;
    add_header X-Frame-Options DENY;
    add_header Referrer-Policy no-referrer;
    # ssl_certificate … (as the other ChainIntegrate sites)
}
```

## Test

```bash
npx hardhat node &
node scripts/admin-demo.js [screenshots-dir]
```

The test runs the page in Chromium with a simulated extension whose account is a contract that validates
signatures with ERC-1271, as a ChainIntegrate Account does: sign-in, the data password, settings,
customers, a refill plant, a phone authorized by its code, then the driver's app records a stock count
and a delivery note, and the page shows them (overview, cylinders, a cylinder's history, documents); the
password is changed; no technical word appears; no horizontal scroll at phone width.
