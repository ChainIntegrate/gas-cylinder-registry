# The drivers' app (Android)

An Android app, built with Capacitor like UP Wallet for Android, in Italian and English (button at the
top right). It speaks plain words only: cylinders, delivery notes, customers, the phone's code.

## What it does

- **Delivery / collection**: pick the customer, scan the cylinders one at a time (or type the code),
  type the delivery note number, send. For each cylinder the app reads its last state and proposes
  the movement: a cylinder at the depot or never seen is a delivery (full), a cylinder at this
  customer is a collection (empty by default; full or defective can be chosen). A new cylinder asks
  for its gas. Warnings (a cylinder recorded at another customer, at a refill plant, retired, owned by
  someone else) must be confirmed before sending, and are listed in the e-mail.
- **Stock count**: registers the cylinders already at a customer (or a refill plant) when the system
  starts; no delivery note, no e-mail unless an address is added.
- **Refill**: cylinders sent to a refill plant and back.
- **Check a cylinder**: gas, where it is, its condition and last movement.
- **Send**: one fingerprint (or PIN) confirms the whole document and its e-mail. The relayer records
  it and then sends the e-mail to the customer's and the supplier's addresses (set by the owner) and
  up to three typed for that document. Without network the document is kept and sent later
  ("To send"); if the e-mail cannot leave, the app offers to send it from the phone.

## Setting up a phone (once, with the owner)

1. The owner runs `node scripts/owner.js phone-setup` and shows the QR code.
2. On the phone: open the app, **Scan the code**, then **Create the key** (fingerprint or PIN).
3. The app shows **this phone's code**; the owner runs `node scripts/owner.js add-phone "<code>"`.
4. The app sees the authorization and asks for the **data password**: the owner types it once.
   The phone keeps the data key protected by the fingerprint; the password is not stored.

Each time the app opens, the driver unlocks it with the fingerprint or PIN. A lost phone, or a driver
who leaves: the owner runs `remove-phone`.

## Install

APKs are built by GitHub Actions ("Android APK") at every push to `main` and attached to releases,
as for UP Wallet: download the `.apk` from the run's artifacts (`bombole-apk`) or from a release,
open it on the phone and allow installing from that source. Updates install over the previous
version and keep the phone's setup. **Never uninstall the app to update it**: its keys would be lost
and the phone would need to be set up again.

## Build

```bash
npm ci
node scripts/build-app.js        # app/www from app/src (esbuild); app/app-config.json: RPC, relayer
npx cap sync android
cd android && ./gradlew assembleDebug      # needs the Android SDK and JDK 21
```

Tests: `npx hardhat test` (the app's logic against a local chain and the relayer) and, with
`npx hardhat node` running, `node scripts/ui-demo.js [screenshots-dir]` (the interface in Chromium,
the demo step by step; only the fingerprint key and the camera are simulated).

## Signing

The release key never enters the repository. CI reads it from the repository's secrets:
`GCR_KEYSTORE_B64` (the PKCS#12 file in base64), `GCR_KEYSTORE_PASSWORD`, and optionally
`GCR_KEY_ALIAS` (default `gascylinders`). Without them CI builds a debug APK, which cannot update a
release. Keep a copy of the release key offline.

## Files

| Path | What |
|---|---|
| `app/src/logic.js` | Reading cylinders, proposals, documents, signing, outbox (no interface; tested in Node) |
| `app/src/ui.js`, `app/src/i18n.js` | The interface and its texts |
| `app/src/native.js` | The native side: the DeviceKey plugin and ML Kit's scanner |
| `android/.../DeviceKeyPlugin.java` | The phone key and the data key, each behind its own Keystore key and the fingerprint |
| `android/.../Secp256k1.java` | Signatures (the same file as UP Wallet's, with its tests) |
| `app/icon/` | The icon and the script that renders the launcher icons and splash screens |
