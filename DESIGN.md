# Design

How GasTrace works, as implemented: version 2 of the contracts and what uses it (the app 0.3.0, the admin
page, the operator page, the owner tools, the relayer). Decisions are explained where they matter; what
is left open is at the end. The examples use the fictional supplier **Argonia Gas Tecnici**.

## 1. The problem

A supplier of technical gases (argon, acetylene, oxygen, nitrogen, CO₂) delivers full cylinders to its
customers and collects the empty ones. Every delivery comes with a delivery note (DDT) that lists one
line per cylinder but **no serial numbers**: the note is printed before loading, and the driver does not
tie specific cylinders to it in advance (a truck may carry ten argon cylinders, any of which can go to
any customer). At unloading, the driver used to write each cylinder's serial number (a text barcode) by
hand next to its line, and the same for the empty cylinders collected.

GasTrace replaces the handwriting: the driver scans the barcodes, the app knows each cylinder's last
state and links a collected cylinder to the customer that had it, every document is recorded on LUKSO,
encrypted, and an e-mail summary is sent. Each cylinder also carries who owns it (the supplier, a
customer or a refill plant) and its periodic test.

## 2. Principles

- **One cylinder, one token.** Each cylinder is an LSP8 token in the supplier's own register.
- **Everything on-chain, encrypted.** Cylinder data, states, customers, settings and documents live on
  LUKSO, encrypted with the register's data key. The chain is the database: no server keeps the
  data. Who can hold that key is in §5 ("Who holds the data key").
- **No friction, no LYX.** The supplier and the drivers only sign; the relayer sends and pays the gas.
  Nobody at the supplier ever holds or sees LYX, and no screen uses technical words.
- **One register per company.** A factory creates identical, independent registers; the same app,
  page and relayer serve them all.
- **The supplier's own account.** The register's owner is the supplier's ChainIntegrate account (a
  Universal Profile created with up-onboarding). An EOA works too.

## 3. Who does what

| Who | With what | Does |
|---|---|---|
| **The supplier** (register owner) | The admin page, signed in with the ChainIntegrate Account extension (0.6.1 or later) on an administrator computer of its account | Asks for the activation; prepares the data key at the first sign-in (password, recovery code); customers and refill plants, drivers' phones, settings; sees cylinders, histories, documents; corrects a cylinder; downloads the data; can hand the register to another account or replace the data key |
| **A driver** (operator) | The GasTrace app, with a key kept on the phone | Stock counts, deliveries, collections, refills; registers new cylinders (gas, owner, periodic test) |
| **The relayer** | ChainIntegrate's server | Checks and sends signed operations, pays the gas, sends each document's e-mail, alerts when a handover starts |
| **ChainIntegrate** (factory owner) | Its Universal Profile (the operator page) and its command-line tools | Deploys the factory once, creates a register for each supplier (without its data key) after its activation request; no power inside a register |
| **Customers, refill plants** | Nothing | Encrypted entries of the register; they receive the e-mails; they may own cylinders |

**Activation.** An account with no register sees "GasTrace is not active yet" in the admin page and sends
ChainIntegrate a ready-made e-mail (or copies it) holding the account's address, which is not shown on
screen. ChainIntegrate creates the register from the operator page for that address, writes the
register's handover alert address in the relayer's configuration (§7) and answers; the owner then signs
in and prepares the data.

## 4. Data

### 4.1 Cylinders

**Token ID** = `HMAC-SHA256(idKey, "cylinder:" + normalized serial)`. Whoever has the data key scans a
barcode, computes the token ID and reads the cylinder from the chain; anyone else sees random
identifiers and cannot enumerate serials (a plain hash of a short serial could be brute-forced). The
same cylinder has unrelated token IDs in two registers.

Serials are normalized (trimmed, inner spaces removed, upper case) and checked (3 to 40 characters,
letters, digits and `-./`): a misread code is refused rather than becoming a new cylinder
(`shared/crypto.js`, `normalizeSerial`). The labels' real format is still to be seen (§10).

Per-token data, each value encrypted (§5):

