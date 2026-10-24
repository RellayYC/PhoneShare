package app.phoneshare;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Updates from GitHub Releases, the same channel as the Windows app (desktop/Updater.cs): latest.txt is the release JSON
 * plus its ECDSA P-256 signature, PhoneShare.apk sits next to it. Plain Java, so dev/UpdaterTest.java runs it on a PC;
 * MainActivity hands the checked APK to PackageInstaller.
 */
final class Updater {
    static final String URL = "https://github.com/RellayYC/PhoneShare/releases/latest/download";
    private static final String PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEnd/400xe/oR7dSpH8ZFm8igPbylKaWcIf8lKOz6uJ28PVax/gS1Ov5KJ0py0CJK15PThSDghkcVm0JqjQGfKZg==";

    static final class Release {
        final String version, apk, sha256;
        final long code;

        Release(String version, String apk, long code, String sha256) {
            this.version = version;
            this.apk = apk;
            this.code = code;
            this.sha256 = sha256;
        }
    }

    interface Progress { void percent(int p); }

    /** The signed release if its APK is newer than {@code current}, else null. */
    static Release check(String base, long current) throws IOException {
        Release r = parse(read(open(base + "/latest.txt")));
        return r.code > current ? r : null;
    }

    /** Verifies latest.txt; a release it cannot vouch for is an IOException, never a result. */
    static Release parse(byte[] latest) throws IOException {
        String text = new String(latest, StandardCharsets.UTF_8);
        int nl = text.indexOf('\n');
        if (nl < 0) throw new IOException("Подпись обновления не сходится, обновление отклонено.");
        byte[] json = text.substring(0, nl).getBytes(StandardCharsets.UTF_8);
        try {
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(PUBLIC_KEY))));
            s.update(json);
            if (!s.verify(der(Base64.getDecoder().decode(text.substring(nl + 1).trim())))) throw new GeneralSecurityException();
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new IOException("Подпись обновления не сходится, обновление отклонено.");
        }
        String m = new String(json, StandardCharsets.UTF_8), version = field(m, "version"), apk = field(m, "apk"), code = field(m, "apkCode");
        String sha = field(m, "apkSha256");
        if (version == null || apk == null || code == null || sha == null) throw new IOException("В этом выпуске нет версии для телефона.");
        return new Release(version, new File(apk).getName(), Long.parseLong(code), sha);
    }

    /** Downloads the APK to {@code to} and checks its hash; nothing is left behind if that fails. */
    static void download(String base, Release r, File to, Progress p) throws IOException {
        try {
            HttpURLConnection c = open(base + "/" + r.apk);
            long total = c.getContentLengthLong(), done = 0;
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    sha.update(buf, 0, n);
                    done += n;
                    if (total > 0) p.percent((int) (done * 100 / total));
                }
            } finally {
                c.disconnect();
            }
            if (!hex(sha.digest()).equalsIgnoreCase(r.sha256)) throw new IOException("Скачанный файл повреждён: контрольная сумма не совпала.");
        } catch (IOException | GeneralSecurityException e) {
            to.delete();
            throw e instanceof IOException ? (IOException) e : new IOException(e);
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();   // follows GitHub's redirect to its file storage
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "PhoneShare-Android");
        int status;
        try {
            status = c.getResponseCode();
        } catch (IOException e) {
            c.disconnect();
            throw new IOException("Не удалось связаться с сервером обновлений. Проверь интернет.", e);
        }
        if (status != 200) {
            c.disconnect();
            throw new IOException("Сервер обновлений ответил ошибкой " + status + ". Попробуй позже.");
        }
        return c;
    }

    private static byte[] read(HttpURLConnection c) throws IOException {
        try (InputStream in = c.getInputStream()) {
            byte[] buf = new byte[4096];
            int n = 0;
            for (int k; (k = in.read(buf, n, buf.length - n)) > 0; ) {
                n += k;
                if (n == buf.length) buf = Arrays.copyOf(buf, n * 2);
            }
            return Arrays.copyOf(buf, n);
        } finally {
            c.disconnect();
        }
    }

    /** One flat field of the release JSON: release.mjs writes only plain strings and numbers. */
    static String field(String json, String key) {
        Matcher m = Pattern.compile("\"" + key + "\":(?:\"([^\"\\\\]*)\"|(\\d+))").matcher(json);
        return m.find() ? (m.group(1) != null ? m.group(1) : m.group(2)) : null;
    }

    /** release.mjs signs in IEEE P1363 (r || s), Java verifies DER: SEQUENCE { INTEGER r, INTEGER s }. */
    static byte[] der(byte[] p1363) throws GeneralSecurityException {
        if (p1363.length != 64) throw new GeneralSecurityException("signature length " + p1363.length);
        byte[] r = integer(Arrays.copyOfRange(p1363, 0, 32)), s = integer(Arrays.copyOfRange(p1363, 32, 64));
        byte[] out = new byte[2 + r.length + s.length];
        out[0] = 0x30;
        out[1] = (byte) (r.length + s.length);   // at most 2 * 35 bytes, so the short length form always fits
        System.arraycopy(r, 0, out, 2, r.length);
        System.arraycopy(s, 0, out, 2 + r.length, s.length);
        return out;
    }

    private static byte[] integer(byte[] v) {
        int i = 0;
        while (i < v.length - 1 && v[i] == 0) i++;                  // minimal encoding: no leading zero bytes...
        int pad = (v[i] & 0x80) != 0 ? 1 : 0;                       // ...except one that keeps a high bit from reading as negative
        byte[] out = new byte[2 + pad + v.length - i];
        out[0] = 0x02;
        out[1] = (byte) (pad + v.length - i);
        System.arraycopy(v, i, out, 2 + pad, v.length - i);
        return out;
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }
}
