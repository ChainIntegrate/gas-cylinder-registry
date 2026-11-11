# Design

Status: **draft for review**. Nothing here is implemented yet. This document fixes the structure before
any code is written; open points are listed at the end.

The examples use a fictional supplier, **Argonia Gas Tecnici**. Real company names never appear in this
repository: not in code, tests, fixtures, commits or pull requests.

## 1. The problem

A supplier of technical gases (argon, acetylene, oxygen, nitrogen, CO₂) delivers full cylinders to its
customers and collects the empty ones. Today every delivery comes with a delivery note (DDT) that lists
one line per cylinder but **no serial numbers**: the note is printed before loading, and the driver does
not want to tie specific cylinders to it in advance (a truck may carry ten argon cylinders, any of which
can go to any customer). At unloading, the driver writes each cylinder's serial number (a text barcode)
by hand next to its line, and does the same for the empty cylinders collected.

The goal: replace the handwriting with an app that scans the barcodes, knows each cylinder's last
state, links a collected cylinder to the customer that had it, and records every operation on LUKSO,
encrypted, then e-mails a summary.

## 2. Principles

- **One cylinder, one token.** Each cylinder is an LSP8 token in the supplier's own collection.
- **Everything on-chain, encrypted.** Cylinder data, states, counterparties and documents live on
  LUKSO, encrypted with a key that only the supplier controls. The chain is the database: no server is
  needed to know where a cylinder is.
- **No friction, no LYX.** Nobody at the supplier ever holds or manages LYX. People sign; ChainIntegrate's
  relayer sends the transactions and pays the gas.