| Data key | Plaintext | Written by |
|---|---|---|
| `GCRInfo` | serial, gas, capacity (optional), owner of the cylinder (`supplier`, or a customer or refill plant by id), years between periodic tests (optional, when not the gas's), registered at | a phone once, when it registers the cylinder; afterwards only the owner (a correction) |
| `GCRState` | location (`depot`, or a customer or refill plant by id), condition (`full`, `empty`, `defective`), lifecycle (`active`, `retired`), last movement, scan time, periodic test (optional: last test and expiry as months `YYYY-MM`, or unreadable) | a phone with each movement; the owner (a correction of the test) |

The **owner** of a cylinder is chosen by the driver when the cylinder is first recorded (ours, the
document's customer or refill plant, or another refill plant); afterwards only the register's owner
corrects it. The **periodic test** is in the state, because a phone writes it again when a cylinder
comes back tested: the driver types the month stamped on the cylinder, the last test or the expiry, and
the other is worked out with the years between tests (the cylinder's own, else the settings' for its
gas, else 10); "unreadable" when the stamp cannot be read. Each movement carries the last state's test
forward.

Every change emits LSP8's `TokenIdDataChanged` with the encrypted value: a cylinder's **history** is
rebuilt from the logs. The document and the signer of a change are in the same transaction's
`DocumentRecorded` event, not repeated in the state.

### 4.2 Movements and warnings

| Movement | Document | Location after | Condition |
|---|---|---|---|
| `stock_count` | stock count | the customer or refill plant counted | as found |
| `delivery` | delivery note | the customer | full (by default) |
| `collection` | delivery note | depot | empty by default; full or defective |
| `to_refill` | refill note | the refill plant | as found |
| `from_refill` | refill note | depot | full by default; "Tested" writes a new periodic test |
| `correct` | correction (the owner's) | unchanged | unchanged |

The app proposes the movement from the cylinder's last state and warns (the driver confirms, the
document and the e-mail list it) when it does not fit: a cylinder recorded at another customer, at a
refill plant, retired, not where a stock count finds it, a customer's own cylinder delivered to another
customer (a refill plant's cylinders go to customers without a warning), a cylinder delivered with its
periodic test expired.

### 4.3 Customers, refill plants, settings, keys

Stored in the register's own ERC725Y data, one entry each, encrypted (except the key epoch):

- a counterparty: key LSP2 Mapping `bytes10(keccak256("GCRCounterparty")) + 0x0000 + id` (a random
  20-byte id); value `{ type: customer | refill, name, emails[], archived? }`, the heading the driver
  needs and the addresses that receive its documents' e-mails. Removing one archives it (the app no
  longer offers it), never erases it; each document also keeps the name it was made with (review A21).
- the settings: key `keccak256("GCRSettings")`; value `{ company, emails[], testYears? }`: the name
  shown by the app and the e-mails, the supplier's own addresses, which receive a copy of every
  document, and the years between periodic tests by gas.
- the data key's wraps and epochs: `GCRKeyWrap:0`, `GCRKeyWrap:1`, `GCRKeyEpoch`, `GCRKeyRing` (§5).

Only the owner writes them (§6.2), with one signed `SetData` each time; drivers pick from the lists.
Several admin computers may work on one register: the page writes a customer or the settings only if
nobody changed the entry since it read it (it reads it again before signing and after the write);
otherwise it says "another computer changed this" and shows the current value. The contract has no such
check for the owner's data: two writes of the same entry within seconds of each other can still
overwrite one another.

### 4.4 Documents

A document is what a driver closes (a delivery note, a stock count, a refill note) or an owner's
correction, with all its movements.

- `docId = HMAC(idKey, "doc:" + counterparty id + ":" + name)`, the name being
  `<kind>:<year of the document's date>:<number>`; a stock count, which has no number:
  `stock_count:<time>:<random>`; a correction: `correction:<time>:<random>` with a zero counterparty id.
  The contract refuses the same document twice, while numbering that starts again each year, or the same
  number in another kind of document, makes a different one (review A10).
- One transaction records a part's movements and emits `DocumentRecorded(docId, part, parts, signer,
  corrects, manifest, document)`, `document` being the encrypted document (kind, number, date,
  counterparty and its name at that moment, every line with serial, gas, movement, condition, confirmed
  warning, and the owner and periodic test where they were written; a correction's reason).
- A document too large for one transaction is split into parts (25 new cylinders, or 60 data writes, per
  part); the encrypted document travels in the last one. Before anything is signed the app checks the
  whole document against every limit: the encrypted document at most 16 KB (about 80 to 95 cylinders,
  depending on the codes' length), at most 15 parts (16 signatures with one fingerprint, the e-mail's
  included), the e-mail as the relayer will check it. A document over a limit is refused whole, with
  "split it into two documents" (review A04).
- Every part carries the document's **manifest** (review A11): `keccak256(abi.encode(docId, parts,
  partHashes))`, each part's hash being `hashPayload` of that part with `manifest` zero. The first part
  recorded fixes the document's signer, number of parts and manifest; a part that does not match is
  refused. `documentStatus(docId)` says how many parts are recorded: the admin page marks a document with
  fewer as incomplete; the phone sends the missing parts when it has network.
- A recorded document is never deleted. A cylinder's information is corrected by an owner's correction
  document, which stays in the cylinder's history with its reason. (`corrects`, naming an earlier
  document, is accepted by the contract; the app and the page do not use it.)

### 4.5 What the chain reveals

Public: that a register exists, its owner, how many cylinders it has, when documents are recorded and
how many cylinders each touches, which key signed, the data key's epoch, a pending handover and its new
owner. Not public: serials, gases, owners of cylinders, periodic tests, customers, numbers, locations,
conditions, e-mails. Every info value has the same encrypted size (221 bytes) and every state value too
(285 bytes), so their length says nothing (not even depot or customer); other values are padded to
fixed sizes.

What can still be inferred (review G-05), to tell a supplier plainly:
- everything public is **permanent**: the number of customers and refill plants (one data key each) and
  when they are added or removed; how many cylinders each document touches, when, and from which phone;
- each cylinder keeps the same token ID, so how often it moves can be followed for years, without
  knowing what it is or where;
- someone who knows one real event (a competitor who saw a delivery at a customer at 10:30) can link
  that document and its cylinders, and so follow that customer's later deliveries, and estimate their
  consumption;
- the phone that signs is public: once linked to a driver, their working times are visible (see the
  review's P-01 on employee monitoring).

Possible mitigations, not implemented: documents sent in batches (less precise times), dummy writes,
counterparty slots rotated, phone keys renewed periodically.

## 5. Encryption

- **Data key**: 32 random bytes. HKDF-SHA256 derives `encKey` (AES-256-GCM), `idKey` (HMAC for token,
  counterparty and document ids) and `cacheKey` (what the app keeps on the phone; never used on-chain).
- **Every value**: `0x01 | IV (12) | ciphertext | tag (16)` with the register's address, the entry id
  and the field name as associated data (a value copied to another cylinder or field does not decrypt);
  after a key replacement, `0x02 | epoch (2) | IV | ciphertext | tag`, the epoch in the associated data.
- **Password wrap** (`GCRKeyWrap:0`): the data key wrapped with a key from the data password
  (PBKDF2-SHA256, 600,000 iterations, random salt, bound to the register's address). The password is
  typed in the admin page (kept in the page's memory only) and once on each phone; it is never sent.
  Weak passwords are refused (a phrase of 20 or more characters, or 14 or more mixing letters, digits and
  symbols).
- **Recovery code** (`GCRKeyWrap:1`): 24 random words (256 bits, English or Italian list), shown once,
  wrapping the same data key. Random and long, it cannot be guessed offline as a chosen password could.
- **Key epochs** (review A05): the owner can replace the data key. The page makes a new key (epoch
  n + 1) with a new password and a new recovery code, and writes in one `SetData` the two new wraps,
  `GCRKeyEpoch` (n + 1) and `GCRKeyRing` (every older key, encrypted with the new one). Older values stay
  readable through the ring; values written afterwards use the new key. `idKey` always comes from the
  first key, so token IDs and document IDs never change. A phone or page holding an older key is told so
  when it opens (`KEY_REPLACED`): the owner types the new password on the phone, which seals what it
  keeps again with the new key. Whoever had an older key, password or recovery code reads nothing written
  after the replacement.
- **Phones do not keep the password**: the owner types it once on the phone, the app uses it to unwrap
  the data key and forgets it; the data key stays encrypted under an Android Keystore key unlocked by
  fingerprint or PIN.
- **Limits**: encrypted data on a public chain can be copied and attacked offline forever, hence the
  long password. Without the password and the recovery code the data cannot be read again.
- **Who holds the data key** (external review X-02, X-03, A05):
  - the register is created **without** its data key (review X-02): the operator page and
    `create-registry` set only its name and owner. At the first sign-in the owner's admin page makes the
    data key, asks the password, shows the 24 words once (two are checked, and the owner confirms having
    kept the password and the words) and writes both wraps with one owner-signed `SetData`; an owner
    using the command-line tools does the same with `init-keys`. So the key, the password and the 24
    words exist only in the owner's browser: ChainIntegrate never sees them. The first wraps are written
    once (`initializeKeys` refuses a second set); a later key comes only through a replacement;
  - every **authorized phone** holds the data key (protected by the Keystore);
  - the admin page's and the app's code, served by ChainIntegrate, handles the key in the browser: a
    compromised server could serve a page that sends it elsewhere.

| Case | What happens |
|---|---|
| **Change the password** | Admin page, Settings: a new password wrap of the same key. Phones keep working. The old wrap stays in the chain's history: a change, not a protection against someone who knew the old password. |
| **Password lost** | Admin page, "I lost the password": the 24 words open the data key, a new password is set. |
| **Both lost** | The data cannot be read again; a new register is the way out. |
| **Phone lost, driver leaves** | The owner revokes the phone: it can no longer write, and at its next unlock with network the app erases its keys and the data it kept (review A09). |
| **Someone may still read** (the password known, the 24 words seen, a revoked phone with its PIN) | Admin page, Settings, "Rare cases: changing the data key": a new key, password and recovery code; the phones ask for the new password. |
| **A new company** | Starts a new register (its own key, password, recovery code); nothing is copied. |

## 6. Contracts

`contracts/`, Solidity 0.8.28, on LUKSO's LSP8 (`@lukso/lsp8-contracts`) and OpenZeppelin (upgradeable
EIP712 for the clones). Not upgradeable. Sources verified on LUKSO's explorer (`scripts/verify-lukso.js`).

| Contract | Address (LUKSO mainnet) |
|---|---|
| `GasCylinderRegistryFactoryV2` | `0xd60146C03f288fCeEEdB90731f162fF57F7ebdd2` (block 8803983), owned by ChainIntegrate's Universal Profile `0x4a2605796e0d91A9667d6E30365aEEC384C48c27` |
| `GasCylinderRegistryV2` (implementation; registers are its clones) | `0xaC0D8EffB68C5FE9F291dd34570dD2f6c53026af` |

Version 1 (`GasCylinderRegistry.sol`, `GasCylinderRegistryFactory.sol`) served the demo until 2026-11 and
is no longer used by the app, the pages or the relayer (§6.4).

### 6.1 `GasCylinderRegistryFactoryV2`

- Only its owner calls `createRegistry(salt, owner, name, symbol)`, which deploys an EIP-1167 clone of
  the implementation at a predictable address (`predictRegistryAddress(salt)`) and initializes it with
  no data.
- `isRegistry(address)`, `registryCount()`, `registries(start, count)`: the relayer, the page, the app's
  setup and the extension's catalog accept only registers made here.
- It has no rights inside a register. `VERSION()` is 2.

### 6.2 `GasCylinderRegistryV2`

- An LSP8 collection (token ID format: unique id), owned by the supplier's account. `VERSION()` is 2.
- **Operators**: the drivers' phones (or any account), authorized by the owner.
- **Writes are signed operations** (EIP-712, domain `GasCylinderRegistry` version `2`, the register's
  address and chain id); anyone may submit them, the signature decides:
  - owner or operator: `recordDocument(payload, signer, validity, signature)`: mints the new cylinders
    to the owner, writes info and states, emits the document;
  - owner: `setOperatorSigned`, `setDataSigned` (key wraps and epochs, counterparties, settings, LSP4
    metadata), `transferOwnershipSigned`, `cancelOwnershipTransferSigned`;
  - the pending owner: `acceptOwnershipSigned`;
  - a signer for itself, or the owner for anyone: `cancelNoncesSigned`.
- **Direct paths closed**: `setData`, `setDataBatch`, `setDataForTokenId`, `setDataBatchForTokenIds` and
  `transferOwnership` revert (`UseSignedOperation`); `renounceOwnership` reverts (`RenounceDisabled`).
- **The owner's signatures** (review A01 / X-01): ERC-1271 for an account, and, when the owner is a
  contract, the key recovered from the signature must be an administrator of it: EDITPERMISSIONS in its
  LSP6 permissions (`AddressPermissions:Permissions:<key>`, read from the account), or the account's
  direct owner (`isAdministrator`). This holds for every owner operation, the owner's documents and
  cancellations included. An "access" key of the account, which has SIGN, is refused (`NotAdministrator`).
  Operators' signatures: `ecrecover` for keys, ERC-1271 for accounts.
- **Validity** (review G-07): every signature carries `{ nonce, validFrom, deadline }`; refused when
  expired, when `validFrom` is more than one hour ahead of the chain's clock, or when `deadline -
  validFrom` exceeds seven days. Nonces are unordered (a bitmap per signer, random 256-bit values), so
  documents queued offline need no order; `cancelNoncesSigned` marks unsent nonces used. The app signs
  documents for seven days, the owner tools and the admin page for one hour, both starting a minute
  before their clock.
- **Optimistic concurrency**: every token data write carries the hash of the value it replaces; if a
  cylinder changed meanwhile (two phones, an offline queue), the whole part is refused (`StaleValue`).
- **What a phone may write** (review A06): an operator writes `GCRInfo` only while it is empty
  (registering a cylinder: `InfoAlreadyRegistered` otherwise); only `GCRInfo` and `GCRState` are writable
  per token.
- **Documents** (review A11): the manifest, signer and number of parts fixed by the first part
  (`DocumentMismatch`); a part recorded once (`DocumentPartAlreadyRecorded`); `documentStatus(docId)`.
- **Ownership** (review A01): `transferOwnershipSigned(newOwner)` starts a handover, which the new owner
  accepts only 3 days later (`ownershipTransferReadyAt`); until then the owner cancels it. The event
  `OwnershipTransferStarted` lets the relayer alert (§7).
- **Tokens** always belong to the owner and cannot be transferred; after an ownership change,
  `syncHolders(tokenIds)` (anyone may call it) moves them to the new owner.
- The LSP4 name, symbol, token type and the LSP8 token ID format are read-only.

### 6.3 Gas

`scripts/gas-report.js` on the local network: a new cylinder about 510,000 gas (its information and
state), a movement about 75,000 to 80,000 gas per cylinder in a document of 10 to 25 cylinders; 25 new
cylinders about 12.7 million, under the relayer's 16 million cap for one transaction. The factory's
deployment was about 5.6 million.

### 6.4 Version 1 (the demo)

`GasCylinderRegistryFactory` `0xA128e7162fa8Dc779bf31EF569F06B53a499A50e` and its demo register served the
first demo (fictional data). Version 1 accepts any SIGN key of the owner's account, has no validity
window, no manifest, direct owner paths and an immediate two-step ownership transfer; its points are the
review's, closed by version 2. Its contracts and tests stay in the repository
(`test/GasCylinderRegistry.test.js`, with its own EIP-712 types); the app, the pages, the owner tools
and the relayer no longer use it, and its demo register no longer opens in the page.

## 7. The relayer and the e-mail

`relayer/relay.js` on ChainIntegrate's server, behind `https://gastrace.chainintegrate.it/gcr/`.
Details: [relayer/README.md](relayer/README.md).

- `POST /gcr/document` (a phone's document, with its e-mail), `POST /gcr/owner` (an owner operation, an
  owner's correction, a cancellation by a phone or the owner), `GET /gcr/status?hash=…`, `GET /gcr/info`.
- It accepts only registers of the configured factory and signers that are the owner or an operator
  (the owner only for a correction), simulates first (the register's refusal comes back by name and
  nothing is sent), sends one transaction at a time, returns the same transaction for the same
  operation, and limits requests per IP (before any call to the node) and operations per register per
  day (300 by default, counted only for operations it sends).
- It keeps a journal on disk (the last seven days' transactions, their states and the e-mails not yet
  sent), so that a restart loses nothing: it waits again for pending transactions and sends the e-mails
  left unsent (review A07).
- **Handover alerts**: it reads `OwnershipTransferStarted` from the chain every minute (also handovers
  not sent through it) and e-mails, in Italian and English, the register's alert addresses
  (`handoverAlerts` in its configuration, written by ChainIntegrate when it creates the register) and
  ChainIntegrate, so that an unwanted handover is cancelled within its 3 days.
- It holds only the LYX it spends and warns ChainIntegrate when its balance is low; it cannot forge or
  alter anything (without a valid signature the register refuses). At worst it fails to send.
- **E-mail**: the phone signs the e-mail's facts (recipients, language, company, customer, kind,
  number, date, cylinders, warnings) bound to the document's EIP-712 digest, with the same fingerprint
  as the document; the relayer writes the e-mail from its fixed template and sends it only after the
  document's transaction is confirmed (no free text, no attachment, at most 8 recipients, 100 e-mails
  per register per day: review G-03). Recipients: the customer's addresses, the supplier's, and up to
  three typed by the driver; the app enforces this, the relayer checks at most eight valid addresses
  signed by the phone (it cannot read the encrypted customer list). The relayer logs that an e-mail left
  and to how many people, never its content. The e-mail is plaintext in transit to the relayer: the one
  place where data leaves the encryption, by choice, so that its delivery can be checked.
