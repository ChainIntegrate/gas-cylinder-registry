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
access from the extension's backup copy, or get a key of its own ("Authorize another computer", from
extension 0.5.0). Every such key can sign **all** the register's owner operations, handing the register
over included, whatever role the extension gives it (review X-01): authorize other computers only for
people who may administer the register.

**The extension's catalog.** The extension serves only the sites and requests declared in its catalog
(`extension/shared/catalog.js` in up-onboarding). For GasTrace the four requests (`SetOperator`,
`SetData`, `TransferOwnership`, `AcceptOwnership`) are declared, with the factory and the site (from
extension 0.4.3). From extension 0.5.1 (review A02/G-04) the page sends each `SetData`'s values beside
the signed hash (`dataValues`, a top-level field of the `eth_signTypedData_v4` request that other
wallets ignore): the extension recomputes the hash (a mismatch is refused), accepts only GasTrace's five
kinds of data key, reads the registry's current values and says what the change is ("Prepare the
encryption of the registry's data… (first time)", "Change the data password", "Add 1 customer or refill
centre", "The company's settings"…), never both key wraps once they exist; it shows how long the request
is valid and refuses more than seven days. The values are encrypted: the window names the kind of change,
not its content. The browser test checks every request against the catalog of the release named in CI
(`UPONBOARDING_REF`):

```js
const CYLINDER_FACTORY = "0xA128e7162fa8Dc779bf31EF569F06B53a499A50e";
// in the "gas-cylinders" project:
sites: ["gastrace.chainintegrate.it"],
```


## What the supplier does there

| Section | What |
|---|---|
| **Overview** | Cylinders in total, at the depot, at customers, being refilled, defective; by gas; the latest documents |
| **Cylinders** | Every cylinder with its gas, where it is, its condition and last movement; search; click for its history (each movement with its document) |
| **Documents** | Delivery notes, stock counts and refill notes, each with its cylinders and the warnings the driver confirmed |
| **Customers** | Customers and refill plants: add, edit (name, e-mails: they receive that customer's documents), remove (archived, not erased: the app no longer offers it, its documents keep its name; review A21) |
| **Phones** | The authorized phones; authorize one by the code the app shows; revoke; the setup QR the app scans at its first start |
| **Download data** | The register as CSV files made in the page (no server): cylinders, movements (each cylinder of each document), documents, customers and refill plants. UTF-8 with a byte order mark; `;` in Italian, `,` in English; a value starting with `= + - @` gets an apostrophe so a spreadsheet never runs it. The files are not encrypted, and the page says so |
| **Settings** | The company name (shown in the app and the e-mails) and the company's own e-mails (they receive a copy of every document); a new data password |

**First sign-in.** A new register has no data key yet: the page shows only "Prepare the register's
data". The owner chooses the data password, the page makes the data key and the 24-word recovery code
(shown once, with a print button that prints only the words and the register's name; two words are
checked), and one confirmation in the extension writes both wraps. Everything is made in the owner's
browser: ChainIntegrate never sees the password or the words (review X-02).

The data password opens the register's data **in the page only**: it is never sent anywhere, and closing
the page forgets it. "I lost the password" opens the data with the 24-word recovery code and sets a new
password.

## The users' guide

`guida.html` (Italian) and `guide.html` (English), linked from the page's footer: the owner's page and the
drivers' app in plain words, for Argonia's office and drivers (sign-in, password and recovery code,
settings, customers, phones; installing the app, setup, delivery and collection, stock count, refill,
"To send", the e-mail, updates; common problems). Static pages with no script, in `admin/`, copied to
`admin/www` by the build, with their pictures in `admin/guide-img/`: screenshots of the browser tests
(`node scripts/ui-demo.js <dir>`, `node scripts/admin-demo.js <dir>`, sample data only), cropped and
saved as WebP; the setup QR in the phones picture is blurred. When the app's or the page's wording
changes, change the guide and its pictures with it.

## The operator page (ChainIntegrate only)

`https://gastrace.chainintegrate.it/operator.html` (not indexed): ChainIntegrate creates a supplier's
register from the browser instead of the command line.

- **Sign-in** with the wallet of ChainIntegrate's Universal Profile, the factory's owner: LUKSO's
  Universal Profile extension or UP Wallet, found through EIP-6963. The ChainIntegrate Account extension
  is left out on purpose: it never signs ChainIntegrate's own administration. The page checks that the
  account is the factory's owner.
- **Registers created**: name, owner, number of cylinders, each linked to the explorer.
- **New register**: the company's name and symbol and the supplier's ChainIntegrate account (checked to
  be a Universal Profile); the page sends `createRegistry` through the wallet: ChainIntegrate's profile
  signs and pays. **No data password and no recovery code here** (review X-02): the register is created
  without its data key, and the supplier makes both at the first sign-in in the admin page. At the end:
  the register's address and the admin page's link and QR for the supplier.

The factory must first belong to ChainIntegrate's profile: `node scripts/owner.js transfer-factory
<profile address>` ([owner-tools.md](owner-tools.md)), once.

## Build and publish

```bash
# admin/admin-config.json: rpc, chainId, relayer, factory and the factory's deployment block
node scripts/build-admin.js      # admin/www: index.html, operator.html, their scripts, admin.css, logo, favicon
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
node scripts/operator-demo.js [screenshots-dir]
```

The operator test creates a register from the page with a simulated ChainIntegrate wallet (the
ChainIntegrate Account extension announced too, and ignored), refuses a weak password, an owner that is
not a profile and wrong check words, and checks that the register is the factory's, owned by the
supplier, asks no password, shows no recovery code and has no data key yet.

The test runs the page in Chromium with a simulated extension whose account is a contract that validates
signatures with ERC-1271, as a ChainIntegrate account does, and checks every request against the
extension's own catalog (from up-onboarding; CI clones it). Steps: sign-in, the first sign-in's data
key (password, 24 words shown and two checked, both open the same key), the next sign-in with the password, settings,
customers, a refill plant, a phone authorized by its code; the driver's app records a stock count and a
delivery note; the page shows them (overview, cylinders, a cylinder's history, documents); the password
is changed. It also checks that no technical word appears and that the page fits a phone's width.
