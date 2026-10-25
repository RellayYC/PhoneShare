package app.phoneshare;

import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** Self-check for StreamServer. Prints SERVER TESTS OK only after every assertion passes. */
public final class ServerTest {
    static final String PIN = "246810";
    static final int UDP = 47811;

    public static void main(String[] args) throws Exception {
        try {
            run();
            System.out.println("SERVER TESTS OK");
            System.exit(0);
        } catch (Throwable t) {
            t.printStackTrace();
            System.out.println("SERVER TESTS FAILED");
            System.exit(1);
        }
    }

    static void run() throws Exception {
        check(StreamServer.acceptKey("dGhlIHNhbXBsZSBub25jZQ==").equals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "RFC 6455 accept key");
        check("123456".equals(StreamServer.field("{\"t\":\"auth\",\"pin\":\"123456\",\"name\":\"A \\\"B\\\"\"}", "pin")), "field pin");
        check("A \"B\"".equals(StreamServer.field("{\"t\":\"auth\",\"pin\":\"123456\",\"name\":\"A \\\"B\\\"\"}", "name")), "field escaped name");
        check("12.5".equals(StreamServer.field("{\"t\":\"ping\",\"c\":12.5}", "c")), "field number");
        // what JSON.stringify writes for pasted text: line breaks, tabs, backslashes, control characters
        check("a\nb\tc\\d\"e/\u0001ё".equals(StreamServer.field("{\"t\":\"text\",\"s\":\"a\\nb\\tc\\\\d\\\"e\\/\\u0001ё\"}", "s")), "field JSON escapes");
        check("\\n".equals(StreamServer.field("{\"s\":\"\\\\n\"}", "s")), "field escaped backslash before n");
        check(StreamServer.q("a\"b\n").equals("\"a\\\"b\\u000a\""), "json quote");

        check(StreamServer.nextBitrate(8_000_000, 8_000_000, true, 0) == 5_600_000, "bitrate drops to 70%");
        check(StreamServer.nextBitrate(1_200_000, 8_000_000, true, 0) == 1_000_000, "bitrate floor");
        check(StreamServer.nextBitrate(4_000_000, 8_000_000, false, 4) == 4_000_000, "bitrate holds before 5 quiet s");
        check(StreamServer.nextBitrate(4_000_000, 8_000_000, false, 5) == 4_600_000, "bitrate rises 15%");
        check(StreamServer.nextBitrate(7_900_000, 8_000_000, false, 9) == 8_000_000, "bitrate capped at target");

        check(StreamServer.targetBitrate(1280, 30) == 4_000_000, "1280 px at 30 fps: 4 Mbps, as the old economy preset");
        check(StreamServer.targetBitrate(1920, 60) == 9_100_000, "1920 px at 60 fps: 9.1 Mbps, near the old 8");
        check(StreamServer.targetBitrate(2560, 60) == 15_200_000, "2560 px at 60 fps: 15.2 Mbps, near the old 16");
        check(StreamServer.targetBitrate(960, 15) == 1_600_000, "960 px at 15 fps");
        check(StreamServer.targetBitrate(720, 15) == 1_100_000, "low end: 720 px at 15 fps stays above the floor");
        check(StreamServer.targetBitrate(2400, 60) == StreamServer.targetBitrate(2560, 60), "a 2400 px screen counts as 2560");
        check(StreamServer.targetBitrate(2560, 120) == 23_000_000, "high end: 2560 px at 120 fps stays under the cap");
        boolean rising = true;
        for (int s = 0; s < StreamServer.SIZES.length; s++) {
            for (int f = 0; f < StreamServer.FPS.length; f++) {
                int b = StreamServer.targetBitrate(StreamServer.SIZES[s], StreamServer.FPS[f]);
                if (b < StreamServer.MIN_BITRATE || b > StreamServer.MAX_BITRATE) rising = false;
                if (f > 0 && b <= StreamServer.targetBitrate(StreamServer.SIZES[s], StreamServer.FPS[f - 1])) rising = false;
                if (s > 0 && b <= StreamServer.targetBitrate(StreamServer.SIZES[s - 1], StreamServer.FPS[f])) rising = false;
            }
        }
        check(rising, "bitrate grows with size and with fps, inside the floor and the cap");

        AtomicInteger keyRequests = new AtomicInteger();
        StreamServer srv = new StreamServer("TestPhone", PIN, name -> {
            if (name.equals("index.html")) return "<!doctype html>INDEX".getBytes(StandardCharsets.UTF_8);
            if (name.equals("app.js")) return "console.log(1)".getBytes(StandardCharsets.UTF_8);
            return null;
        });
        srv.onKeyframeNeeded = keyRequests::incrementAndGet;
        srv.setAudioFormat(48000, 2);
        int port = srv.start(0, UDP);

        // HTTP
        String r = http(port, "GET / HTTP/1.1");
        check(r.startsWith("HTTP/1.1 200") && r.contains("INDEX") && r.contains("text/html"), "GET / serves index");
        check(http(port, "GET /app.js HTTP/1.1").contains("text/javascript"), "GET /app.js content type");
        check(http(port, "GET /../secret HTTP/1.1").startsWith("HTTP/1.1 404"), "path traversal rejected");
        check(http(port, "GET /missing.js HTTP/1.1").startsWith("HTTP/1.1 404"), "unknown asset 404");
        check(http(port, "POST / HTTP/1.1").startsWith("HTTP/1.1 405"), "POST rejected");

        // UDP discovery
        try (DatagramSocket ds = new DatagramSocket()) {
            ds.setSoTimeout(2000);
            byte[] q = StreamServer.DISCOVERY_QUERY.getBytes(StandardCharsets.UTF_8);
            ds.send(new DatagramPacket(q, q.length, InetAddress.getLoopbackAddress(), UDP));
            DatagramPacket p = new DatagramPacket(new byte[512], 512);
            ds.receive(p);
            String reply = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
            check(reply.contains("\"name\":\"TestPhone\"") && reply.contains("\"port\":" + port) && reply.matches(".*\"id\":\"[0-9a-f]{1,16}\".*"), "discovery reply: " + reply);
        }

        // No media before auth
        srv.setVideoSize(720, 1280);
        byte[] sps = {0, 0, 0, 1, 0x67, 0x42, (byte) 0xc0, 0x1f, 0, 0, 0, 1, 0x68, (byte) 0xce, 0x3c, (byte) 0x80};
        srv.sendVideoConfig(sps, 0, sps.length, 1);
        Ws pre = new Ws(port, 0);
        srv.sendVideoFrame(new byte[100], 0, 100, true, 2);
        srv.sendAudio(new byte[64], 0, 64, 2);
        check(pre.readOrNull(400) == null, "unauthenticated viewer gets nothing");

        // Auth, then resync order: video info, config, (delta skipped), key
        pre.sendText("{\"t\":\"auth\",\"pin\":\"" + PIN + "\",\"name\":\"Test viewer\"}");
        check(pre.read().text().contains("\"ok\":true"), "auth ok");
        String hello = pre.read().text();
        check(hello.contains("\"t\":\"hello\"") && hello.contains("TestPhone") && hello.contains("\"rate\":48000"), "hello: " + hello);
        check(pre.read().text().contains("\"w\":720"), "video info after auth");
        Msg cfg = pre.read();
        check(cfg.op == 2 && cfg.data[0] == StreamServer.VIDEO_CONFIG, "config after video info");
        srv.sendVideoFrame(new byte[] {9, 9}, 0, 2, false, 3);
        srv.sendVideoFrame(new byte[] {7, 7, 7}, 0, 3, true, 4);
        Msg key = pre.read();
        check(key.data[0] == StreamServer.VIDEO_FRAME && key.data[1] == 1 && key.data.length == 13, "delta skipped, keyframe delivered");
        check(srv.viewers().size() == 1 && srv.viewers().get(0).startsWith("Test viewer"), "viewer listed");

        // ping -> time
        pre.sendText("{\"t\":\"ping\",\"c\":123.5}");
        Msg time = readText(pre, "\"t\":\"time\"");
        check(time.text().contains("\"c\":123.5") && time.text().contains("\"s\":"), "time reply");

        // Sound changes reach a viewer that is already watching
        check(hello.contains("\"vol\":1.000"), "hello carries the phone volume");
        srv.setVolume(0.25f);
        check(readText(pre, "\"t\":\"volume\"").text().contains("\"v\":0.250"), "phone volume change sent live");
        srv.setAudioFormat(0, 2);
        check(readText(pre, "\"t\":\"audio\"").text().contains("\"audio\":null"), "sound off sent live");
        srv.setAudioFormat(48000, 2);
        check(readText(pre, "\"t\":\"audio\"").text().contains("\"rate\":48000"), "sound on sent live");
        // control: forwarded only while the phone allows it, and only from a viewer that entered the PIN
        java.util.List<String> commands = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        srv.onControl = commands::add;
        check(hello.contains("\"control\":false"), "hello says whether the phone takes control");
        pre.sendText("{\"t\":\"nav\",\"a\":\"back\"}");
        Thread.sleep(200);
        check(commands.isEmpty(), "control off: commands are ignored");
        srv.setControl(true);
        check(readText(pre, "\"t\":\"control\"").text().contains("\"on\":true"), "control on sent live");
        pre.sendText("{\"t\":\"gesture\",\"p\":\"0.5,0.5,0\"}");
        pre.sendText("{\"t\":\"text\",\"s\":\"привет\"}");
        long until = System.currentTimeMillis() + 2000;
        while (commands.size() < 2 && System.currentTimeMillis() < until) Thread.sleep(20);
        check(commands.size() == 2 && commands.get(0).contains("0.5,0.5,0") && commands.get(1).contains("привет"), "control on: commands reach the phone: " + commands);
        Ws stranger = new Ws(port, 0);
        stranger.sendText("{\"t\":\"nav\",\"a\":\"home\"}");
        Thread.sleep(300);
        check(commands.size() == 2, "a viewer without the PIN cannot control");
        srv.setControl(false);
        check(readText(pre, "\"t\":\"control\"").text().contains("\"on\":false"), "control off sent live");
        check(StreamServer.gain(0) == 1 && Math.abs(StreamServer.gain(-20) - 0.1f) < 1e-4 && StreamServer.gain(Float.NEGATIVE_INFINITY) == 0,
                "volume steps in dB become gain: 0 dB = 1, -20 dB = 0.1, muted = 0");

        // A viewer that stops reading is reset to the next keyframe instead of piling up latency
        Ws slow = new Ws(port, 4096);
        slow.sendText("{\"t\":\"auth\",\"pin\":\"" + PIN + "\",\"name\":\"slow\"}");
        check(slow.read().text().contains("\"ok\":true"), "slow auth ok");
        srv.sendVideoFrame(new byte[10], 0, 10, true, 5);
        srv.takeDrops();
        int keysBefore = keyRequests.get();
        byte[] big = new byte[100_000];
        long end = System.nanoTime() + 1_500_000_000L;
        while (System.nanoTime() < end) {
            srv.sendVideoFrame(big, 0, big.length, false, 6);
            drain(pre);
            Thread.sleep(10);
        }
        int drops = srv.takeDrops();
        check(drops > 0, "lagging viewer queue was reset (drops=" + drops + ")");
        check(keyRequests.get() > keysBefore, "keyframe requested after reset");
        srv.sendVideoFrame(new byte[] {5}, 0, 1, true, 7);
        // Read everything the slow viewer has; after the reset it must see video info, config and the key in that order.
        List<Msg> got = new ArrayList<>();
        Msg m;
        while ((m = slow.readOrNull(1500)) != null) got.add(m);
        int vi = -1;
        for (int i = 0; i < got.size(); i++) if (got.get(i).op == 1 && got.get(i).text().contains("\"t\":\"video\"")) vi = i;
        check(vi >= 0 && vi + 2 < got.size(), "resync video info present (" + got.size() + " msgs)");
        check(got.get(vi + 1).data[0] == StreamServer.VIDEO_CONFIG, "resync config");
        Msg k = got.get(vi + 2);
        check(k.data[0] == StreamServer.VIDEO_FRAME && k.data[1] == 1 && k.data.length == 11, "resync keyframe, no delta before it");
        check(got.size() < 100, "queue stayed bounded (" + got.size() + " msgs)");

        // bye on stop
        drain(pre);
        srv.stop();
        check(readText(pre, "\"t\":\"bye\"") != null, "bye on stop");

        // Lockout: 5 wrong PINs lock the IP for 60 s, even for the right PIN
        StreamServer lock = new StreamServer("Lock", PIN, n -> null);
        int lp = lock.start(0, 0);
        for (int i = 1; i <= 5; i++) {
            Ws w = new Ws(lp, 0);
            w.sendText("{\"t\":\"auth\",\"pin\":\"000000\",\"name\":\"x\"}");
            String a = w.read().text();
            check(a.contains("\"ok\":false") && a.contains("\"locked\":" + (i == 5 ? "60" : "0")), "wrong pin " + i + ": " + a);
            check(w.readOrNull(1000) == null || w.closed, "closed after wrong pin");
        }
        Ws w = new Ws(lp, 0);
        w.sendText("{\"t\":\"auth\",\"pin\":\"" + PIN + "\",\"name\":\"x\"}");
        String a = w.read().text();
        check(a.contains("\"ok\":false") && !a.contains("\"locked\":0"), "locked even with right pin: " + a);
        lock.stop();
    }

