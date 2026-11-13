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
  document. Without network the document waits in "To send" and leaves when the network returns; if
  the e-mail cannot leave (or it is not known whether it left), the app offers to send it from the phone.

## Install

The APK is attached to each [release](https://github.com/ChainIntegrate/gas-cylinder-registry/releases)
(`gastrace-v<version>.apk`), signed with GasTrace's release key.

1. Open the release page on the phone and download the `.apk`, then open it.
2. **The first time**, Android says it cannot install apps from that source (for example Chrome) and
   offers Settings: turn on "Allow from this source" for that app, go back, and the installation goes on.
3. **Play Protect** may offer to scan the app, because it does not come from the Play Store: accept the
   scan, or choose "More details" and then "Install anyway". It is Google's check of apps from
   developers it has not verified yet, not a problem of the app.

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
leaves: the owner revokes the phone from the admin page.

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
is not `gascylinders`). Without them CI builds a debug APK, which cannot update a release. Keep a copy of
the key file and its password offline: without them no update of the installed app is possible.

If a release's build fails, delete the release and its tag, fix `main`, and create the release again
(the build uses the tag's commit).

## Files

| Path | What |
|---|---|
| `app/src/logic.js` | Reading cylinders, proposals, documents, signing, the outbox (no interface; tested in Node) |
| `app/src/ui.js`, `app/src/i18n.js` | The interface and its texts |
| `app/src/native.js` | The native side: the DeviceKey plugin and ML Kit's scanner |
| `android/.../DeviceKeyPlugin.java` | The phone key and the data key, each behind its own Keystore key and the fingerprint |
| `android/.../Secp256k1.java` | Signatures (UP Wallet's file, with its tests) |
| `app/icon/` | The icon and the script that renders the launcher icons and splash screens |