- It announces the latest app release (`/gcr/info`, from a file on the server).

## 8. The app

`app/` (logic, interface, texts) and `android/` (Capacitor 8). Guide: [docs/app.md](docs/app.md).

- **Setup**: scan the register's setup code (QR on the admin page; the app checks the register is the
  factory's), create the phone key (fingerprint or PIN), the owner authorizes the phone's code from the
  admin page, the owner types the data password once.
- **A document**: pick the customer or refill plant, scan each cylinder (Google's ML Kit scanner, no
  camera permission) or type its code, adjust movement and condition; for a new cylinder give the gas,
  who owns it and its periodic test; for a cylinder back from refill tested, the new test; type the
  document number, send: one fingerprint signs every part and the e-mail.
- **Offline**: signed documents wait in "To send" and leave when the network returns or the service is
  free again; the last states read are kept for scanning without network. If the relayer has restarted
  and no longer knows a document, the app checks the network itself. A document refused (a cylinder
  changed meanwhile, the signature expired) can be made again from the cylinders' current state. A
  waiting document can be cancelled: the phone signs `CancelNonces` for its parts not sent yet (it needs
  the network), so that it can never be recorded.
- **A new data key**: when the owner replaced the data key, the app asks for the new password at the
  next opening and keeps its documents to send; the key epoch and ring are kept for working offline.
