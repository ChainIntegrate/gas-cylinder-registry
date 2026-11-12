package it.chainintegrate.gascylinders;

import java.math.BigInteger;
import java.security.SecureRandom;
import java.util.Arrays;

import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.asn1.x9.X9IntegerConverter;
import org.bouncycastle.crypto.digests.KeccakDigest;
import org.bouncycastle.crypto.digests.SHA256Digest;
import org.bouncycastle.crypto.ec.CustomNamedCurves;
import org.bouncycastle.crypto.params.ECDomainParameters;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;
import org.bouncycastle.crypto.signers.ECDSASigner;
import org.bouncycastle.crypto.signers.HMacDSAKCalculator;
import org.bouncycastle.math.ec.ECAlgorithms;
import org.bouncycastle.math.ec.ECPoint;
import org.bouncycastle.math.ec.FixedPointCombMultiplier;

/**
 * Ethereum keys and signatures on secp256k1, with no Android dependency (tested on its own).
 * A private key is 32 bytes; signatures are deterministic (RFC 6979), with a low s (EIP-2), and
 * returned as r (32) + s (32) + v (27 or 28), the format of personal_sign and of ethers' Signature.
 * Callers wipe the private key bytes when done.
 */
final class Secp256k1 {
    private static final X9ECParameters P = CustomNamedCurves.getByName("secp256k1");
    private static final ECDomainParameters CURVE = new ECDomainParameters(P.getCurve(), P.getG(), P.getN(), P.getH());
    private static final BigInteger N = P.getN();
    private static final BigInteger HALF_N = N.shiftRight(1);

    private Secp256k1() {}

    /** A new private key: 32 random bytes, between 1 and n - 1. */
    static byte[] newPrivateKey(SecureRandom random) {
        byte[] k = new byte[32];
        while (true) {
            random.nextBytes(k);
            BigInteger d = new BigInteger(1, k);
            if (d.signum() > 0 && d.compareTo(N) < 0) return k;
        }
    }

    /** The account address of a private key, as 0x + 40 lowercase hex digits. */
    static String address(byte[] privateKey) {
        return addressOf(publicPoint(new BigInteger(1, privateKey)));
    }

    /** Signs a 32-byte digest: r + s + v (65 bytes), v = 27 + recovery id. */
    static byte[] sign(byte[] privateKey, byte[] digest) {
        if (digest == null || digest.length != 32) throw new IllegalArgumentException("digest must be 32 bytes");
        BigInteger d = new BigInteger(1, privateKey);
        if (d.signum() <= 0 || d.compareTo(N) >= 0) throw new IllegalArgumentException("bad private key");
        ECDSASigner signer = new ECDSASigner(new HMacDSAKCalculator(new SHA256Digest()));
        signer.init(true, new ECPrivateKeyParameters(d, CURVE));
        BigInteger[] rs = signer.generateSignature(digest);
        BigInteger r = rs[0], s = rs[1];
        if (s.compareTo(HALF_N) > 0) s = N.subtract(s);
        ECPoint q = publicPoint(d);
        int recId = -1;
        for (int i = 0; i < 2; i++) {
            ECPoint k = recover(i, r, s, digest);
            if (k != null && k.equals(q)) { recId = i; break; }
        }
        if (recId < 0) throw new IllegalStateException("cannot find the recovery id");
        byte[] out = new byte[65];
        System.arraycopy(to32(r), 0, out, 0, 32);
        System.arraycopy(to32(s), 0, out, 32, 32);
        out[64] = (byte) (27 + recId);
        return out;
    }

    /** The address that signed a digest (for checks). */
    static String recoverAddress(byte[] digest, byte[] signature) {
        BigInteger r = new BigInteger(1, Arrays.copyOfRange(signature, 0, 32));
        BigInteger s = new BigInteger(1, Arrays.copyOfRange(signature, 32, 64));
        ECPoint q = recover((signature[64] & 0xff) - 27, r, s, digest);
        return q == null ? null : addressOf(q);
    }

    static byte[] keccak256(byte[] data) {
        KeccakDigest k = new KeccakDigest(256);
        k.update(data, 0, data.length);
        byte[] out = new byte[32];
        k.doFinal(out, 0);
        return out;
    }

    private static ECPoint publicPoint(BigInteger d) {
        return new FixedPointCombMultiplier().multiply(CURVE.getG(), d).normalize();
    }

    private static String addressOf(ECPoint q) {
        byte[] pub = q.getEncoded(false);   // 0x04 + x + y
        byte[] h = keccak256(Arrays.copyOfRange(pub, 1, 65));
        StringBuilder sb = new StringBuilder("0x");
        for (int i = 12; i < 32; i++) sb.append(String.format("%02x", h[i] & 0xff));
        return sb.toString();
    }

    private static byte[] to32(BigInteger v) {
        byte[] b = v.toByteArray(), out = new byte[32];
        int n = Math.min(b.length, 32);
        System.arraycopy(b, b.length - n, out, 32 - n, n);
        return out;
    }

    // Public key recovery (SEC 1, section 4.1.6), for recovery ids 0 and 1.
    private static ECPoint recover(int recId, BigInteger r, BigInteger s, byte[] digest) {
        if (recId < 0 || recId > 3) return null;
        BigInteger x = r.add(BigInteger.valueOf(recId / 2).multiply(N));
        if (x.compareTo(CURVE.getCurve().getField().getCharacteristic()) >= 0) return null;
        X9IntegerConverter conv = new X9IntegerConverter();
        byte[] enc = conv.integerToBytes(x, 1 + conv.getByteLength(CURVE.getCurve()));
        enc[0] = (byte) ((recId & 1) == 1 ? 0x03 : 0x02);
        ECPoint rp = CURVE.getCurve().decodePoint(enc);
        if (!rp.multiply(N).isInfinity()) return null;
        BigInteger e = new BigInteger(1, digest);
        BigInteger rInv = r.modInverse(N);
        BigInteger u1 = BigInteger.ZERO.subtract(e).multiply(rInv).mod(N);
        BigInteger u2 = s.multiply(rInv).mod(N);
        return ECAlgorithms.sumOfTwoMultiplies(CURVE.getG(), u1, rp, u2).normalize();
    }
}
