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
  LUKSO, encrypted with a key only the supplier holds. The chain is the database: no server keeps the
  data.
- **No friction, no LYX.** The supplier and the drivers only sign; the relayer sends and pays the gas.
  Nobody at the supplier ever holds or sees LYX, and no screen uses technical words.
- **One register per company.** A factory creates identical, independent registers; the same app,
  page and relayer serve them all.
- **The supplier's own account.** The register's owner is the supplier's ChainIntegrate account (a
  Universal Profile created with up-onboarding). An EOA works too (the contracts treat both alike).

## 3. Who does what

| Who | With what | Does |
|---|---|---|
| **The supplier** (register owner) | The admin page, signed in with the ChainIntegrate Account extension | Customers and refill plants, drivers' phones, settings, the data password; sees cylinders, histories, documents |
| **A driver** (operator) | The GasTrace app, with a key kept on the phone | Stock counts, deliveries, collections, refills |
| **The relayer** | ChainIntegrate's server | Checks and sends signed operations, pays the gas, sends each document's e-mail |
| **ChainIntegrate** (factory owner) | Its command-line tools and key | Deploys the factory, creates a register for each supplier; no power inside a register |
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
  20-byte id); value `{ type: customer | refill, name, emails[] }`, the heading the driver needs and the
  addresses that receive its documents' e-mails. Removing one writes an empty value; its past documents
  keep its id.
- the settings: key `keccak256("GCRSettings")`; value `{ company, emails[] }`, the name shown by the app
  and the e-mails, and the supplier's own addresses, which receive a copy of every document.

Only the owner writes them (section 6.2); drivers pick from the list.

### 4.4 Documents

A document is what a driver closes: a delivery note, a stock count or a refill note, with all its
movements.

- `docId = HMAC(idKey, "doc:" + counterparty id + ":" + document number)` (a stock count's number is
  `STOCK-<time>`): the contract refuses the same document twice.
- One transaction records the movements and emits `DocumentRecorded(docId, part, parts, signer,
  corrects, document)`, `document` being the encrypted document (number, date, counterparty, every
  line with serial, gas, movement, condition and confirmed warning).
- A document too large for one transaction is split into parts (25 new cylinders, or 60 data writes, per
  part); the encrypted document travels in the last one.
- A wrong document is never deleted: a later document can name it in `corrects`.

### 4.5 What the chain reveals

Public: that a register exists, its owner, how many cylinders it has, when documents are recorded and
how many cylinders each touches, which key signed. Not public: serials, gases, customers, numbers,
locations, conditions, e-mails. Every info and state value has the same encrypted size (221 bytes), so
its length says nothing (not even depot or customer); other values are padded to fixed sizes.

## 5. Encryption

- **Data key**: 32 random bytes per register. HKDF-SHA256 derives `encKey` (AES-256-GCM) and `idKey`
  (HMAC for token, counterparty and document ids).
- **Every value**: `version | IV (12) | ciphertext | tag (16)`, with the register's address, the entry id
  and the field name as associated data: a value copied to another cylinder or field does not decrypt.
- **Password wrap** (slot 0, `GCRKeyWrap:0`): the data key wrapped with a key from the data password
  (PBKDF2-SHA256, 600,000 iterations, random salt, bound to the register's address). The password is
  typed in the admin page (kept in the page's memory only) and once on each phone; it is never sent.
  Weak passwords are refused (a phrase of 20 or more characters, or 14 or more mixing letters, digits and
  symbols).
- **Recovery code** (slot 1, `GCRKeyWrap:1`): 24 random words (256 bits, English or Italian list), shown
  once when the register is created, wrapping the same data key. Random and long, it cannot be guessed
  offline as a chosen password could.
- **Phones never learn the password**: the owner types it once on the phone, the app unwraps the data
  key and keeps it encrypted under an Android Keystore key unlocked by fingerprint or PIN.
- **Limits**: encrypted data on a public chain can be copied and attacked offline forever, hence the
  long password. Nobody, ChainIntegrate included, keeps a copy of the data key: without the password and
  the recovery code the data cannot be read again.

| Case | What happens |
|---|---|
| **Change the password** | From the admin page (Settings): a new slot 0. Phones keep working. The old wrap stays in the chain's history: a change, not a protection against someone who knew the old password. |
| **Password lost** | Admin page, "I lost the password": the 24 words open the data key, a new password is set. |
| **Both lost** | The data cannot be read again; a new register is the way out. |
| **Phone lost, driver leaves** | The owner revokes the phone: it can no longer write. |
| **A new company** | Starts a new register (its own key, password, recovery code); nothing is copied. |

## 6. Contracts

`contracts/`, Solidity 0.8.28, on LUKSO's LSP8 (`@lukso/lsp8-contracts`) and OpenZeppelin. Not
upgradeable. Source verified on LUKSO's explorer (`scripts/verify-lukso.js`).

### 6.1 `GasCylinderRegistryFactory`

- Owned by ChainIntegrate's key; only it calls `createRegistry(salt, owner, name, symbol, dataKeys,
  dataValues)`, which deploys an EIP-1167 clone of one register implementation at a predictable address
  (`predictRegistryAddress(salt)`: the key wraps written at creation are bound to that address).
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
  signature from its controllers with the SIGN permission).
- **Optimistic concurrency**: every write carries the hash of the value it replaces; if a cylinder
  changed meanwhile (two phones, an offline queue), the whole document is refused (`StaleValue`).
- **Nonces** are unordered (a bitmap per signer, random 256-bit values): documents queued offline need
  no order. Deadline: seven days.
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
  time, returns the same transaction for the same operation, and limits requests per IP and operations
  per register per day.
- It holds only the LYX it spends; it cannot forge or alter anything (without a valid signature the
  register refuses). At worst it fails to send.
- **E-mail**: the phone signs the e-mail (recipients, subject, text) bound to the document's EIP-712
  digest, with the same fingerprint as the document; the relayer sends exactly that e-mail, and only
  after the document's transaction is confirmed. Recipients: the customer's addresses, the supplier's,
  and up to three typed by the driver. The relayer logs that an e-mail left and to how many people,
  never its content. The e-mail is plaintext in transit to the relayer: the one place where data leaves
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
- **Offline**: signed documents wait in "To send" and leave when the network returns; the last
  states read are kept for scanning without network. If the relayer has restarted and no longer knows a
  document, the app checks the network itself.
- **Keys** (`DeviceKeyPlugin.java`): the phone key and the data key, each encrypted under its own
  Android Keystore key usable only right after fingerprint or PIN; no backup of app data.

## 9. The admin page

`admin/`, served from `admin/www` at `https://gastrace.chainintegrate.it/`. Guide:
[docs/admin.md](docs/admin.md).

The supplier signs in with the **ChainIntegrate Account** extension (up-onboarding), found through
EIP-6963; the page finds the registers owned by the account through the factory, asks for the data
password, and shows overview, cylinders with their history, documents, customers, phones and settings.
Each change is an EIP-712 request the extension describes and the owner confirms; the relayer sends it.
The extension serves the page only with the factory and the site set in its catalog
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
- **Second device on an account**: the ChainIntegrate Account extension will add a key to an account
  (up-onboarding's backlog); GasTrace needs nothing for it.
