# The drivers' app: GasTrace for Android

An Android app (Capacitor, like UP Wallet for Android) in Italian and English, with the language button
at the top right. It speaks plain words only: cylinders, delivery notes, customers, the phone's code.

## What it does

- **Delivery / collection**: pick the customer, scan the cylinders one at a time (or type the code),
  type the delivery note number, send. For each cylinder the app reads its last state and proposes the
  movement: a cylinder at the depot or never seen is a delivery (full); a cylinder at this customer is a
  collection (empty by default; full or defective can be chosen). A new cylinder asks for its gas.
  Warnings (a cylinder recorded at another customer, at a refill plant, retired, owned by someone else)
  must be confirmed before sending, and are listed in the e-mail.
- **Stock count**: registers the cylinders already at a customer or refill plant when the system starts;
  no delivery note, no e-mail unless an address is added.
- **Refill**: cylinders sent to a refill plant and back.
- **Check a cylinder**: gas, where it is, its condition and last movement.
- **Send**: one fingerprint (or PIN) confirms the whole document and its e-mail. The relayer records
  it, then e-mails it to the customer's and the supplier's addresses and up to three typed for that
  document. Without network, or when the service is busy, the document waits in "To send" and leaves
  when the network returns (or with "Send now"). It can still be refused then: a cylinder changed
  meanwhile, the signature older than seven days, the phone revoked; the driver makes the document
  again. If the e-mail cannot leave (or it is not known whether it left), the document stays in "To
  send" with "Send from the phone" until the driver removes it. A document too large for one send is
  refused before signing: split it in two.

## Install

The APK is attached to each [release](https://github.com/ChainIntegrate/gas-cylinder-registry/releases)
(`gastrace-v<version>.apk`), signed with GasTrace's release key.

1. Open the release page on the phone and download the `.apk`, then open it.
2. **The first time**, Android says it cannot install apps from that source (for example Chrome) and
   offers Settings: turn on "Allow from this source" for that app, go back, and the installation goes on.
3. **Play Protect** may offer to scan the app, because it does not come from the Play Store: accept the
   scan, or choose "More details" and then "Install anyway". It is Google's check of apps from
   developers it has not verified yet. Install only the APK downloaded from this repository's releases:
   its signer's SHA-256 is printed in the release's build ("Release key" notice). Any other warning, or
   an APK from elsewhere: stop and ask ChainIntegrate.

**Updates** install over the previous version and keep the phone's setup. **Never uninstall the app to
update it**: its keys would be lost and the phone would have to be set up again (and revoked by the
owner). Clearing the app's data, removing the phone's screen lock or a factory reset lose them too.

## Setting up a phone (once, with the owner)

1. The owner opens the admin page, **Phones**: it shows the register's setup QR.
2. On the phone: open GasTrace, **Scan the code**, then **Create the key** (fingerprint or PIN; the
   phone must have a screen lock).
3. The app shows **this phone's code** (groups of four characters); the owner types it in the admin page,
   **Authorize a phone**, and confirms in the extension.
4. The app sees the authorization and asks for the **data password**: the owner types it on the phone,
   once. The phone keeps the data key protected by the fingerprint; the password is not stored.

Each time the app opens, the driver unlocks it with the fingerprint or PIN. A lost phone, or a driver who
leaves: the owner revokes the phone from the admin page. Revoking stops the phone from writing; it
still holds the data key and can read until the key can be replaced, so a returned phone should be
wiped (company phones make this simple).

## Build

```bash
npm ci
node scripts/build-app.js        # app/www from app/src (esbuild); app/app-config.json: RPC, relayer
npx cap sync android
cd android && ./gradlew assembleDebug      # needs the Android SDK and JDK 21
```

GitHub Actions ("Android APK", `.github/workflows/android.yml`) does this at every push, after the
tests, and keeps the APK as the run's artifact (`gastrace-apk`, 30 days).

Tests: `npx hardhat test` (the app's logic against a local chain and the relayer) and, with
`npx hardhat node` running, `node scripts/ui-demo.js [screenshots-dir]` (the interface in Chromium, the
demo step by step; only the fingerprint key and the camera are simulated).

## Releases and signing

A GitHub release with the tag `v<versionName>` (`android/app/build.gradle`) builds the APK signed with
the release key and attaches it. The tag must match `versionName`; `versionCode` goes up by one for each
release. Release notes are in English.

The release key never enters the repository. CI reads it from the repository's secrets:
`GCR_KEYSTORE_B64` (the PKCS#12 file in base64) and `GCR_KEYSTORE_PASSWORD` (`GCR_KEY_ALIAS` if the alias
is not `gascylinders`). Keep a copy of the key file and its password offline: without them no update of
the installed app is possible.

CI has two jobs (`.github/workflows/android.yml`, external review G-06). **test** runs at every push:
all the tests, then the APK built **unsigned**, plus a debug APK to try on a phone (artifact
`gastrace-apk`); it has read-only access and no secret, so the npm packages, Playwright and the local
chain it runs never see the release key. **release** runs only for a published release, in the GitHub
environment `release`: it installs nothing, signs the unsigned APK with the release key (the Android
SDK's `zipalign` and `apksigner`), checks the tag matches `versionName` and attaches the APK. Protect the
environment once (Settings → Environments → `release` → Required reviewers: yourself), and move the
three secrets from the repository's secrets to the environment's: then only an approved release can
use the key. Actions are pinned by commit, and the admin page test uses the catalog of a released
extension (`UPONBOARDING_REF`).

If a release's build fails, delete the release and its tag, fix `main`, and create the release again
(the build uses the tag's commit).

### Telling the phones about a new release

The app shows its version at the bottom of the home screen. After a release, write its version and APK
link in the relayer's announcement file ([relayer/README.md](../relayer/README.md#announce-a-new-app-release)):
the phones with an older version then show "È disponibile una nuova versione di GasTrace" and a
**Scarica** button. The driver taps it, the browser downloads the APK, and Android installs it over the
old one (the same steps as the first install: open the downloaded file, allow the install). The data on
the phone (its key, the unlocked register, documents waiting to be sent) stays. The notice appears from
version 0.2.1 on: a phone with 0.2.0 is updated by hand once.

## Files

| Path | What |
|---|---|
| `app/src/logic.js` | Reading cylinders, proposals, documents, signing, the outbox (no interface; tested in Node) |
| `app/src/ui.js`, `app/src/i18n.js` | The interface and its texts |
| `app/src/native.js` | The native side: the DeviceKey plugin and ML Kit's scanner |
| `android/.../DeviceKeyPlugin.java` | The phone key and the data key, each behind its own Keystore key and the fingerprint |
| `android/.../Secp256k1.java` | Signatures (UP Wallet's file, with its tests) |
| `app/icon/` | The icon and the script that renders the launcher icons and splash screens |