- **EOA today, Universal Profile tomorrow.** The owner of a registry can be an EOA (the demo) or a
  Universal Profile (including profiles created on ChainIntegrate's own domains). The contracts treat
  both the same way.
- **One registry per company.** A factory creates identical, independent registries; the same app and
  the same relayer serve them all.
- **Scales with unknown volumes.** One transaction per document (split automatically when large), one
  read per scan, history from logs, an indexer only when needed.

## 3. Actors

| Actor | Who | Does |
|---|---|---|
| **Owner** | The gas supplier (demo: an EOA created and held by ChainIntegrate; later the supplier's own EOA or UP) | Holds the tokens and the registry; authorizes operators; holds the data key |
| **Operator** | A driver's phone (its own key) | Registers cylinders, records movements and documents; cannot transfer tokens or change operators |
| **Relayer** | ChainIntegrate's server | Checks and sends signed operations, pays the gas, sends the e-mail |
| **Factory owner** | ChainIntegrate | Creates registries; has no power over a registry's data |
| **Counterparties** | Customers and refill plants | Exist only as encrypted records and e-mail recipients; they use nothing |

## 4. Data model

### 4.1 Cylinder (one LSP8 token)

**tokenId** = `HMAC-SHA256(idKey, "cylinder:" + normalizedSerial)`, a `bytes32`.
Whoever has the key scans a barcode, computes the tokenId and reads the cylinder straight from the
chain. Whoever does not sees random identifiers and cannot enumerate serial numbers (a plain hash of a
short serial could be brute-forced; an HMAC cannot without the key).

Per-token data (LSP8 `getDataForTokenId`), each value encrypted (section 5):

| Data key | Plaintext content | Changes |
|---|---|---|
| `GCRInfo` | serial, gas, capacity (optional), owner of the cylinder (`supplier` or a counterparty id), registered at | Rarely (registration, correction) |
| `GCRState` | location, condition, last movement type, counterparty id, document id, scan time (device clock), operator | Every movement |

Every change emits LSP8's `TokenIdDataChanged` with the encrypted value, so the **full history** of a
cylinder is rebuilt from the logs; nothing else stores it.

### 4.2 State

Three independent fields instead of a fixed list of states:

| Field | Values |
|---|---|
| **Location** | `depot` · `customer:<id>` · `refill:<id>` |
| **Condition** | `full` · `empty` · `defective` |
| **Lifecycle** | `active` · `retired` |

### 4.3 Movements

| Movement | From → To | Condition after |
|---|---|---|
| `delivery` | depot → customer | full |
| `collection` | customer → depot | empty, full or defective |
| `to_refill` | depot → refill plant | as found (usually empty or defective) |
| `from_refill` | refill plant → depot | full or defective |
| `defect` | stays where it is | defective |
| `retire` | stays where it is | lifecycle `retired` (the token is kept, never burnt: history stays) |

A cylinder **owned by a customer** follows the same movements; the app warns when it is about to be
delivered to anyone other than its owner.

### 4.4 Counterparties

Customers and refill plants share one encrypted directory, stored in the registry's own ERC725Y data
(one entry per counterparty, so adding one never rewrites the others):

- key: LSP2 Mapping `GCRCounterparty:<bytes20 id>`, with `id = HMAC(idKey, "cp:" + uuid)` truncated;
- value: encrypted `{ type: customer|refill, name, emails[] }`: only the heading the driver needs to
  recognize the counterparty, and the optional addresses that receive the e-mail. Nothing else is kept.

Counterparties are managed **by the owner only**, with the owner tools (section 8.5); the driver picks
from the list and cannot add one. The demo has two customers.

### 4.5 Documents

A document is the unit an operator closes: one DDT (or the refill plant's equivalent) with all the
movements made under it. It is recorded once, in the same transaction as its movements:

- `docId = HMAC(idKey, "doc:" + counterpartyId + ":" + documentNumber)`: the contract refuses the same
  `docId` twice, so a document cannot be recorded twice by mistake;
- event `DocumentRecorded(bytes32 indexed docId, bytes encryptedDocument, address indexed signer)`;
  the encrypted document holds the number, date, counterparty, the list of movements and the per-gas
  totals (what the e-mail shows);
- a wrong document is **corrected, never deleted**: `DocumentCorrected(docId, encryptedCorrection,
  reason)`, the original stays in the history.

### 4.6 What the chain reveals

Public: that a registry exists, how many cylinders it has, when documents are recorded and how many
cylinders each touches, which operator key signed. Not public: serials, gases, customers, document
numbers, locations, conditions. Value lengths are padded to fixed buckets so that a ciphertext's length
does not reveal its content.

## 5. Encryption

- **Data key (DEK)**: 32 random bytes per registry, created by the owner. Two subkeys are derived with
  HKDF-SHA256: `encKey` (AES-256-GCM) and `idKey` (HMAC for tokenIds, counterparty ids, document ids).
- **Password wrap**: the owner's password, through PBKDF2-SHA256 (600,000 iterations, random salt,
  registry address as context), gives a key-encryption key that wraps the DEK. The wrapped DEK is
  stored on-chain in the registry's data (`GCRKeyWrap:<slot>`). Changing the password rewrites only the
  wrap; a new owner (the supplier taking over) gets the same DEK wrapped with *their* password, and all
  history stays readable.
- **Every value**: `version (1) | IV (12) | ciphertext | tag (16)`, AES-256-GCM, with the registry
  address, the tokenId (or entry id) and the data key name as associated data, so a ciphertext cannot
  be moved to another cylinder or field without failing.
- **Operators never learn the password.** At enrollment the owner types the password once on the
  driver's phone; the app unwraps the DEK and keeps it encrypted under an Android Keystore key unlocked
  by fingerprint or PIN (the same approach as UP Wallet's phone key). The driver uses the app, never
  the password.
- **Limits, stated plainly.** Encrypted data on a public chain can be copied and attacked offline
  forever: the password must be long (a phrase). Revoking an operator stops it from writing, but a
  phone that held the DEK could still read; if a phone is compromised, the owner rotates the DEK
  (new key, current states re-encrypted; older history stays under the old key).

## 6. Contracts

Built on LUKSO's LSP8 (`@lukso/lsp8-contracts`) and ownership (LSP14). Not upgradeable: a new version
is a new factory, and registries are migrated explicitly.

### 6.1 `GasCylinderRegistry` (one per company)

- LSP8 collection, tokenId format unique id (`bytes32`); name and symbol set at creation; LSP4 metadata
  (name, description, images) editable by the owner.
- **Owner**: the company's EOA or UP (LSP14 two-step ownership).
- **Operators**: a set of addresses authorized by the owner.
- **Tokens**: minted to the owner; not transferable, except by the owner to a new owner during a
  migration (in chunks, with `force = true` so that an EOA can receive them).
- **Writes** go through signed operations only (section 7); anyone may submit them, the signature
  decides who acts:
  - operator or owner: `registerCylinders`, `recordDocument` (mints + state updates + the document event
    in one call), `correctDocument`;
  - owner only: `addOperator`, `removeOperator`, `setKeyWrap`, `setCounterparty`, `setMetadata`,
    `migrateTokens`.
- **Optimistic concurrency**: each state update carries the hash of the state it expects to replace.
  If the cylinder changed in between (two phones, or an offline queue sent out of order), the whole
  operation reverts and the app shows the conflict, so a newer state is never overwritten by an older
  one.

### 6.2 `GasCylinderRegistryFactory` (one, owned by ChainIntegrate)

- `createRegistry(owner, name, symbol, initialKeyWrap)` deploys a registry and records it.
- `isRegistry(address)`: the relayer and the app only work with registries the factory created, so
  a look-alike contract cannot spend the relayer's gas.
- The factory owner has no rights inside a registry.

## 7. Signed operations and the relayer

### 7.1 Signatures

- **EIP-712**, domain = registry address + chain id (42 on mainnet).
- Operator operations (the app's own key): the typed data is `{ kind, payloadHash, nonce, deadline }`,
  where `payloadHash` is the hash of the ABI-encoded payload. The signer is the app itself, so wallet
  readability does not matter here.
- Owner operations (adding an operator, migrating): fully typed structs, so that an owner signing in a
  wallet (UP Wallet, the UP Browser Extension, the UP! App) reads exactly what they approve.
- **Verification**: `ecrecover` for EOAs, **ERC-1271** for Universal Profiles (the UP's own signature
  check: any controller with the SIGN permission). Same code path for demo and production.
- **Unordered nonces** (a bitmap per signer): operations queued offline do not have to arrive in order.
- **Deadline**: long enough for an offline queue (default 7 days).

### 7.2 Relayer (`relayer/`)

Node.js, stateless apart from its logs. Built from the experience of Cross_Chain's relayer and
cross-chain-sponsor's limits.

1. `POST /v1/operations` with `{ registry, operation, signature, mail? }`.
2. Checks: the registry comes from the factory; the signer is the owner or an operator (read from the
   chain); the operation simulates successfully; per-registry limits (operations per day, cylinders
   per operation).
3. Sends the transaction from its hot wallet, pays the gas, waits for confirmation, returns the hash.
4. E-mail (7.3), only after confirmation.

The relayer **cannot forge or alter** anything: without a valid signature the contract refuses, and the
payload is encrypted. At worst it can fail to send; any account with LYX can then submit the same
signed operation directly.

Gas is paid by ChainIntegrate (a fraction of a cent per document on LUKSO) and can later be billed
in the service fee. The relayer alerts when its wallet runs low.

### 7.3 E-mail

Sent by the relayer, so that there is a record that it left:

- the app sends, with the operation, the recipients (from the encrypted directory, plus at most three
  typed by the driver for that document) and the plaintext
  summary over HTTPS; the relayer binds it to the operation's hash and sends it **only after the
  transaction is confirmed**;
- content: supplier, counterparty, document number and date, delivered and collected cylinders per
  gas (with serials), anomalies confirmed by the driver, a link to the transaction on the explorer;
  optionally a PDF of the same;
- the relayer keeps a log of *that* a mail was sent (operation hash, number of recipients, time,
  outcome), never its content or addresses;
- if sending fails, the app is told and offers to send the same summary from the phone.

The plaintext is seen by the relayer only in transit. This is the one place where data leaves the
encryption boundary, by choice, to make delivery verifiable.

## 8. The app (`app/`)

Android, built with Capacitor; Italian and English with a language switch in the header.

### 8.1 Setup (once per phone)

1. The app creates its own key (secp256k1, encrypted under an Android Keystore key, unlocked by
   fingerprint or PIN) and shows its address.
2. The owner authorizes that address as an operator (signed, sent through the relayer).
3. The owner types the registry password once; the app unwraps and keeps the DEK (section 5).

### 8.2 A document

1. **New document**: the counterparty, picked from the owner's list. The document number can be typed
   now or at any time before closing.
2. **Scan loop**, continuous camera, one beep per accepted code. For each barcode:
   - the app normalizes it, computes the tokenId and reads `GCRInfo` / `GCRState` (one RPC call);
   - **unknown cylinder**: asks the gas (and optional capacity, ownership), registers it at the depot and
     proposes `delivery`; the driver can switch to `collection` (a cylinder never seen before, found at
     the customer);
   - **known cylinder**: shows gas and last state and proposes the movement:
     at the depot → `delivery`; at this customer → `collection` (asks the condition: empty by default,
     full, defective);
   - **anomalies**, each to be confirmed explicitly and reported in the e-mail: collecting a cylinder
     recorded at another customer; delivering one already at a customer; delivering a customer-owned
     cylinder to someone else; a retired cylinder; the same code scanned twice.
3. **Summary per gas**: delivered and collected, to compare with the printed DDT lines.
4. **Document number**, if not typed yet, and **e-mail recipients**: the counterparty's addresses and
   the owner's are filled in from the directory; the driver can add up to three more addresses for this
   document only (they are not saved).
5. **Close**: the app builds the operation (registrations, state updates with expected previous states,
   the encrypted document), signs it, sends it to the relayer with the e-mail, and shows the outcome.
   Large documents are split into several operations under the same `docId` (`part i of n`).

### 8.2b Stock count

A separate mode registers the cylinders already at a counterparty when the system starts (or when one
is found that was never registered): pick the counterparty, scan, give gas and condition. Each cylinder
is registered with that counterparty as its location; the count is recorded as a document of type
`stock count`, with no delivery note and no e-mail unless asked.

### 8.3 Offline

Cylinder reads are cached; a document closed without network is signed and queued, and sent as soon
as the network returns. Conflicts (6.1) are shown to the driver, who re-scans or confirms.

### 8.4 Barcode

The barcode format is not known yet. Recognition uses ML Kit (all common 1D and 2D formats); the
normalization (trim, case, allowed characters, length) is a per-registry setting, so that it can be
fixed when the labels are known without changing the contracts.

### 8.5 Owner tools

What only the owner does: create the registry, set or change the password, authorize or revoke a
driver's phone, add or edit counterparties, migrate to a new owner. Each operation is signed with the
owner's key and sent through the relayer, which pays the gas as for the drivers.

- **Demo**: scripts in `scripts/` run by the owner on a computer (for example
  `node scripts/add-operator.js <phone address>`), signing with the owner's encrypted key file.
- **Later**: an owner web page that connects with UP Modal or UP Wallet, lists operators and
  counterparties, and signs in the owner's wallet. Same signed operations, same relayer.

### 8.6 The demo, step by step

1. **Before**: the owner creates the registry, sets the password, adds two customers and the owner's
   e-mail, and authorizes the phone (scripts, 8.5).
2. **Stock count**: at the demo customer's site, the cylinders already there are scanned in stock-count
   mode (8.2b), leaving one out to show how an unknown cylinder is handled.
3. **The driver arrives**: new document for that customer.
   - Full cylinders unloaded: unknown, so the app asks the gas and proposes `delivery`.
   - Empty cylinders taken back: known, so the app proposes `collection` from this customer; the
     cylinder left out of the count is unknown and is registered on the spot.
4. **Close**: the delivery note number, the preset recipients plus an address typed on the spot,
   **Send**. One transaction, paid by the relayer; the e-mail arrives with the summary per gas and the
   link to the transaction.
5. **Afterwards**: scanning any of those cylinders again shows its new state, read from the chain.

## 9. Scalability

- One transaction per document, split by a configurable maximum number of cylinders per transaction.
- One `eth_call` per scan, independent of the number of cylinders.
- History from `TokenIdDataChanged` and `DocumentRecorded` logs, read in block ranges; when volumes
  grow, an Envio HyperIndex indexer of the same events (it stores only ciphertexts, so it needs no key).
- Many companies: one registry each through the factory; the relayer applies limits per registry.
- Counterparties are separate entries; nothing grows into a single large value.

## 10. Repository layout (planned)

```
contracts/   GasCylinderRegistry.sol, GasCylinderRegistryFactory.sol, tests (Hardhat)
shared/      encryption, ids, encoding and EIP-712 types, used by the app, the relayer and scripts
relayer/     the relay and mail service
app/         the Android app (Capacitor), Italian and English
scripts/     deployment and owner tools for the demo (create registry, add operator, set password)
docs/        guides
```

## 11. Milestones

1. **Contracts** and their tests on a local chain: registry, factory, signed operations, nonces,
   ERC-1271, optimistic concurrency, migration.
2. **Shared library**: encryption, key wrap, ids, padding, with test vectors shared by app and scripts.
3. **Owner tools** (scripts, section 8.5): create a registry, set the password, add an operator, add counterparties.
4. **Relayer**: checks, limits, sending, e-mail.
5. **App**: setup, scanning, states, documents, offline queue, both languages.
6. **Demo on LUKSO mainnet** with Argonia Gas Tecnici's data replaced by the real supplier's only in
   the deployed registry, never in this repository.
7. **Later**: owner on a Universal Profile; an owner web page (UP Modal / UP Wallet) replacing the
   scripts; indexer; refill-plant documents once their format is known.

## 12. Open points

- **Barcode format** of the labels (section 8.4).
- **Refill plant documents**: what accompanies a cylinder sent to and back from refilling.
- **Emergency role**: whether ChainIntegrate keeps any recovery power over a registry (proposed: none).
- **Retention**: whether retired cylinders and old counterparties should ever be hidden from the app.
