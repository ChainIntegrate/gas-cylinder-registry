# Design

How GasTrace works, as implemented. Decisions are explained where they matter; what is left open is at
the end. The examples use the fictional supplier **Argonia Gas Tecnici**.

## 1. The problem

A supplier of technical gases (argon, acetylene, oxygen, nitrogen, CO₂) delivers full cylinders to its
customers and collects the empty ones. Every delivery comes with a delivery note (DDT) that lists one
line per cylinder but **no serial numbers**: the note is printed before loading, and the driver does not
tie specific cylinders to it in advance (a truck may carry ten argon cylinders, any of which can go to
any customer). At unloading, the driver used to write each cylinder's serial number (a text barcode) by
hand next to its line, and the same for the empty cylinders collected.

GasTrace replaces the handwriting: the driver scans the barcodes, the app knows each cylinder's last
state and links a collected cylinder to the customer that had it, every document is recorded on LUKSO,
encrypted, and an e-mail summary is sent.

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
  Universal Profile created with up-onboarding). An EOA works too (the contracts treat both alike).

## 3. Who does what

| Who | With what | Does |
|---|---|---|
| **The supplier** (register owner) | The admin page, signed in with the ChainIntegrate Account extension | Prepares the data key at the first sign-in (password, recovery code); customers and refill plants, drivers' phones, settings; sees cylinders, histories, documents; downloads the data |
| **A driver** (operator) | The GasTrace app, with a key kept on the phone | Stock counts, deliveries, collections, refills |
| **The relayer** | ChainIntegrate's server | Checks and sends signed operations, pays the gas, sends each document's e-mail |
| **ChainIntegrate** (factory owner) | Its Universal Profile (the operator page) and its command-line tools | Deploys the factory once, creates a register for each supplier (without its data key); no power inside a register |
| **Customers, refill plants** | Nothing | Encrypted entries of the register; they receive the e-mails |

## 4. Data

### 4.1 Cylinders

**Token ID** = `HMAC-SHA256(idKey, "cylinder:" + normalized serial)`. Whoever has the data key scans a
barcode, computes the token ID and reads the cylinder from the chain; anyone else sees random
identifiers and cannot enumerate serials (a plain hash of a short serial could be brute-forced). The
same cylinder has unrelated token IDs in two registers.

Serials are normalized (trimmed, inner spaces removed, upper case) and checked (3 to 40 characters,
letters, digits and `-./`): a misread code is refused rather than becoming a new cylinder
(`shared/crypto.js`, `normalizeSerial`). The labels' real format is still to be seen (section 10).

Per-token data, each value encrypted (section 5):

| Data key | Plaintext |
|---|---|
| `GCRInfo` | serial, gas, capacity (optional), owner of the cylinder (`supplier` or a counterparty id), registered at |
| `GCRState` | location (`depot`, or a customer or refill plant by id), condition (`full`, `empty`, `defective`), lifecycle (`active`, `retired`), last movement, scan time |

Every change emits LSP8's `TokenIdDataChanged` with the encrypted value: a cylinder's **history** is
rebuilt from the logs. The document and the signer of a change are in the same transaction's
`DocumentRecorded` event, not repeated in the state.

### 4.2 Movements

| Movement | Document | Location after | Condition |
|---|---|---|---|
| `stock_count` | stock count | the customer or refill plant counted | as found |
| `delivery` | delivery note | the customer | full (by default) |
| `collection` | delivery note | depot | empty by default; full or defective |
| `to_refill` | refill note | the refill plant | as found |
| `from_refill` | refill note | depot | full by default |

The app proposes the movement from the cylinder's last state and warns (the driver confirms, the e-mail
lists it) when it does not fit: a cylinder recorded at another customer, at a refill plant, retired, or
owned by someone else.

### 4.3 Customers, refill plants, settings

Stored in the register's own ERC725Y data, one entry each, encrypted:

- a counterparty: key LSP2 Mapping `bytes10(keccak256("GCRCounterparty")) + 0x0000 + id` (a random
  20-byte id); value `{ type: customer | refill, name, emails[], archived? }`, the heading the driver
  needs and the addresses that receive its documents' e-mails. Removing one archives it (the app no
  longer offers it), never erases it; each document also keeps the name it was made with (review A21).
