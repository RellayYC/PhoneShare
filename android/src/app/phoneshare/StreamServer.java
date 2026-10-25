package app.phoneshare;

import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * HTTP + WebSocket + UDP discovery server. Pure Java on purpose: the phone runs it,
 * and dev/FakePhone runs the same class on a desktop JDK.
 *
 * WebSocket binary message: [type u8][flags u8][pts_us i64 BE][payload].
 */
public final class StreamServer {
    public static final int PROTOCOL = 1;
    public static final int HTTP_PORT = 8080;
    public static final int DISCOVERY_PORT = 47800;
    public static final String DISCOVERY_QUERY = "PHONESHARE?";

    static final byte VIDEO_CONFIG = 1, VIDEO_FRAME = 2, AUDIO = 3;
    static final int FLAG_KEY = 1;
    static final long MAX_LAG_NS = 200_000_000L;   // older than this in a viewer queue = drop to keyframe
    static final int MAX_VIEWERS = 8;
    static final int MAX_SOCKETS = 32;
    static final int MAX_FAILURES = 5;
    static final long LOCK_MS = 60_000;
    static final int MIN_BITRATE = 1_000_000, MAX_BITRATE = 25_000_000;
    /** Picture sharpness (long side, px) and smoothness (frames per second) the phone app offers; chosen separately. */
    static final int[] SIZES = {720, 960, 1280, 1600, 1920, 2560}, FPS = {15, 30, 45, 60, 90, 120};
    private static final int[] BITRATE_AT_30 = {1_600_000, 2_500_000, 4_000_000, 5_000_000, 6_000_000, 10_000_000};
    static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    static final Pattern ASSET_NAME = Pattern.compile("[A-Za-z0-9._-]+");

    private final String name;
    /** Random per run: a phone reachable through several of the PC's adapters is listed once. */
    private final String id = Long.toHexString(java.util.concurrent.ThreadLocalRandom.current().nextLong());
    private final Function<String, byte[]> assets;
    private volatile String pin;
    private volatile String audioJson = "null";
    private volatile float volume = 1;   // the phone's media volume as linear gain; viewers multiply their own by it
    private volatile boolean control;    // the phone takes taps, keys and buttons from viewers
    private volatile String videoInfo;      // {"t":"video",...} for the current encoder
    private volatile byte[] configPacket;   // SPS+PPS packet for the current encoder

    /** Called (rate-limited) when some viewer needs a fresh keyframe. */
    public volatile Runnable onKeyframeNeeded;
    /** Called when the list of authenticated viewers changes. */
    public volatile Runnable onViewersChanged;
    /** Gets "gesture", "text" and "nav" messages from viewers that entered the PIN; the phone performs them. */
    public volatile java.util.function.Consumer<String> onControl;

    private final CopyOnWriteArrayList<Client> clients = new CopyOnWriteArrayList<>();
    private final Map<String, long[]> failures = new HashMap<>();   // ip -> {count, lockedUntilMs}
    private final AtomicInteger sockets = new AtomicInteger();
    private final AtomicInteger drops = new AtomicInteger();
    private final AtomicLong lastKeyRequest = new AtomicLong();
    private volatile boolean keyPending;   // a request the rate limit held back; the frame path sends it later
    private ServerSocket serverSocket;
    private DatagramSocket udp;
    private volatile boolean running;
    private int port;

    public StreamServer(String name, String pin, Function<String, byte[]> assets) {
        this.name = name;
        this.pin = pin;
        this.assets = assets;
    }

    // ---- lifecycle ----

    /** Binds the first free TCP port in [httpPort, httpPort+9] and the UDP port (0 = no discovery). */
    public int start(int httpPort, int udpPort) throws IOException {
        IOException last = null;
        for (int p = httpPort; p < httpPort + 10 && serverSocket == null; p++) {
            try {
                ServerSocket s = new ServerSocket();
                s.setReuseAddress(true);
                s.bind(new java.net.InetSocketAddress(p));
                serverSocket = s;
                port = s.getLocalPort();
            } catch (IOException e) {
                last = e;
            }
        }
        if (serverSocket == null) throw last;
        running = true;
        thread("accept", this::acceptLoop);
        if (udpPort > 0) {
            try {
                udp = new DatagramSocket(null);
                udp.setReuseAddress(true);
                udp.bind(new java.net.InetSocketAddress(udpPort));
                thread("discovery", this::discoveryLoop);
            } catch (IOException e) {
                log("discovery disabled: " + e.getMessage());
            }
        }
        log("listening on :" + port);
        return port;
    }

