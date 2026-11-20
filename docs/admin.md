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

A second computer can restore the same access from the extension's backup copy, or get a key of its
own ("Authorize another computer" in the extension), as an **administrator** or an **access** computer.
From extension 0.6.0 the owner's requests are confirmed only on an **administrator** computer: the
confirmation window reads the computer's permissions on the account and, from an access computer,
refuses GasTrace's requests (error 4100, `admin_only`); the page then says "This operation is confirmed
from an administrator computer of your account" (review A01 / X-01). The version 2 register checks it
too: an owner's signature is accepted only from a key with administrator permissions on the account
(EDITPERMISSIONS), so an access key, which has SIGN, is refused even outside the extension
([DESIGN.md §6.2](../DESIGN.md)).

**Accounts without a register.** The page says "GasTrace is not active yet for this account" and offers
"Request activation" (a ready-made e-mail to info@chainintegrate.it holding the account's address, which
is not shown on screen) or "Copy the request". A register being handed over to the account is listed with
"Accept the register", from the end of its 3 days.

**The extension's catalog.** The extension serves only the sites and requests declared in its catalog
(`extension/shared/catalog.js` in up-onboarding). From extension 0.6.1 it declares version 2: the
factory, the domain `GasCylinderRegistry` version `2` and the requests `SetOperator`, `SetData`,
`TransferOwnership`, `CancelOwnershipTransfer`, `AcceptOwnership`, `RecordDocument` (the owner's
corrections) and `CancelNonces`, each with `nonce`, `validFrom` and `deadline`:

```js
const CYLINDER_FACTORY = "0xd60146C03f288fCeEEdB90731f162fF57F7ebdd2";
// in the "gas-cylinders" project:
sites: ["gastrace.chainintegrate.it"],
```

From extension 0.5.1 (review A02/G-04) the page sends each `SetData`'s values beside
the signed hash (`dataValues`, a top-level field of the `eth_signTypedData_v4` request that other
wallets ignore): the extension recomputes the hash (a mismatch is refused), accepts only GasTrace's kinds
of data key, reads the registry's current values and says what the change is ("Prepare the encryption of
the registry's data… (first time)", "Change the data password", "Add 1 customer or refill centre", "The
company's settings", "Change the data key: new data password and new recovery code"…); it shows how long
the request is valid and refuses more than seven days. The values are encrypted: the window names the
kind of change, not its content. The catalog marks GasTrace's requests `signer: "admin"`. The browser
test checks every request against the catalog of the release named in CI (`UPONBOARDING_REF`,
`extension-v0.6.1`), and the page's message when an access computer is refused.

## What the supplier does there

| Section | What |
|---|---|
| **Overview** | Cylinders in total, at the depot, at customers, being refilled, defective, with the test expired or expiring within 3 months; by gas; the latest documents |
| **Cylinders** | Every cylinder with its gas, owner, where it is, condition, test expiry and last movement; search; filters for the periodic test (expired, expiring, to complete); click for its history (each movement with its document, corrections with their reason) and "Correct" (gas, litres, owner, test, years between tests: a correction document signed by the owner, review A06) |
| **Documents** | Delivery notes, stock counts, refill notes and corrections, each with its cylinders and the warnings the driver confirmed; an incomplete document (parts recorded of parts) is marked |
| **Customers** | Customers and refill plants: add, edit (name, e-mails: they receive that customer's documents), remove (archived, not erased: the app no longer offers it, its documents keep its name; review A21) |
| **Phones** | The authorized phones; authorize one by the code the app shows; revoke; the setup QR the app scans at its first start |
| **Download data** | The register as CSV files made in the page (no server): cylinders, movements (each cylinder of each document), documents, customers and refill plants. UTF-8 with a byte order mark; `;` in Italian, `,` in English; a value starting with `= + - @` gets an apostrophe so a spreadsheet never runs it. The files are not encrypted, and the page says so |
| **Settings** | The company name (shown in the app and the e-mails), the company's own e-mails (they receive a copy of every document), the years between periodic tests by gas; a new data password; handing the register to another account (3 days, cancellable); rare cases: a new data key (review A05) |

**Several admin computers.** A customer or the settings are saved only if nobody changed them since the
page read them; otherwise the page says so and shows the current value.

**First sign-in.** A new register has no data key yet: the page shows only "Prepare the register's
data". The owner chooses the data password, the page makes the data key and the 24-word recovery code
(shown once, with a print button that prints only the words and the register's name; two words are
checked), and one confirmation in the extension writes both wraps. Everything is made in the owner's
browser: ChainIntegrate never sees the password or the words (review X-02).

The data password opens the register's data **in the page only**: it is never sent anywhere, and closing
the page forgets it; after 30 minutes unused the page forgets it too and asks again (review A09). "I
lost the password" opens the data with the 24-word recovery code and sets a new password.

## The users' guide

The guide describes version 2 (DESIGN.md §§6–9). An account without a register sees "GasTrace is not active yet"
and sends ChainIntegrate a ready-made e-mail (or copies it) with the account's address, which is never
shown on screen.

`guida.html` (Italian) and `guide.html` (English), linked from the page's footer: the owner's page and the
drivers' app in plain words, for a supplier's office and drivers (activation request, sign-in, password and recovery code,
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
node scripts/build-admin.js      # admin/www: index.html, operator.html, their scripts, admin.css, logo, favicon, the guide and its pictures
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
ChainIntegrate Account extension announced too, and ignored), refuses an owner that is not a profile,
and checks that the register is the factory's, owned by the supplier, asks no password, shows no
recovery code and has no data key yet.

The test runs the page in Chromium with a simulated extension whose account is a contract that validates
signatures with ERC-1271, as a ChainIntegrate account does, and checks every request against the
extension's own catalog (from up-onboarding; CI clones it). Steps: sign-in, the first sign-in's data
key (password, 24 words shown and two checked, both open the same key), the next sign-in with the password, settings,
customers, a refill plant, a phone authorized by its code; the driver's app records a stock count and a
delivery note (one cylinder with an expired test); the page shows them (overview, cylinders, a
cylinder's history, documents) and downloads them (CSV); a cylinder is corrected (owner and test, with a
reason); the test filter shows the expired cylinder; a customer changed meanwhile from another computer
is not overwritten; a handover is started and cancelled; the password is changed and the data key
replaced (new password and 24 words, the old password refused); after 30 minutes the page locks. An
account without a register gets the activation request, with its address in the e-mail. With the extension's catalog it
checks each request's description (no "content not verifiable") and that values changed after the
hash are refused. It also checks that no technical word appears and that the page fits a phone's width.