- the settings: key `keccak256("GCRSettings")`; value `{ company, emails[] }`, the name shown by the app
  and the e-mails, and the supplier's own addresses, which receive a copy of every document.

Only the owner writes them (section 6.2); drivers pick from the list.

### 4.4 Documents

A document is what a driver closes: a delivery note, a stock count or a refill note, with all its
movements.

- `docId = HMAC(idKey, "doc:" + counterparty id + ":" + name)`, the name being
  `<kind>:<year of the document's date>:<number>` (a stock count, which has no number:
  `stock_count:<time>:<random>`): the contract refuses the same document twice, while numbering that
  starts again each year, or the same number in another kind of document, makes a different one (review
  A10; documents recorded before 2026-11-14 used the number alone).
- One transaction records the movements and emits `DocumentRecorded(docId, part, parts, signer,
  corrects, document)`, `document` being the encrypted document (number, date, counterparty and its
  name at that moment, every line with serial, gas, movement, condition and confirmed warning).
- A document too large for one transaction is split into parts (25 new cylinders, or 60 data writes, per
  part); the encrypted document travels in the last one. Before anything is signed the app checks the
  whole document against every limit: the encrypted document at most 16 KB (about 80 to 95 cylinders,
  depending on the codes' length), at most 15 parts (16 signatures with one fingerprint, the e-mail's
  included), the e-mail as the relayer will check it. A document over a limit is refused whole, with
  "split it into two documents", so no part is recorded without the others (review A04).
- A wrong document is never deleted: a later document can name it in `corrects`.

### 4.5 What the chain reveals

Public: that a register exists, its owner, how many cylinders it has, when documents are recorded and
how many cylinders each touches, which key signed. Not public: serials, gases, customers, numbers,
locations, conditions, e-mails. Every info and state value has the same encrypted size (221 bytes), so
its length says nothing (not even depot or customer); other values are padded to fixed sizes.

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

- **Data key**: 32 random bytes per register. HKDF-SHA256 derives `encKey` (AES-256-GCM) and `idKey`
  (HMAC for token, counterparty and document ids), and `cacheKey` for what the app keeps on the phone
  (never used on-chain).
- **Every value**: `version | IV (12) | ciphertext | tag (16)`, with the register's address, the entry id
  and the field name as associated data: a value copied to another cylinder or field does not decrypt.