    public void stop() {
        running = false;
        for (Client c : clients) c.send(text("{\"t\":\"bye\"}"));
        try { Thread.sleep(150); } catch (InterruptedException ignored) { }
        for (Client c : clients) c.close();
        closeQuietly(serverSocket);
        if (udp != null) udp.close();
    }

    public int port() { return port; }
    public void setPin(String pin) { this.pin = pin; }

    /** Audio format announced to viewers; rate 0 = no audio. A change reaches viewers already watching too. */
    public void setAudioFormat(int rate, int channels) {
        String json = rate <= 0 ? "null" : "{\"rate\":" + rate + ",\"ch\":" + channels + "}";
        if (json.equals(audioJson)) return;
        audioJson = json;
        Out o = text("{\"t\":\"audio\",\"audio\":" + json + "}");
        for (Client c : authed()) c.send(o);
    }

    /** The phone's media volume as linear gain 0..1, sent to every viewer when it changes. */
    public void setVolume(float gain) {
        float v = Math.max(0, Math.min(1, gain));
        if (v == volume) return;
        volume = v;
        Out o = text("{\"t\":\"volume\",\"v\":" + volumeText(v) + "}");
        for (Client c : authed()) c.send(o);
    }

    /** Whether viewers may control the phone; they hear about a change at once. */
    public void setControl(boolean on) {
        if (on == control) return;
        control = on;
        Out o = text("{\"t\":\"control\",\"on\":" + on + "}");
        for (Client c : authed()) c.send(o);
    }

    static String volumeText(float v) {
        return String.format(Locale.ROOT, "%.3f", v);
    }

    /** Linear gain for a volume step in decibels (negative infinity, i.e. step 0, is silence). */
    public static float gain(float db) {
        return db <= -96 || Float.isNaN(db) ? 0 : (float) Math.min(1, Math.pow(10, db / 20));
    }

    public List<String> viewers() {
        List<String> out = new ArrayList<>();
        for (Client c : clients) if (c.authed) out.add(c.name + " (" + c.ip + ")");
        return out;
    }

    /** Number of viewer queue resets since the last call. */
    public int takeDrops() { return drops.getAndSet(0); }

    // ---- media input ----

    /** New encoder geometry. Every viewer waits for the next config + keyframe. */
    public void setVideoSize(int width, int height) {
        videoInfo = "{\"t\":\"video\",\"w\":" + width + ",\"h\":" + height + "}";
        configPacket = null;
        Out info = text(videoInfo);
        for (Client c : authed()) {
            c.waitingKey = true;
            c.send(info);
        }
    }

    public void sendVideoConfig(byte[] data, int off, int len, long ptsUs) {
        byte[] p = packet(VIDEO_CONFIG, 0, ptsUs, data, off, len);
        configPacket = p;
        Out o = new Out(p, false);
        for (Client c : authed()) c.send(o);
    }

    public void sendVideoFrame(byte[] data, int off, int len, boolean key, long ptsUs) {
        Out o = new Out(packet(VIDEO_FRAME, key ? FLAG_KEY : 0, ptsUs, data, off, len), false);
        if (key) keyPending = false;
        else if (keyPending) requestKeyframe();   // frames keep coming (repeat-previous-frame), so this fires soon
        for (Client c : authed()) {
            checkLag(c);
            if (c.waitingKey) {
                if (!key) continue;
                if (c.needConfig) {
                    String vi = videoInfo;
                    byte[] cfg = configPacket;
                    if (vi != null) c.send(text(vi));
                    if (cfg != null) c.send(new Out(cfg, false));
                    c.needConfig = false;
                }
                c.waitingKey = false;
            }
            c.send(o);
        }
    }

