package app.phoneshare;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;

/**
 * Self-check for Updater against a local server (dev/update-android-test.mjs) holding latest.txt signed with the real key.
 * Args: base URL, expected APK code, expected APK sha256. Prints ANDROID UPDATER TESTS OK only after every assertion passes.
 */
public final class UpdaterTest {
    public static void main(String[] args) throws Exception {
        try {
            run(args[0], Long.parseLong(args[1]), args[2]);
            System.out.println("ANDROID UPDATER TESTS OK");
            System.exit(0);
        } catch (Throwable t) {
            t.printStackTrace();
            System.out.println("ANDROID UPDATER TESTS FAILED");
            System.exit(1);
        }
    }

    static void run(String base, long code, String sha) throws Exception {
        // P1363 -> DER against the JDK's own P1363 signer: random r and s hit the leading-zero and high-bit cases
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(256);
        KeyPair kp = g.generateKeyPair();
        SecureRandom rnd = new SecureRandom();
        for (int i = 0; i < 300; i++) {
            byte[] msg = new byte[1 + rnd.nextInt(64)];
            rnd.nextBytes(msg);
            Signature p = Signature.getInstance("SHA256withECDSAinP1363Format");
            p.initSign(kp.getPrivate());
            p.update(msg);
            Signature v = Signature.getInstance("SHA256withECDSA");
            v.initVerify(kp.getPublic());
            v.update(msg);
            check(v.verify(Updater.der(p.sign())), "DER conversion verifies, round " + i);
        }

        Updater.Release r = Updater.check(base + "/good", code - 1);
        check(r != null && r.code == code && r.sha256.equals(sha) && r.apk.equals("PhoneShare.apk") && r.version.equals("1.0.0"),
                "a signed newer release is offered: code, APK name, hash and version as published");
        check(Updater.check(base + "/good", code) == null, "the release this phone already runs is not offered");
        check(Updater.check(base + "/good", code + 1) == null, "an older release is not offered");
        fails(() -> Updater.check(base + "/tampered", 0), "Подпись", "a release whose JSON was changed after signing is refused");
        fails(() -> Updater.check(base + "/nosig", 0), "Подпись", "a release with no signature line is refused");
        fails(() -> Updater.check(base + "/garbage", 0), "Подпись", "a release with a garbage signature is refused");
        fails(() -> Updater.check(base + "/nophone", 0), "телефона", "a signed release without an APK is refused, not crashed on");
        fails(() -> Updater.check(base + "/missing", 0), "404", "a missing latest.txt is a readable error");
        fails(() -> Updater.check("http://127.0.0.1:1", 0), "интернет", "no server is a readable error");

        File to = File.createTempFile("phoneshare", ".apk");
        int[] last = {-1};
        Updater.download(base + "/good", r, to, p -> last[0] = p);
        check(Updater.hex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(to.toPath()))).equals(sha), "download writes the published APK");
        check(last[0] == 100, "progress reaches 100 %, got " + last[0]);

        Updater.Release bad = new Updater.Release(r.version, r.apk, r.code, sha.replace(sha.charAt(0), sha.charAt(0) == 'a' ? 'b' : 'a'));
        fails(() -> { Updater.download(base + "/good", bad, to, p -> { }); return null; }, "повреждён", "a download that does not match the signed hash is refused");
        check(!to.exists(), "and the bad file is deleted");
    }

    interface Call { Object run() throws Exception; }

    static void fails(Call c, String message, String what) throws Exception {
        try {
            c.run();
        } catch (IOException e) {
            check(String.valueOf(e.getMessage()).contains(message), what + " (message: " + e.getMessage() + ")");
            return;
        }
        throw new AssertionError("FAIL " + what + ": no error");
    }

    static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError("FAIL " + what);
        if (!what.startsWith("DER conversion") || what.endsWith(" 299")) System.out.println("ok  " + what);
    }
}