- **Password wrap** (slot 0, `GCRKeyWrap:0`): the data key wrapped with a key from the data password
  (PBKDF2-SHA256, 600,000 iterations, random salt, bound to the register's address). The password is
  typed in the admin page (kept in the page's memory only) and once on each phone; it is never sent.
  Weak passwords are refused (a phrase of 20 or more characters, or 14 or more mixing letters, digits and
  symbols).
- **Recovery code** (slot 1, `GCRKeyWrap:1`): 24 random words (256 bits, English or Italian list), shown
  once, wrapping the same data key. Random and long, it cannot be guessed
  offline as a chosen password could.
- **Phones do not keep the password**: the owner types it once on the phone, the app uses it to unwrap
  the data key and forgets it; the data key stays encrypted under an Android Keystore key unlocked by
  fingerprint or PIN.
- **Limits**: encrypted data on a public chain can be copied and attacked offline forever, hence the
  long password. Without the password and the recovery code the data cannot be read again.
- **Who holds the data key** (external review X-02, X-03, A05):
  - the register is created **without** its data key (review X-02): the operator page and
    `create-registry` set only its name and owner. At the first sign-in the owner's admin page makes the
    data key, asks the password, shows the 24 words once (two are checked) and writes both wraps with
    one owner-signed `SetData`; an owner using the command-line tools does the same with `init-keys`.
    So the key, the password and the 24 words exist only in the owner's browser: ChainIntegrate never
    sees them. The wraps are written once: a register that has them refuses a second set
    (`initializeKeys`), since a new key would make the data written with the first unreadable. Until
    then the page shows only that step, and a phone set up meanwhile is told the owner must prepare the
    data first;
  - every **authorized phone** holds the data key (protected by the Keystore);
  - the admin page's and the app's code, served by ChainIntegrate, handles the key in the browser: a
    compromised server could serve a page that sends it elsewhere;
  - the data key **cannot be replaced yet**: changing the password re-wraps the same key (the old wrap
    stays in the chain's history), and a revoked phone, or whoever knew an old password or the recovery
    code, can still read everything, future data included. Key rotation is planned.

| Case | What happens |
|---|---|
| **Change the password** | From the admin page (Settings): a new slot 0. Phones keep working. The old wrap stays in the chain's history: a change, not a protection against someone who knew the old password. |
| **Password lost** | Admin page, "I lost the password": the 24 words open the data key, a new password is set. |
| **Both lost** | The data cannot be read again; a new register is the way out. |
| **Phone lost, driver leaves** | The owner revokes the phone: it can no longer write, and at its next unlock with network the app erases its keys and the data it kept (review A09). A phone never unlocked again still holds the data key: until the key can be rotated, use company phones and have a returned phone wiped. |
| **A new company** | Starts a new register (its own key, password, recovery code); nothing is copied. |

## 6. Contracts

`contracts/`, Solidity 0.8.28, on LUKSO's LSP8 (`@lukso/lsp8-contracts`) and OpenZeppelin. Not
upgradeable. Source verified on LUKSO's explorer (`scripts/verify-lukso.js`). This section describes
version 1, the contracts the app, the page and the relayer use today (the demo). Version 2
(`GasCylinderRegistryV2.sol`, `GasCylinderRegistryFactoryV2.sol`), for the first real supplier, is in
§10.1.

### 6.1 `GasCylinderRegistryFactory`

- Owned by ChainIntegrate's Universal Profile `0x4a2605796e0d91A9667d6E30365aEEC384C48c27` (deployed
  by ChainIntegrate's key, then handed over with `transfer-factory`); only the owner calls
  `createRegistry(salt, owner, name, symbol, dataKeys,
  dataValues)`, which deploys an EIP-1167 clone of one register implementation at a predictable address
  (`predictRegistryAddress(salt)`). Registers are now created with no data (`dataKeys` empty): the owner
  writes the key wraps at the first sign-in, bound to the register's address.
- `isRegistry(address)`, `registryCount()`, `registries(start, count)`: the relayer, the page and the
  extension's catalog accept only registers made here.
- It has no rights inside a register.

### 6.2 `GasCylinderRegistry`

- An LSP8 collection (token ID format: unique id), owned by the supplier's account.
- **Operators**: the drivers' phones (or any account), authorized by the owner.
- **Writes are signed operations** (EIP-712, domain `GasCylinderRegistry` version `1`, the register's
  address and chain id); anyone may submit them, the signature decides:
  - owner or operator: `recordDocument(payload, signer, nonce, deadline, signature)`: mints the new
    cylinders to the owner, writes info and states, emits the document;
  - owner: `setOperatorSigned`, `setDataSigned` (key wraps, counterparties, settings, LSP4 metadata),
    `transferOwnershipSigned` then `acceptOwnershipSigned` by the new owner. An owner with LYX can also
    call `setOperator`, `transferOwnership`, `acceptOwnership` directly. `renounceOwnership` is disabled.
- **Signatures**: `ecrecover` for keys, **ERC-1271** for accounts (a Universal Profile accepts a
  signature from its controllers with the SIGN permission). The ChainIntegrate Account extension
  (0.6.0) confirms the owner's requests only on an administrator computer of the account (review A01 /
  X-01); the register itself still accepts any SIGN key until version 2 (§10.1).
- **Optimistic concurrency**: every write carries the hash of the value it replaces; if a cylinder
  changed meanwhile (two phones, an offline queue), the whole document is refused (`StaleValue`).
- **Nonces** are unordered (a bitmap per signer, random 256-bit values): documents queued offline need
  no order. Each signature carries a deadline: the app uses seven days for documents, the owner tools
  and the admin page one hour; the register only checks it is not past (it sets no maximum, and an
  unsent signature cannot be cancelled: review G-07, planned with the next contract).
- **Tokens** always belong to the owner and cannot be transferred; after an ownership change,
  `syncHolders(tokenIds)` (anyone may call it) moves them to the new owner.
- The LSP4 name, symbol, token type and the LSP8 token ID format are read-only.

**Gas** (`scripts/gas-report.js`): a new cylinder about 460,000 gas, a movement of a known one about
60,000; 25 new cylinders about 11.5 million, under the 16.7 million cap of one transaction.

## 7. The relayer and the e-mail

`relayer/relay.js` on ChainIntegrate's server, behind `https://gastrace.chainintegrate.it/gcr/`.

- `POST /gcr/document` (a phone's document, with its e-mail), `POST /gcr/owner` (an owner operation),
  `GET /gcr/status?hash=…`, `GET /gcr/info`.
- It accepts only registers of the factory and signers that are the owner or an operator, simulates
  first (the register's refusal comes back by name and nothing is sent), sends one transaction at a
  time, returns the same transaction for the same operation, and limits requests per IP (before any
  call to the node) and operations per register per day (counted only for operations it sends).
- It keeps a journal on disk (the last seven days' transactions, their states and the e-mails not yet
  sent), so that a restart loses nothing: it waits again for pending transactions and sends the e-mails
  left unsent (review A07).
- It holds only the LYX it spends; it cannot forge or alter anything (without a valid signature the
  register refuses). At worst it fails to send.
- **E-mail**: the phone signs the e-mail's facts (recipients, language, company, customer, kind,
  number, date, cylinders, warnings) bound to the document's EIP-712 digest, with the same fingerprint
  as the document; the relayer writes the e-mail from its fixed template and sends it only after the
  document's transaction is confirmed (no free text, no attachment, at most 8 recipients, a daily
  limit per register: review G-03). Recipients: the customer's addresses, the supplier's, and up to
  three typed by the driver; the app enforces this, the relayer checks at most eight valid addresses
  signed by the phone (it cannot read the encrypted customer list). The relayer logs that an e-mail left
  and to how many people, never its content. The e-mail is plaintext in transit to the relayer: the one place where data leaves
  the encryption, by choice, so that its delivery can be checked.

## 8. The app

`app/` (logic, interface, texts) and `android/` (Capacitor 8, like UP Wallet for Android). Guide:
[docs/app.md](docs/app.md).

- **Setup**: scan the register's setup code (QR on the admin page), create the phone key (fingerprint or
  PIN), the owner authorizes the phone's code from the admin page, the owner types the data password
  once.
- **A document**: pick the customer, scan each cylinder (Google's ML Kit scanner, no camera permission)
  or type its code, adjust movement and condition, give the gas of new cylinders, type the delivery
  note number, send: one fingerprint signs every part and the e-mail.
- **Offline**: signed documents wait in "To send" and leave when the network returns or the service is
  free again; the last states read are kept for scanning without network. If the relayer has restarted
  and no longer knows a document, the app checks the network itself. A document refused (a cylinder
  changed meanwhile, the signature expired) can be made again from the cylinders' current state.
- **Keys** (`DeviceKeyPlugin.java`): the phone key and the data key, each encrypted under its own
  Android Keystore key usable only right after fingerprint or PIN; no backup of app data.

**On the phone** (review A09): the cached customer list and settings, the documents waiting to be sent
(with their e-mails) and a document left half-made are encrypted with a key derived from the data key
(`cacheKey`, HKDF, never used on-chain): nothing is readable before the fingerprint or PIN. The app
locks after 10 minutes unused or in the background; a phone that finds itself revoked erases its keys
and its data.

## 9. The admin page

`admin/`, served from `admin/www` at `https://gastrace.chainintegrate.it/`. Guide:
[docs/admin.md](docs/admin.md).

The supplier signs in with the **ChainIntegrate Account** extension (up-onboarding), found through
EIP-6963; the page finds the registers owned by the account through the factory. At the first sign-in
it prepares the data key (password, 24 words); afterwards it asks for the data password, and shows
overview, cylinders with their history, documents, customers, phones, settings and the data download.
It locks after 30 minutes unused. Each change is an EIP-712 request the extension describes (from 0.5.1
by its kind: password, customers, settings…) and the owner confirms on an administrator computer of the
account (from 0.6.0; an access computer is refused and the page says so); the relayer sends it. The
extension serves the page only with the factory and the site set in its catalog
(`extension/shared/catalog.js` in up-onboarding); `scripts/admin-demo.js` checks every request of the
page against that catalog.

## 10. Open points

- **Barcode format** of the real labels: the normalization rules may need adjusting (section 4.1).
- **Refill plant documents**: what accompanies a cylinder sent to and back from refilling.
- **Registering from a computer** (an office entering a stock count): the register allows it (any
  operator), the admin page does not do it yet.
- **The collection on Universal Everything**: name, description, image and creators (LSP4 metadata,
  written by the owner, no new contract).
- **Scale**: past a few thousand cylinders, an indexer of the register's events (Envio) instead of
  reading the logs from the page.
- **Other computers on an account**: the extension authorizes them as administrator or access
  computers; from 0.6.0 only an administrator computer confirms GasTrace's owner requests, and an access
  key is limited to the catalog's calls (CALL with AllowedCalls; GasTrace makes no direct calls from the
  account). An access key still has SIGN and, outside the extension, could sign the register's owner
  operations (ERC-1271): accepted for the demo, closed by version 2 (§10.1, A01 / X-01).
- **Export to the management software**: the admin page downloads the register as CSV (cylinders,
  movements, documents, customers); a format matching the supplier's invoicing software is to agree
  with them.

### 10.1 Before real use: version 2 of the contracts

Version 1 serves the demo (Argonia Gas Tecnici, fictional data) and stays as it is; its factory creates
no new registers. Version 2 has the points of the external review (2026-11-13) that need a contract
change: `contracts/GasCylinderRegistryV2.sol` and `contracts/GasCylinderRegistryFactoryV2.sol`, tested in
`test/GasCylinderRegistryV2.test.js` (the owner as a key and as a real LUKSO account, LSP0 with an LSP6
Key Manager, with an administrator and an access key as the extension makes them). Its factory is
deployed on its own (DEPLOY.md, "Version 2"): `0xd60146C03f288fCeEEdB90731f162fF57F7ebdd2` (block 8803983, 2026-11-17),
implementation `0xaC0D8EffB68C5FE9F291dd34570dD2f6c53026af`, owned by ChainIntegrate's profile; the app, the admin page, the operator page, the relayer and
the extension's catalog move to it before the first supplier's register (the list below). Registers are
clones and cannot be upgraded: a supplier starts on a version 2 register.

What version 2 does:

- **Signatures**: every one carries `nonce`, `validFrom` and `deadline` (a `Validity` tuple), with
  `deadline - validFrom` at most 7 days and `validFrom` at most an hour ahead of the chain's clock. EIP-712
  domain `GasCylinderRegistry` version `2`: no version 1 signature is valid. `cancelNoncesSigned`: a phone
  cancels its own unsent signatures by their nonces, the owner anyone's.
- **The owner's signatures**: when the owner is a contract account, the key that signed (recovered from
  the signature) must be an administrator of it: EDITPERMISSIONS in its LSP6 permissions, read from the
  account (`isAdministrator`), or the account's direct owner. This holds for every owner operation:
  phones, data (key wraps, customers, settings), documents the owner signs, nonce cancellation, ownership.
  The direct `onlyOwner` paths of LSP8 and ERC725Y (`setData`, `setDataBatch`, `setDataForTokenId`,
  `setDataBatchForTokenIds`, `transferOwnership`, the direct `setOperator`) are closed
  (`UseSignedOperation`).