    public void sendAudio(byte[] data, int off, int len, long ptsUs) {
        Out o = new Out(packet(AUDIO, 0, ptsUs, data, off, len), false);
        for (Client c : authed()) {
            checkLag(c);
            c.send(o);
        }
    }

    /** If the oldest unsent item is too old, the viewer is behind: drop its queue and resync on a keyframe. */
    private void checkLag(Client c) {
        Out head = c.queue.peekFirst();
        if (head == null || System.nanoTime() - head.t < MAX_LAG_NS) return;
        c.queue.clear();
        c.waitingKey = true;
        c.needConfig = true;
        drops.incrementAndGet();
        requestKeyframe();
    }

    private void requestKeyframe() {
        long now = System.nanoTime();
        long last = lastKeyRequest.get();
        if (now - last < 300_000_000L || !lastKeyRequest.compareAndSet(last, now)) {
            keyPending = true;   // never drop it: a viewer reset right after another request would wait for the 10 s I-frame
            return;
        }
        keyPending = false;
        Runnable r = onKeyframeNeeded;
        if (r != null) r.run();
    }

    /**
     * Bitrate step, called once a second. Drops cut it to 70 %, five quiet seconds raise it by 15 % up to target.
     * ponytail: one encoder for all viewers, so the slowest viewer sets the bitrate for everyone.
     */
    public static int nextBitrate(int current, int target, boolean dropped, int quietSeconds) {
        if (dropped) return Math.max(MIN_BITRATE, (int) (current * 0.7));
        if (quietSeconds >= 5 && current < target) return Math.min(target, (int) (current * 1.15));
        return current;
    }

    /**
     * Target bitrate for a long side (between two SIZES it counts as the larger, e.g. a 2400 px screen as 2560) and
     * any fps: the size's 30 fps rate times (fps/30)^0.6, since each extra frame
     * of the same picture costs less than the last. Rounded to 100 kbps. The old presets land close: 1280@30 = 4,
     * 1920@60 ≈ 9, 2560@60 ≈ 15 Mbps.
     */
    public static int targetBitrate(int longSide, int fps) {
        int i = 0;
        while (i < SIZES.length - 1 && SIZES[i] < longSide) i++;
        double b = BITRATE_AT_30[i] * Math.pow(Math.max(1, fps) / 30.0, 0.6);
        return Math.max(MIN_BITRATE, Math.min(MAX_BITRATE, (int) Math.round(b / 100_000) * 100_000));
    }

    // ---- networking ----

    private void acceptLoop() {
        while (running) {
            try {
                final Socket s = serverSocket.accept();
                if (sockets.incrementAndGet() > MAX_SOCKETS) {
                    sockets.decrementAndGet();
                    closeQuietly(s);
                    continue;
                }
                thread("conn", () -> {
                    try {
                        handle(s);
                    } catch (IOException ignored) {
                    } finally {
                        sockets.decrementAndGet();
                        closeQuietly(s);
                    }
                });
            } catch (IOException e) {
                if (running) log("accept: " + e.getMessage());
            }
        }
    }

