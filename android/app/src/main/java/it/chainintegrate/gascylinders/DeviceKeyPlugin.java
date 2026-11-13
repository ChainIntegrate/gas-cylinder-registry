package it.chainintegrate.gascylinders;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.Base64;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * This phone's two secrets, each encrypted with its own AES-256-GCM key of the Android Keystore
 * (StrongBox when the phone has it), usable only right after the user's fingerprint, face or (Android 11+)
 * screen-lock PIN, once per use. The same approach as UP Wallet's phone key.
 *
 *  - The phone key: a secp256k1 private key created here, which signs the documents the driver sends.
 *    It is decrypted in this process only to sign, then wiped; it never reaches the web page.
 *  - The data key: the registry's 32-byte data key, given once at setup (after the owner typed the
 *    password) and returned to the page when the app is unlocked.
 *
 * App data is not backed up (allowBackup="false"): there is no copy anywhere. A lost phone is handled
 * by the owner revoking it (owner tools: remove-phone).
 *
 * The page that calls this plugin is the app's own bundled code (no other page is ever loaded: see
 * the Content-Security-Policy in app/index.html), so signing a digest the page computed is acceptable.
 *
 *   status()                                   -> { exists, address, canAuth, hasDataKey }
 *   create({ title, subtitle, cancel })        -> { address }            (fingerprint)
 *   signDigests({ digests, title, ... })       -> { signatures }         (one fingerprint for all)
 *   storeDataKey({ dataKey, title, ... })      -> {}                     (fingerprint)
 *   loadDataKey({ title, ... })                -> { dataKey }            (fingerprint)
 *   remove()                                   -> {}
 *
 * Errors: "CANCELED", "NO_AUTH" (no fingerprint or screen lock), "INVALIDATED" (Android dropped the
 * Keystore key, e.g. the screen lock was removed: set the phone up again), "NO_KEY", "EXISTS", "BUSY",
 * "BAD_INPUT", "FAILED".
 */
@CapacitorPlugin(name = "DeviceKey")
public class DeviceKeyPlugin extends Plugin {
    private static final String SIGN_ALIAS = "gcr.devicekey.v1";
    private static final String DATA_ALIAS = "gcr.datakey.v1";
    private static final String PREFS = "gcr.devicekey";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final int MAX_DIGESTS = 16;
    private boolean busy = false;

