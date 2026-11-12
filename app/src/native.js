"use strict";
// The phone's native features, behind one small interface:
//   deviceKey.status()                      -> { exists, address, canAuth, hasDataKey }
//   deviceKey.create(texts)                 -> { address }          (fingerprint or PIN)
//   deviceKey.signDigests(digests, texts)   -> [signature]          (one fingerprint for all)
//   deviceKey.storeDataKey(hex, texts)      -> void                 (fingerprint)
//   deviceKey.loadDataKey(texts)            -> hex                  (fingerprint)
//   deviceKey.remove()                      -> void
//   scan(kind)                              -> text | null           ("qr" or "any" barcode)
// In the app they are the DeviceKey plugin (android/.../DeviceKeyPlugin.java) and ML Kit's scanner.
// In a browser test, window.__GCR_NATIVE__ provides them.

function capacitor() {
  return typeof window !== "undefined" && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
}

function nativeError(e) {
  const code = e && (e.code || (e.data && e.data.code));
  const err = new Error((e && e.message) || "failed");
  err.code = code || "FAILED";
  return err;
}

async function loadNative() {
  if (typeof window !== "undefined" && window.__GCR_NATIVE__) return window.__GCR_NATIVE__;
  if (!capacitor()) throw new Error("this page runs only in the app");
  const { registerPlugin } = require("@capacitor/core");
  const { BarcodeScanner, BarcodeFormat } = require("@capacitor-mlkit/barcode-scanning");
  const DK = registerPlugin("DeviceKey");
  const call = async (f) => {
    try {
      return await f();
    } catch (e) {
      throw nativeError(e);
    }
  };
  return {
    deviceKey: {
      status: () => call(() => DK.status()),
      create: (texts) => call(() => DK.create(texts)),
      signDigests: async (digests, texts) => (await call(() => DK.signDigests({ digests, ...texts }))).signatures,
      storeDataKey: (dataKey, texts) => call(() => DK.storeDataKey({ dataKey, ...texts })),
      loadDataKey: async (texts) => (await call(() => DK.loadDataKey(texts))).dataKey,
      remove: () => call(() => DK.remove()),
    },
    async scan(kind) {
      // Google's code scanner handles the camera itself: the app needs no camera permission.
      const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
      if (!available) await BarcodeScanner.installGoogleBarcodeScannerModule().catch(() => null);
      try {
        const { barcodes } = await BarcodeScanner.scan(kind === "qr" ? { formats: [BarcodeFormat.QrCode] } : {});
        return barcodes && barcodes[0] ? barcodes[0].rawValue || barcodes[0].displayValue : null;
      } catch (e) {
        if (/cancel/i.test(String(e && e.message))) return null;
        throw nativeError(e);
      }
    },
  };
}

module.exports = { loadNative };