    private void handle(Socket s) throws IOException {
        s.setTcpNoDelay(true);
        s.setSoTimeout(10_000);
        DataInputStream in = new DataInputStream(s.getInputStream());
        String head = readHead(in);
        String[] lines = head.split("\r\n");
        String[] req = lines[0].split(" ");
        if (req.length < 3) return;
        Map<String, String> h = new HashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c > 0) h.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
        }
        OutputStream out = new BufferedOutputStream(s.getOutputStream(), 65536);
        String path = req[1];
        int qm = path.indexOf('?');
        if (qm >= 0) path = path.substring(0, qm);
        if (!req[0].equals("GET")) {
            respond(out, "405 Method Not Allowed", "text/plain", "method not allowed".getBytes(StandardCharsets.UTF_8));
        } else if (path.equals("/ws") && "websocket".equalsIgnoreCase(h.get("upgrade")) && h.containsKey("sec-websocket-key")) {
            webSocket(s, in, out, h.get("sec-websocket-key"));
        } else if (path.equals("/info")) {   // phone name for the PIN screen; the same name is broadcast on UDP anyway
            respond(out, "200 OK", "application/json", ("{\"v\":" + PROTOCOL + ",\"name\":" + q(name) + "}").getBytes(StandardCharsets.UTF_8));
        } else {
            String file = path.equals("/") ? "index.html" : path.substring(1);
            byte[] body = ASSET_NAME.matcher(file).matches() && !file.contains("..") ? assets.apply(file) : null;
            if (body == null) respond(out, "404 Not Found", "text/plain", "not found".getBytes(StandardCharsets.UTF_8));
            else respond(out, "200 OK", contentType(file), body);
        }
    }

    private static String readHead(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int state = 0;
        while (state < 4) {
            int b = in.read();
            if (b < 0) throw new EOFException();
            if (sb.length() > 8192) throw new IOException("header too large");
            sb.append((char) b);
            state = (b == '\r' && (state == 0 || state == 2)) || (b == '\n' && (state == 1 || state == 3)) ? state + 1 : (b == '\r' ? 1 : 0);
        }
        return sb.toString();
    }

    private static void respond(OutputStream out, String status, String type, byte[] body) throws IOException {
        String head = "HTTP/1.1 " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(body);
        out.flush();
    }

    static String contentType(String file) {
        String f = file.toLowerCase(Locale.ROOT);
        if (f.endsWith(".html")) return "text/html; charset=utf-8";
        if (f.endsWith(".js") || f.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (f.endsWith(".css")) return "text/css; charset=utf-8";
        if (f.endsWith(".svg")) return "image/svg+xml";
        if (f.endsWith(".png")) return "image/png";
        if (f.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    static String acceptKey(String key) {
        try {
            byte[] sha = MessageDigest.getInstance("SHA-1").digest((key.trim() + WS_GUID).getBytes(StandardCharsets.US_ASCII));
            return Base64.getEncoder().encodeToString(sha);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void webSocket(Socket s, DataInputStream in, OutputStream out, String key) throws IOException {
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                + acceptKey(key) + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
        final Client c = new Client(s, out);
        clients.add(c);
        thread("ws-writer", c::writeLoop);
        try {
            while (!c.closed) {
                Frame f = readFrame(in);
                if (f.op == 0x8) break;
                if (f.op == 0x9) c.sendFrame(0xA, f.data);
                else if (f.op == 0x1) onMessage(c, new String(f.data, StandardCharsets.UTF_8));
            }
        } catch (IOException ignored) {
        } finally {
            boolean wasAuthed = c.authed;
            c.close();
            clients.remove(c);
            if (wasAuthed) viewersChanged();
        }
    }

    private void onMessage(Client c, String msg) throws IOException {
        String t = field(msg, "t");
        if (!c.authed) {
            if (!"auth".equals(t)) throw new IOException("auth expected");
            authenticate(c, field(msg, "pin"), field(msg, "name"));
            return;
        }
        if ("key".equals(t)) {
            c.waitingKey = true;
            c.needConfig = true;
            requestKeyframe();
        } else if ("gesture".equals(t) || "text".equals(t) || "nav".equals(t)) {
            java.util.function.Consumer<String> k = onControl;
            if (control && k != null) k.accept(msg);   // the phone's owner allowed it; only PIN holders get this far
        } else if ("ping".equals(t)) {
            String cl = field(msg, "c");
            c.send(text("{\"t\":\"time\",\"c\":" + (cl == null ? "0" : cl.replaceAll("[^0-9.\\-]", "")) + ",\"s\":" + System.nanoTime() / 1000 + "}"));
        }
    }

    private void authenticate(Client c, String given, String viewerName) throws IOException {
        long now = System.currentTimeMillis();
        synchronized (failures) {
            long[] f = failures.get(c.ip);
            if (f != null && f[1] > now) {
                c.sendNow("{\"t\":\"auth\",\"ok\":false,\"locked\":" + ((f[1] - now + 999) / 1000) + "}");
                throw new IOException("locked");
            }
            boolean ok = given != null && MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), pin.getBytes(StandardCharsets.UTF_8));
            if (!ok) {
                if (f == null) failures.put(c.ip, f = new long[2]);
                long locked = 0;
                if (++f[0] >= MAX_FAILURES) {
                    f[0] = 0;
                    f[1] = now + LOCK_MS;
                    locked = LOCK_MS / 1000;
                }
                c.sendNow("{\"t\":\"auth\",\"ok\":false,\"locked\":" + locked + "}");
                throw new IOException("wrong pin");
            }
            failures.remove(c.ip);
        }
        if (authed().size() >= MAX_VIEWERS) {
            c.sendNow("{\"t\":\"auth\",\"ok\":false,\"full\":true}");
            throw new IOException("full");
        }
        c.name = cleanName(viewerName);
        c.socket.setSoTimeout(30_000);
        c.send(text("{\"t\":\"auth\",\"ok\":true}"));
        c.send(text("{\"t\":\"hello\",\"v\":" + PROTOCOL + ",\"name\":" + q(name) + ",\"audio\":" + audioJson
                + ",\"vol\":" + volumeText(volume) + ",\"control\":" + control + "}"));
        String vi = videoInfo;
        byte[] cfg = configPacket;
        if (vi != null) c.send(text(vi));
        if (cfg != null) c.send(new Out(cfg, false));
        c.waitingKey = true;
        c.needConfig = cfg == null;
        c.authed = true;
        requestKeyframe();
        viewersChanged();
    }

    private void viewersChanged() {
        Runnable r = onViewersChanged;
        if (r != null) r.run();
    }

    private List<Client> authed() {
        List<Client> out = new ArrayList<>();
        for (Client c : clients) if (c.authed && !c.closed) out.add(c);
        return out;
    }

    private void discoveryLoop() {
        byte[] buf = new byte[512];
        while (running) {
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                udp.receive(p);
                String q = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8).trim();
                if (!q.equals(DISCOVERY_QUERY)) continue;
                byte[] reply = ("{\"t\":\"phoneshare\",\"v\":" + PROTOCOL + ",\"id\":\"" + id + "\",\"name\":" + q(name) + ",\"port\":" + port + "}")
                        .getBytes(StandardCharsets.UTF_8);
                udp.send(new DatagramPacket(reply, reply.length, p.getAddress(), p.getPort()));
            } catch (IOException e) {
                if (running) log("discovery: " + e.getMessage());
            }
        }
    }

    // ---- WebSocket framing ----

    static final class Frame {
        int op;
        byte[] data;
    }

    static Frame readFrame(DataInputStream in) throws IOException {
        int b0 = in.readUnsignedByte();
        int b1 = in.readUnsignedByte();
        long len = b1 & 0x7f;
        if (len == 126) len = in.readUnsignedShort();
        else if (len == 127) len = in.readLong();
        if ((b0 & 0x80) == 0 || len > 65536 || len < 0) throw new IOException("unsupported frame");
        if ((b1 & 0x80) == 0) throw new IOException("unmasked client frame");
        byte[] mask = new byte[4];
        in.readFully(mask);
        Frame f = new Frame();
        f.op = b0 & 0x0f;
        f.data = new byte[(int) len];
        in.readFully(f.data);
        for (int i = 0; i < f.data.length; i++) f.data[i] ^= mask[i & 3];
        return f;
    }

    static void writeFrame(OutputStream o, int opcode, byte[] p) throws IOException {
        int n = p.length;
        byte[] h;
        if (n < 126) {
            h = new byte[] {(byte) (0x80 | opcode), (byte) n};
        } else if (n < 65536) {
            h = new byte[] {(byte) (0x80 | opcode), 126, (byte) (n >> 8), (byte) n};
        } else {
            h = new byte[10];
            h[0] = (byte) (0x80 | opcode);
            h[1] = 127;
            for (int i = 0; i < 8; i++) h[9 - i] = (byte) ((long) n >>> (8 * i));
        }
        o.write(h);
        o.write(p);
        o.flush();
    }

    // ---- per-viewer state ----

    static final class Out {
        final byte[] data;
        final boolean text;
        final long t = System.nanoTime();

        Out(byte[] data, boolean text) {
            this.data = data;
            this.text = text;
        }
    }

    final class Client {
        final Socket socket;
        final OutputStream out;
        final String ip;
        final LinkedBlockingDeque<Out> queue = new LinkedBlockingDeque<>();
        volatile boolean authed, closed, waitingKey = true, needConfig = true;
        volatile String name = "?";

        Client(Socket socket, OutputStream out) {
            this.socket = socket;
            this.out = out;
            InetAddress a = socket.getInetAddress();
            this.ip = a == null ? "?" : a.getHostAddress();
        }

        void send(Out o) {
            if (!closed) queue.offerLast(o);
        }

        /** Bypasses the queue; only used before the writer has anything to send. */
        void sendNow(String json) {
            try {
                sendFrame(0x1, json.getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) {
            }
        }

        synchronized void sendFrame(int op, byte[] data) throws IOException {
            writeFrame(out, op, data);
        }

        void writeLoop() {
            try {
                while (!closed) {
                    Out o = queue.pollFirst(10, TimeUnit.SECONDS);
                    if (closed) break;   // close() wakes the writer with an empty item: nothing may go out after it
                    if (o == null) sendFrame(0x9, new byte[0]);   // keepalive ping; a dead peer fails the write or the read timeout
                    else sendFrame(o.text ? 0x1 : 0x2, o.data);
                }
            } catch (IOException | InterruptedException ignored) {
            } finally {
                close();
            }
        }

        void close() {
            if (closed) return;
            closed = true;
            queue.clear();
            queue.offerLast(new Out(new byte[0], true));   // wake the writer
            closeQuietly(socket);
        }
    }

    // ---- helpers ----

    static Out text(String json) {
        return new Out(json.getBytes(StandardCharsets.UTF_8), true);
    }

    static byte[] packet(byte type, int flags, long ptsUs, byte[] data, int off, int len) {
        byte[] p = new byte[10 + len];
        p[0] = type;
        p[1] = (byte) flags;
        for (int i = 0; i < 8; i++) p[9 - i] = (byte) (ptsUs >>> (8 * i));
        System.arraycopy(data, off, p, 10, len);
        return p;
    }

    /** Reads one string or number field from a flat JSON object. Enough for the three client messages. */
    static String field(String json, String key) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|(-?[0-9.]+))").matcher(json);
        if (!m.find()) return null;
        return m.group(1) != null ? unescape(m.group(1)) : m.group(2);
    }

    /** The escapes JSON.stringify writes: \" \\ \/ \b \f \n \r \t and \\uXXXX (text pasted on the PC has line breaks). */
    private static String unescape(String s) {
        if (s.indexOf('\\') < 0) return s;
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch != '\\' || i + 1 == s.length()) {
                b.append(ch);
                continue;
            }
            char e = s.charAt(++i);
            if (e == 'n') b.append('\n');
            else if (e == 'r') b.append('\r');
            else if (e == 't') b.append('\t');
            else if (e == 'b') b.append('\b');
            else if (e == 'f') b.append('\f');
            else if (e == 'u' && i + 4 < s.length() && s.substring(i + 1, i + 5).matches("[0-9a-fA-F]{4}")) {
                b.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                i += 4;
            } else b.append(e);   // \" \\ \/
        }
        return b.toString();
    }

    static String cleanName(String s) {
        if (s == null) return "?";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length() && b.length() < 40; i++) {
            char ch = s.charAt(i);
            if (ch >= 0x20 && ch != 0x7f) b.append(ch);
        }
        return b.length() == 0 ? "?" : b.toString();
    }

    static String q(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '"' || ch == '\\') b.append('\\').append(ch);
            else if (ch < 0x20) b.append(String.format(Locale.ROOT, "\\u%04x", (int) ch));
            else b.append(ch);
        }
        return b.append('"').toString();
    }

    private static void thread(String name, Runnable r) {
        Thread t = new Thread(r, "ps-" + name);
        t.setDaemon(true);
        t.start();
    }

    private static void closeQuietly(java.io.Closeable c) {
        try {
            if (c != null) c.close();
        } catch (IOException ignored) {
        }
    }

    static void log(String msg) {
        System.out.println("[PhoneShare] " + msg);
    }
}