- **Ownership**: `transferOwnershipSigned` starts a transfer; the new owner accepts it
  (`acceptOwnershipSigned`, an administrator key of it) only after 3 days (`ownershipTransferReadyAt`);
  in between the owner cancels it with `cancelOwnershipTransferSigned`. The relayer will e-mail the
  owner when `OwnershipTransferStarted` is emitted.
- **Phones and cylinder information**: an operator writes `GCRInfo` only while it is empty (registering a
  cylinder); a registered cylinder's information is corrected by the owner, with a document (`corrects`
  the earlier one) that stays in the history.
- **Documents**: `DocumentPayload` gains `manifest` (not zero). The first recorded part fixes the
  document's signer, number of parts and manifest; every other part must match (`DocumentMismatch`).
  `documentStatus(docId)` gives signer, parts, parts recorded and manifest: fewer recorded than parts is
  an interrupted document. The manifest the app computes: `keccak256(abi.encode(docId, parts,
  partHashes))`, each part's hash being `hashPayload` of that part with `manifest` zero.
- **The factory** creates registers with no data: `createRegistry(salt, owner, name, symbol)`.
  `VERSION()` is 2 in both contracts.

To do before the first supplier's register (the work after the deployment):

- `shared/`: version 2's EIP-712 types (`validFrom`, the `Validity` tuple, the new operations) and the
  manifest; A05's key epochs (below).
