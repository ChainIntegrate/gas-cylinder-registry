package it.chainintegrate.gascylinders;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.math.BigInteger;
import java.security.SecureRandom;

import org.junit.Test;

/**
 * Secp256k1.java against ethers 6.13.4 (the library UP Wallet uses; this app signs the same way): for each test key (never a real
 * one) and digest, the address and the signature ethers gives (r + s + v, deterministic, low s).
 * Run by CI before the APK is built (gradlew testDebugUnitTest).
 */
public class Secp256k1Test {
    private static final String[][] VECTORS = {
        {"0x0000000000000000000000000000000000000000000000000000000000000001", "0x4e7e264b411f20caac6ef226cbbe3bd7eae36c6ce92f0ecb8d8c34ef9b6ff315", "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", "0x243d29c731621defdb93a2097a1142a13380ed644a27371f2b4be0fb0c242e4f52dabe2d46c0a51b15f28687946f745ffbc8cf5e75edf56b9d5ddfda5636c07f1c"},
        {"0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140", "0xc148349da8ab04a213b8fbd4060cb7cc4a3a42d491a0d610b3775ee2096b6e40", "0x80c0dbf239224071c59dd8970ab9d542e3414ab2", "0x60bc1a4e002f29cf9e51dbd69a9f13211c93531fd5bd8e88ca59aec91e5d12274a7f22bb5d2664edb45906dbcc82a893258ebe8c2c9b9ad5c18abf149f4137c61b"},
        {"0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318", "0x8e6d7bb9c42a3322b06fd81bc312e0e7f8ddbddfa643db3b39ece67719206709", "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23", "0x9e9bc5d33f2442009913ce1e5e5a11c8e7bc3f16ab21800de5c5dcc98883d8fe4594fac3e11753f995506171daaa1fc90363c840f0aa70854bb9c7559f472fe11b"},
        {"0x3de2a645c4cf941dc682cf3c8c63af94a25e852fe05b6ac73278e76f306755cd", "0xcbc191544ef8695f81792b4f0399c60b8b0ea8bb11caef8b7e89bc7b2db68e0a", "0x718aefc17d196958997dcf274be794e46d70d17a", "0xc262aecb1cd7ccba9f9a1dcd547d53a79c19d8833ceccf396739b4843d0101d026f30b5b0653f8eb726e9a2a41d802b04d264f0d997554cf0b7305eb1ef805d51c"},
        {"0x642605b5f185b3d9a066ed802a26bb9ea42652bfd5de0d087b23ed1cf68f7837", "0xb4f8a1b142c04d1bf5a82a454f2e8f6cf357a3b6a7106cc2f364794244e528dd", "0x406d792587494f3eb968f39dcde7f312cdf9216d", "0xfd1bc3be4fb1e912556b0e4a90b030fd5f5946932ffc68c506e4e3507b0d440b7939177f6c73f054d26dbbcdde6612fcbdbc4963ff39cf9965768302dc6c374a1b"},
        {"0xb66149184f03960e93f15ebb4b6b2edb94bb61dc3de6aebfeb0d61093d47667f", "0xaf3c7d37bd40cc76f18fad3aeaad20459ba578e81869a0711b7ea1b181f0d1c4", "0xbbb5f9481bf46e425a0b58a45bc5cb667f3bd9ff", "0xbe8dee9525768a157bd8664f844627d33c0a24f26b271a02346935ce65ca40b0461b6fcb69108b772f99121670dd187ae0a7b61e29bf044bc6991a808542e8b31b"},
        {"0x007649a20c497c247ddc9176d7a03e76d41ce05a00203046b84eb893fdff7d42", "0xa877ed86212678bd0084752c2e24403bb4455029a7adcec67b91cdbdca4e6089", "0x2668fd7d2fc456ae5a79e9d81675cc5fba174739", "0x50d755bbd2762c3a085a260c1b77aa477786df2df36e401d5e263a8464d0036d4616149b4dc2c7171fa5bb319943b4f8e623efdae0976262490847b48120861b1b"},
        {"0x12f35eacb5ba1bad5bd08543086f359af8a6ffbbe07ec652b173d6cbbdd0beb5", "0x74baf588bfb85119f191adf1b000fb9c437d39e5bdc05b9bc4e6ac54d4da33db", "0x6ffeaf4a11e667dc1cb55d2e91c60ad7efa5352f", "0xec6351c68c461603a7a27f7249acc53d321b15eca7399d3694de9c8855283a7b4c2c8df793f115c59fadfcaf502b6783902db7f3adc66a6985ca2c208ed8dfcd1b"},
    };

    static byte[] hex(String h) {
        h = h.substring(2);
        byte[] b = new byte[h.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    @Test
    public void addressesAndSignaturesEqualEthers() {
        for (String[] v : VECTORS) {
            byte[] key = hex(v[0]), digest = hex(v[1]);
            assertEquals(v[2], Secp256k1.address(key));
            byte[] sig = Secp256k1.sign(key, digest);
            assertArrayEquals(v[0], hex(v[3]), sig);
            assertEquals(v[2], Secp256k1.recoverAddress(digest, sig));
        }
    }

    @Test
    public void lowSAndValidV() {
        BigInteger halfN = new BigInteger("7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0", 16);
        SecureRandom r = new SecureRandom();
        for (int i = 0; i < 50; i++) {
            byte[] key = Secp256k1.newPrivateKey(r), digest = new byte[32];
            r.nextBytes(digest);
            byte[] sig = Secp256k1.sign(key, digest);
            byte[] s = new byte[32];
            System.arraycopy(sig, 32, s, 0, 32);
            assertTrue(new BigInteger(1, s).compareTo(halfN) <= 0);
            assertTrue(sig[64] == 27 || sig[64] == 28);
            assertEquals(Secp256k1.address(key), Secp256k1.recoverAddress(digest, sig));
        }
    }

    @Test
    public void keccakOfEmpty() {
        assertArrayEquals(hex("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"), Secp256k1.keccak256(new byte[0]));
    }

    @Test(expected = IllegalArgumentException.class)
    public void refusesAShortDigest() {
        Secp256k1.sign(hex("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"), new byte[31]);
    }
}
