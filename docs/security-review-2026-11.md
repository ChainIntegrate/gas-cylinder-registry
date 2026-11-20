# External review of November 2026: what was done

Two independent reviews of GasTrace and of the ChainIntegrate Account extension (up-onboarding) were
delivered on 2026-11-13, both on this repository at commit `6b1f538` (app 0.2.1). They number their
findings differently: one **A01–A22**, the other **X-, G-, P-, U-, I-, D-, Q-**. Many describe the same
issue under both numbers; this table gives both. The reports themselves are kept privately by
ChainIntegrate.

This file closes the review for **this repository**. The extension's findings are handled in
up-onboarding (listed at the end). Remediation was done between 2026-11-14 and 2026-11-15 (commit
`f50a9b1`, app 0.2.4, extension 0.5.1); the points that needed a contract change were done in version 2 of
the contracts, deployed on 2026-11-17 and in use from 2026-11-20 (app 0.3.0, extension 0.6.1). The state it
describes is commit `ffe5f52` and later.

Status: **Fixed** (changed and tested), **Fixed (GasTrace side)** (the other side is the extension's),
**Partly fixed**, **Documented** (an accepted limit, now described plainly), **Fixed in version 2** (a
contract change: version 2 of the contracts, [DESIGN.md §6](../DESIGN.md), with the app, the pages and the
relayer that use it), **Owner** (operational, outside the code).

## Findings and their status

| Findings | What | Status | Where |
|---|---|---|---|
| A03 · G-01 | Junk requests used up a registry's daily limit | **Fixed**: per-IP limit first, before any node call; the registry's limit charged only for operations sent; foreign addresses remembered | `79a7f20` |
| A04 | A large document could record its first parts and have the last refused | **Fixed**: every limit checked before signing (16 KB document, 15 parts, the e-mail); refused whole | `785c369` |
| A08 | Documents whose e-mail failed vanished from "To send" | **Fixed** | `5135423` |
| A12 | Busy service treated as final; refused documents could only be retyped | **Fixed**: 429/5xx wait and retry; "Make the document again" from the cylinders' current state; warning before discarding a partly recorded document | `5135423`, `65527d9` |
| A10 | Document numbers collided across years and kinds; stock counts in the same second | **Fixed**: kind, year and number; stock counts with a random part | `4eda070` |
| A15 | The configured chain was taken for the node's | **Fixed**: `eth_chainId` asked in the relayer, the page and the app; the factory checked at the relayer's start | `43a19cd` |
| G-09 | The app accepted a setup code of any register | **Fixed**: checked with the factory before the password is typed | `43a19cd` |
| Q-01 | A test failed once in 256 runs | **Fixed** | `43a19cd` |
| G-06 · A17 | APK signing key exposed in CI; actions unpinned; nodemailer advisories | **Fixed**: tests read-only without secrets, signing in a separate job in the protected `release` environment; actions pinned by commit; nodemailer 10.5.0; the up-onboarding release pinned | `1f6b1e3`, `92aef85` |
| A17 (rest) | Advisories in development-only packages | **Open, low**: build tools, not deployed | |
| G-08 · A06 (part) | One unreadable value stopped the admin page | **Fixed**: values read one by one, problems counted | `9e88fef` |
| A06 | A phone can rewrite a registered cylinder's information | **Fixed in version 2**: a phone writes it only when registering the cylinder; the owner's "Correct" in the admin page, a correction document with its reason | `429e3d0`, `3fa7a9f`, `317ac68` |
| G-10 · D-16 | No export for the office | **Fixed**: CSV download of cylinders, movements, documents, customers (formula injection neutralized) | `0bc15c3` |
| X-02 | ChainIntegrate generated and saw the data password and recovery code | **Fixed**: registers created without a data key; the owner makes it at the first sign-in in the admin page | `56ba678` |
| A02 · G-04 | The confirmation window could not tell a key change from a customer | **Fixed (GasTrace side)**: the page sends the values; extension 0.5.1 checks them and names each change | `92aef85` |
| G-03 · A16 (part) | The relayer sent any text and PDF to ten addresses | **Fixed**: the phone signs the document's facts, the relayer writes the e-mail from a fixed template; no attachments, 8 recipients, a daily limit per registry | `f4f16a8` |
| A07 | A relayer restart lost e-mails and states | **Fixed**: journal on disk, taken up at start | `56d7406` |
| A09 · G-02 (part) | Plain caches on the phone; no idle lock; revoked phones kept their data | **Fixed**: caches sealed under a key derived from the data key; app locks after 10 minutes, page after 30; a revoked phone erases its keys and data | `f50a9b1` |
| A05 · G-02 | A revoked phone, or an old password, can still read new data (the data key cannot be replaced) | **Fixed in version 2**: key epochs and key ring (`shared/`), "Change the data key" in the admin page (new password and recovery code), phones asked for the new password; identifiers on the first key | `2ff8b8f`, `25eba11`, `317ac68` |
| A01 · X-01 | Any key of the owner's account with SIGN can sign the register's owner operations | **Fixed in version 2**: the register accepts an owner's signature only from a key with administrator permissions on the account (EDITPERMISSIONS, read from LSP6) for every owner operation; direct owner paths closed; a handover accepted only after 3 days, cancellable from the page, with the relayer's e-mail alert. From extension 0.6.0 (2026-11-16) the owner's requests are also confirmed only on an administrator computer, and the admin page says so when an access computer is refused | `2ff8b8f`, `429e3d0`, `25eba11` |
| A11 | Multipart documents have no manifest | **Fixed in version 2**: manifest, signer and parts fixed by the first part (`documentStatus`); the app sends it, the page shows incomplete documents | `429e3d0`, `25eba11` |
| G-07 | Signatures without maximum validity, not cancellable | **Fixed in version 2**: `validFrom`, seven days at most, `cancelNoncesSigned`; the app cancels a waiting document's signatures; the extension refuses more than seven days (from 0.5.1) | `429e3d0`, `695d0f4` |
| A21 | Removing or renaming a customer changed old documents | **Fixed**: archived, documents keep the name they were made with | `1cd101b` |
| G-05 | Traffic analysis from public metadata | **Documented** ([DESIGN.md §4.5](../DESIGN.md)), mitigations listed, not implemented | `35b68f1` |
| X-03 | Code served by ChainIntegrate handles the data key | **Documented** (DESIGN §5, "Who holds the data key") | `2ff8b8f` |
| A20 · D-08…D-15 | Documents that overstated or no longer matched the code | **Fixed** | `2ff8b8f`, `56ba678`, `92aef85` |
| A22 · I-08 | Test requirements unwritten; Windows line endings | **Fixed** | `35b68f1` |
| I-07 | The server's address in a public document | **Fixed** (still in the history) | `35b68f1` |
| X-04 | Side-loaded APK and extension | **Owner**: managed distribution (Play, MDM, Chrome Web Store) before real customers | |
| X-05 | One server for every service; shared SMTP credentials; a tools key on the server | **Owner**: separate SMTP credentials, off-site backups, the tools key off the server | |
| P-01 · A16 | No privacy notice, processor agreement or employee information | **Owner**, with the supplier and an adviser, before real data | |

## Verification of 2026-11-20 (version 2)

An independent re-check of version 2 and extension 0.6.1, on this repository at `eeda662` (the report is
kept privately by ChainIntegrate). No High or Medium issue. The items left to version 2 (A01 · X-01,
A05 · G-02, A06, A11, G-07) were confirmed fixed, also against the account the extension creates; the
follow-up's R-01 is fixed and R-07 closed (version 1 retired).

To fix, in this repository:

| ID | Severity | What | Status |
|---|---|---|---|
| N-01 | Low | The owner's correction (`RecordDocument` signed by the owner) is shown in the extension with one fixed sentence: one signature could create cylinders and rewrite several. The page to send the payload beside the request, the extension to recompute its hash and describe it (counts), and to refuse what it cannot describe (with up-onboarding) | Open |
| N-02 | Low | After a data key replacement, an old key still computes token IDs and document IDs (both on the first key): it can follow cylinders and tell which customer a new document is for, not its content. DESIGN §4.5 and §5 and the guide to say so; document IDs possibly from the current key | Open |
| N-03 | Low | Handover alerts: the watch's position is kept in memory (alerts sent again at each restart from `watchFromBlock`, or missed while the relayer is down); no check that the handover is still pending; runs may overlap; `handoverAlerts` written by hand per register. The position in the journal, the pending state checked and said, one run at a time, a reminder (or a refusal) for the alert address when a register is created | Open |
| N-04 | Info | After a handover the new owner keeps the previous account's phones and the same data key: after accepting, show the phones and suggest changing the data key; one line in the guide | Open |
| N-05 | Info | An authorized phone can take a predicted document number in advance (as in version 1): visible, stopped by revoking it. To mention in DESIGN §10 with the other insider limits | Open |
| A07 (rest) | Low | The relayer saves its journal after sending a transaction: a stop in between loses that document's e-mail | Open |
| R02 | Low | The phone's vault drops write errors silently (`app/src/vault.js`) | Open |
| A10 (rest) | Low | A document's year comes from the phone's time zone (`app/src/logic.js`) | Open |
| R-04 | Low | The e-mail's company and customer names are taken from the phone, not from the register | Open |
| R-06 | Low | No build provenance for the APK | Open |
| R-03 | Low | `SetData` without its values is still confirmable with a warning (the page always sends them; the extension's side in up-onboarding) | Open |
| R-09 | Info | Advisories in development-only packages (the Hardhat 2 toolchain) | Open, low |

The others listed there are up-onboarding's (R-02 wording, R-05, R-08, U-09) or the owner's (P-01, X-04,
X-05, unchanged).

## Handled in up-onboarding

The extension's and the account service's findings: A01 · X-01 (access keys), A13 · U-01 (upload
replay and quotas), A14 · U-05 (backup password), A18 (account creation crash window), A19 · U-14
(integrity check), U-02, U-03, U-04, U-06…U-13, P-02, I-01…I-06, Q-01 (its flaky test), Q-03, D-01…D-07,
and the catalog side of A02 · G-04 (released in extension 0.5.1).

## Verification

Each fix has a test: the Hardhat suite (141 tests: contracts of both versions, version 2 against a real
LUKSO account with an administrator and an access key, library, owner tools, relayer, app logic, the
admin export and the phone's vault) and three browser tests: the app's demo (new cylinders with owner and
periodic test, a refused document made again, a refill back tested, the 10-minute lock, a revoked phone
erased); the admin page against extension 0.6.1's catalog (activation request, first sign-in, correction,
test filter, a change from another computer, handover started and cancelled, data key replaced, the
30-minute lock); the operator page. CI runs them at every push
([.github/workflows/android.yml](../.github/workflows/android.yml)). Live on LUKSO mainnet: the version 2
factory `0xd60146C03f288fCeEEdB90731f162fF57F7ebdd2` and implementation
`0xaC0D8EffB68C5FE9F291dd34570dD2f6c53026af` (sources verified), relayer and pages at `20f8183` or later,
app 0.3.0 released.