    // ---- helpers ----

    static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
        System.out.println("ok  " + what);
    }

    static String http(int port, String requestLine) throws IOException {
        try (Socket s = new Socket("127.0.0.1", port)) {
            s.setSoTimeout(3000);
            s.getOutputStream().write((requestLine + "\r\nHost: x\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            byte[] buf = new byte[65536];
            int n, total = 0;
            while ((n = s.getInputStream().read(buf, total, buf.length - total)) > 0) total += n;
            return new String(buf, 0, total, StandardCharsets.UTF_8);
        }
    }

    static void drain(Ws ws) throws IOException {
        while (ws.readOrNull(1) != null) { }
    }

    static Msg readText(Ws ws, String needle) throws IOException {
        for (int i = 0; i < 1000; i++) {
            Msg m = ws.readOrNull(2000);
            if (m == null) return null;
            if (m.op == 1 && m.text().contains(needle)) return m;
        }
        return null;
    }

    static final class Msg {
        int op;
        byte[] data;

        String text() {
            return new String(data, StandardCharsets.UTF_8);
        }
    }

    static final class Ws {
        final Socket s;
        final DataInputStream in;
        final OutputStream out;
        boolean closed;

        Ws(int port, int rcvBuf) throws IOException {
            s = new Socket();
            if (rcvBuf > 0) s.setReceiveBufferSize(rcvBuf);
            s.connect(new InetSocketAddress("127.0.0.1", port));
            s.setSoTimeout(3000);
            out = s.getOutputStream();
            in = new DataInputStream(s.getInputStream());
            out.write(("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            StringBuilder head = new StringBuilder();
            while (!head.toString().endsWith("\r\n\r\n")) head.append((char) in.readUnsignedByte());
            check(head.toString().startsWith("HTTP/1.1 101") && head.toString().contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "ws handshake");
        }

        void sendText(String t) throws IOException {
            byte[] p = t.getBytes(StandardCharsets.UTF_8);
            byte[] mask = {1, 2, 3, 4};
            byte[] f = new byte[2 + 4 + p.length];
            f[0] = (byte) 0x81;
            f[1] = (byte) (0x80 | p.length);
            System.arraycopy(mask, 0, f, 2, 4);
            for (int i = 0; i < p.length; i++) f[6 + i] = (byte) (p[i] ^ mask[i & 3]);
            out.write(f);
            out.flush();
        }

        Msg read() throws IOException {
            Msg m = readOrNull(3000);
            if (m == null) throw new AssertionError("expected a message");
            return m;
        }

        Msg readOrNull(int timeoutMs) throws IOException {
            if (closed) return null;
            s.setSoTimeout(timeoutMs);
            try {
                int b0 = in.readUnsignedByte();
                s.setSoTimeout(3000);
                int b1 = in.readUnsignedByte();
                long len = b1 & 0x7f;
                if (len == 126) len = in.readUnsignedShort();
                else if (len == 127) len = in.readLong();
                Msg m = new Msg();
                m.op = b0 & 0x0f;
                m.data = new byte[(int) len];
                in.readFully(m.data);
                if (m.op == 0x9) return readOrNull(timeoutMs);   // skip keepalive pings
                if (m.op == 0x8) {
                    closed = true;
                    return null;
                }
                return m;
            } catch (SocketTimeoutException e) {
                return null;
            } catch (EOFException e) {
                closed = true;
                return null;
            } catch (IOException e) {
                closed = true;
                return null;
            }
        }
    }
}