    private SharedPreferences prefs() { return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static int authenticators() {
        return Build.VERSION.SDK_INT >= 30
            ? BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
            : BiometricManager.Authenticators.BIOMETRIC_STRONG;
    }

    private boolean canAuth() {
        return BiometricManager.from(getContext()).canAuthenticate(authenticators()) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    private boolean hasSignKey() { return prefs().contains("sign.ct") && aliasExists(SIGN_ALIAS); }
    private boolean hasDataKey() { return prefs().contains("data.ct") && aliasExists(DATA_ALIAS); }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        boolean exists = hasSignKey();
        ret.put("exists", exists);
        ret.put("address", exists ? prefs().getString("address", null) : null);
        ret.put("canAuth", canAuth());
        ret.put("hasDataKey", hasDataKey());
        call.resolve(ret);
    }

    @PluginMethod
    public void create(PluginCall call) {
        if (hasSignKey()) { call.reject("a phone key already exists", "EXISTS"); return; }
        if (!canAuth()) { call.reject("no fingerprint or screen lock set up", "NO_AUTH"); return; }
        Cipher cipher;
        try {
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, newAesKey(SIGN_ALIAS));
        } catch (Exception e) { call.reject("cannot create the key: " + e.getMessage(), "FAILED"); return; }
        authenticate(call, cipher, (c) -> {
            byte[] priv = Secp256k1.newPrivateKey(new SecureRandom());
            try {
                String address = Secp256k1.address(priv);
                byte[] ct = c.doFinal(priv);
                prefs().edit()
                    .putString("sign.ct", Base64.encodeToString(ct, Base64.NO_WRAP))
                    .putString("sign.iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP))
                    .putString("address", address)
                    .commit();
                JSObject ret = new JSObject();
                ret.put("address", address);
                call.resolve(ret);
            } finally { Arrays.fill(priv, (byte) 0); }
        });
    }

    @PluginMethod
    public void signDigests(PluginCall call) {
        if (!hasSignKey()) { call.reject("no phone key", "NO_KEY"); return; }
        JSArray arr = call.getArray("digests");
        if (arr == null || arr.length() == 0 || arr.length() > MAX_DIGESTS) { call.reject("1 to " + MAX_DIGESTS + " digests", "BAD_INPUT"); return; }
        byte[][] digests = new byte[arr.length()][];
        for (int i = 0; i < arr.length(); i++) {
            byte[] d = hex(arr.optString(i, ""));
            if (d == null || d.length != 32) { call.reject("a digest is 32 bytes", "BAD_INPUT"); return; }
            digests[i] = d;
        }
        Cipher cipher;
        try { cipher = decryptCipher(SIGN_ALIAS, "sign.iv"); }
        catch (KeyPermanentlyInvalidatedException e) { call.reject("the phone key is no longer usable", "INVALIDATED"); return; }
        catch (Exception e) { call.reject("cannot open the key: " + e.getMessage(), "FAILED"); return; }
        authenticate(call, cipher, (c) -> {
            byte[] priv = c.doFinal(Base64.decode(prefs().getString("sign.ct", ""), Base64.NO_WRAP));
            try {
                String address = prefs().getString("address", "");
                JSONArray sigs = new JSONArray();
                for (byte[] d : digests) {
                    byte[] sig = Secp256k1.sign(priv, d);
                    // Never return a signature the phone key did not make.
                    if (!address.equals(Secp256k1.recoverAddress(d, sig))) throw new IllegalStateException("signature check failed");
                    sigs.put(toHex(sig));
                }
                JSObject ret = new JSObject();
                ret.put("signatures", sigs);
                call.resolve(ret);
            } finally { Arrays.fill(priv, (byte) 0); }
        });
    }

    @PluginMethod
    public void storeDataKey(PluginCall call) {
        byte[] key = hex(call.getString("dataKey", ""));
        if (key == null || key.length != 32) { call.reject("the data key is 32 bytes", "BAD_INPUT"); return; }
        if (!canAuth()) { call.reject("no fingerprint or screen lock set up", "NO_AUTH"); return; }
        Cipher cipher;
        try {
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, newAesKey(DATA_ALIAS));
        } catch (Exception e) { Arrays.fill(key, (byte) 0); call.reject("cannot create the key: " + e.getMessage(), "FAILED"); return; }
        authenticate(call, cipher, (c) -> {
            try {
                byte[] ct = c.doFinal(key);
                prefs().edit()
                    .putString("data.ct", Base64.encodeToString(ct, Base64.NO_WRAP))
                    .putString("data.iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP))
                    .commit();
                call.resolve();
            } finally { Arrays.fill(key, (byte) 0); }
        });
    }

    @PluginMethod
    public void loadDataKey(PluginCall call) {
        if (!hasDataKey()) { call.reject("no data key", "NO_KEY"); return; }
        Cipher cipher;
        try { cipher = decryptCipher(DATA_ALIAS, "data.iv"); }
        catch (KeyPermanentlyInvalidatedException e) { call.reject("the data key is no longer usable", "INVALIDATED"); return; }
        catch (Exception e) { call.reject("cannot open the key: " + e.getMessage(), "FAILED"); return; }
        authenticate(call, cipher, (c) -> {
            byte[] key = c.doFinal(Base64.decode(prefs().getString("data.ct", ""), Base64.NO_WRAP));
            try {
                JSObject ret = new JSObject();
                ret.put("dataKey", toHex(key));
                call.resolve(ret);
            } finally { Arrays.fill(key, (byte) 0); }
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
            ks.load(null);
            if (ks.containsAlias(SIGN_ALIAS)) ks.deleteEntry(SIGN_ALIAS);
            if (ks.containsAlias(DATA_ALIAS)) ks.deleteEntry(DATA_ALIAS);
        } catch (Exception e) { /* the stored data goes anyway */ }
        prefs().edit().clear().commit();
        call.resolve();
    }

    private interface WithCipher { void run(Cipher c) throws Exception; }

    // The system prompt (fingerprint, face, or the screen lock's PIN on Android 11+), bound to the cipher:
    // the Keystore releases the AES key for this one operation only after it succeeds.
    private void authenticate(PluginCall call, Cipher cipher, WithCipher then) {
        if (busy) { call.reject("another confirmation is waiting", "BUSY"); return; }
        FragmentActivity activity = (FragmentActivity) getActivity();
        if (activity == null) { call.reject("no activity", "FAILED"); return; }
        busy = true;
        String title = clip(call.getString("title", "GasTrace"), 60);
        String subtitle = clip(call.getString("subtitle", ""), 120);
        String cancel = clip(call.getString("cancel", "Annulla"), 30);
        activity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(getContext()), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    busy = false;
                    try {
                        BiometricPrompt.CryptoObject co = result.getCryptoObject();
                        if (co == null || co.getCipher() == null) { call.reject("no key after authentication", "FAILED"); return; }
                        then.run(co.getCipher());
                    } catch (Exception e) { call.reject("failed: " + e.getMessage(), "FAILED"); }
                }
                @Override
                public void onAuthenticationError(int code, CharSequence msg) {
                    busy = false;
                    boolean canceled = code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED;
                    boolean noAuth = code == BiometricPrompt.ERROR_NO_BIOMETRICS || code == BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL || code == BiometricPrompt.ERROR_HW_NOT_PRESENT || code == BiometricPrompt.ERROR_HW_UNAVAILABLE;
                    call.reject(String.valueOf(msg), canceled ? "CANCELED" : noAuth ? "NO_AUTH" : "FAILED");
                }
            });
            BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title).setConfirmationRequired(false)
                .setAllowedAuthenticators(authenticators());
            if (!subtitle.isEmpty()) info.setSubtitle(subtitle);
            if (Build.VERSION.SDK_INT < 30) info.setNegativeButtonText(cancel);
            try { prompt.authenticate(info.build(), new BiometricPrompt.CryptoObject(cipher)); }
            catch (Exception e) { busy = false; call.reject("cannot ask for the fingerprint: " + e.getMessage(), "FAILED"); }
        });
    }

    private static boolean aliasExists(String alias) {
        try { KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE); ks.load(null); return ks.containsAlias(alias); }
        catch (Exception e) { return false; }
    }

    // An AES-256-GCM key in the Keystore, usable only right after authentication, once per use.
    private SecretKey newAesKey(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(alias)) ks.deleteEntry(alias);
        boolean strongBox = Build.VERSION.SDK_INT >= 28 && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);
        try { return generate(alias, strongBox); }
        catch (Exception e) {
            if (strongBox && e instanceof StrongBoxUnavailableException) return generate(alias, false);
            throw e;
        }
    }

    private SecretKey generate(String alias, boolean strongBox) throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true)
            // A new fingerprint added later does not lock the key out (the screen lock already protects
            // adding one); removing the screen lock does (INVALIDATED).
            .setInvalidatedByBiometricEnrollment(false);
        if (Build.VERSION.SDK_INT >= 30) b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        else b.setUserAuthenticationValidityDurationSeconds(-1);
        if (strongBox && Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true);
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        kg.init(b.build());
        return kg.generateKey();
    }

    private Cipher decryptCipher(String alias, String ivPref) throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        SecretKey k = (SecretKey) ks.getKey(alias, null);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, Base64.decode(prefs().getString(ivPref, ""), Base64.NO_WRAP)));
        return cipher;
    }

    private static String clip(String s, int n) { return s == null ? "" : s.length() > n ? s.substring(0, n) : s; }

    static byte[] hex(String h) {
        if (h == null) return null;
        if (h.startsWith("0x") || h.startsWith("0X")) h = h.substring(2);
        if (h.length() % 2 != 0 || !h.matches("[0-9a-fA-F]*")) return null;
        byte[] b = new byte[h.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    static String toHex(byte[] b) {
        StringBuilder sb = new StringBuilder("0x");
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }
}