- The app: `validFrom` in each signature, the manifest, the interrupted documents, cancelling a waiting
  document, a phone receiving a new data key.
- The cylinder's owner (`GCRInfo.owner`: the supplier or a customer). Today the app always writes
  `supplier` and no tool lets anyone choose or change it. In the app, when a new cylinder is registered:
  "ours" or "the customer's", proposing the document's customer (the delivery's customer, or where the
  stock is counted). In the admin page, the "Correct" button also changes it. No contract change: the
  register stores the information encrypted and never reads it; version 2 already lets a phone write it
  only at registration and the owner correct it (A06). The guides and the tests follow.
- The admin page: the "Correct" button, the ownership transfer with its wait and cancellation, the new
  data key (A05), cancelling a phone's waiting documents, interrupted documents.
- The operator page and the owner tools: `createRegistry` with four arguments, the version 2 factory.
- The relayer: version 2's ABI and factory, the e-mail when an ownership transfer starts.
- The extension's catalog (up-onboarding): version 2's requests and factory.

| Review | What version 2 changes |
|---|---|
| A01 / X-01 | Every owner operation accepted only from a key with administrator permissions on the owner's account (EDITPERMISSIONS), read from the account (LSP6), not from any SIGN key; the direct owner paths closed; an ownership transfer that waits 3 days and can be cancelled, with an e-mail alert from the relayer. The extension's side is done in up-onboarding 0.6.0: owner requests confirmed only on administrator computers, access keys limited to the catalog's calls. |
| A05 / G-02 | A replaceable data key: key epochs, new values under the new key, the remaining phones given it again; identifiers (token IDs, document IDs) kept on a separate, stable key. A revoked phone, or an old password or recovery code, then no longer reads new data. No contract change: each epoch's key wraps are owner data (`setDataSigned`, administrator keys only); the work is in `shared/`, the app and the admin page. |
| A06 | What a phone may write: movements of existing cylinders and new cylinders, not the information of a cylinder already registered. Corrections stay possible, by the owner: a "Correct" button in the admin page (a cylinder's gas, litres, owner), signed in the extension and kept in the cylinder's history. Today no tool offers it (the app writes a cylinder's information only when it registers it). |
| A11 | A document's parts bound to a manifest (document ID, number of parts, every part's hash), a signer and a number of parts, fixed by the first recorded part; parts that do not match are refused, and `documentStatus` shows an interrupted document. |
| G-07 | A maximum validity for signatures (seven days from `validFrom`) checked by the contract, and `cancelNoncesSigned` for the owner and the phones to cancel an unsent signature. |

The other points of the review are handled outside the contracts (relayer, app, admin page, extension):
see the commits that name them (G-03 e-mails from a template, A07 the relayer's journal and A09 the
phone's encrypted data and idle locks included). Still open there: P-01 (privacy notices for drivers
and customers, the processor agreement) and the operational points (X-04 distribution, X-05 server).