- **Keys** (`DeviceKeyPlugin.java`): the phone key and the data key, each encrypted under its own
  Android Keystore key usable only right after fingerprint or PIN; no backup of app data.

**On the phone** (review A09): the cached customer list and settings, the documents waiting to be sent
(with their e-mails) and a document left half-made are encrypted with `cacheKey`: nothing is readable
before the fingerprint or PIN. The app locks after 10 minutes unused or in the background; a phone that
finds itself revoked erases its keys and its data.

## 9. The admin page

`admin/`, served from `admin/www` at `https://gastrace.chainintegrate.it/`. Guide:
[docs/admin.md](docs/admin.md); users' guide: `admin/guida.html`, `admin/guide.html`.

The supplier signs in with the **ChainIntegrate Account** extension (up-onboarding), found through
EIP-6963; the page finds the registers owned by the account through the factory (and those being handed
over to it, to accept). An account without a register sees the activation request (§3). At the first
sign-in it prepares the data key (password, 24 words); afterwards it asks for the data password, and
shows overview, cylinders (owner, test expiry, filters for expired and expiring tests) with their
history and "Correct", documents (incomplete ones marked), customers and refill plants, phones,
settings (company, e-mails, years between tests, password, handover, rare cases: a new data key) and the
data download. It locks after 30 minutes unused. Cylinders and customers are read in parallel batches.

Each change is an EIP-712 request the extension describes by its kind and the owner confirms on an
administrator computer of the account (an access computer is refused and the page says so); the relayer
sends it. The extension serves the page only with the factory and the site set in its catalog
(`extension/shared/catalog.js` in up-onboarding, from extension 0.6.1 for version 2);
`scripts/admin-demo.js` checks every request of the page against that catalog.

The operator page (`operator.html`, ChainIntegrate only) creates a register with the factory owner's
Universal Profile.

## 10. Open points

- **Barcode format** of the real labels: the normalization rules may need adjusting (§4.1).
- **Refill plant documents**: what accompanies a cylinder sent to and back from refilling.
- **Registering from a computer** (an office entering a stock count): the register allows it (any
  operator), the admin page does not do it.
- **The collection on Universal Everything**: name, description, image and creators (LSP4 metadata,
  written by the owner).
- **Scale**: past several thousand cylinders, an indexer of the register's events instead of reading the
  logs from the page.
- **Export to the management software**: the admin page downloads the register as CSV (cylinders,
  movements, documents, customers); a format matching the supplier's management software is to agree
  with them.
- **A phone set up on a register no longer in use** (the version 1 demo): the next app update checks at
  start that the register is the factory's in use and offers "Set up again", which erases the phone's key
  and data. Today: clear the app's data in Android's settings.
- **Cancelling a lost phone's waiting documents**: the owner can cancel signatures only by their nonces,
  which only the phone knows; revoking the phone is what stops its documents.
- From the external review (2026-11-13, [docs/security-review-2026-11.md](docs/security-review-2026-11.md)):
  P-01 (privacy notices for drivers and customers, the processor agreement) and the operational points
  (X-04 distribution, X-05 server).
- From the verification of version 2 (2026-11-20), to fix: N-01 (the owner's correction described in the
  extension), N-02 (identifiers after a data key replacement), N-03 (reliable handover alerts), N-04
  (after a handover), N-05 (a phone taking a document number in advance), and the earlier A07, R02, A10,
  R-03, R-04, R-06, R-09: the list and their status in
  [docs/security-review-2026-11.md](docs/security-review-2026-11.md#verification-of-2026-11-20-version-2).

## 11. The external review's contract points

| Review | What version 2 does |
|---|---|
| A01 / X-01 | Every owner operation accepted only from a key with administrator permissions on the owner's account (EDITPERMISSIONS, read from LSP6), not from any SIGN key; the direct owner paths closed; a handover that waits 3 days and can be cancelled, with the relayer's e-mail alert. The extension (from 0.6.0) confirms the owner's requests only on administrator computers and limits access keys to the catalog's calls. |
| A05 / G-02 | A replaceable data key: key epochs and ring, new values under the new key, phones asked for the new password; identifiers kept on the first key. Whoever had an older key, password or recovery code reads nothing new. |
| A06 | A phone writes a cylinder's information only when registering it; corrections by the owner ("Correct": gas, litres, owner, periodic test, years between tests), kept in the cylinder's history with their reason. |
| A11 | A document's parts bound to a manifest, a signer and a number of parts, fixed by the first part; incomplete documents shown. |
| G-07 | Signatures valid for at most seven days from `validFrom`; unsent signatures cancellable (`cancelNoncesSigned`; the app's "Cancel"). |

The review's other points are handled outside the contracts (relayer, app, admin page, extension); the
record of each is in [docs/security-review-2026-11.md](docs/security-review-2026-11.md).
