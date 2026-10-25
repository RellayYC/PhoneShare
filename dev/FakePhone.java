package app.phoneshare;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Stands in for the phone on a desktop: the real StreamServer fed by ffmpeg test video (H.264 Annex B, like MediaCodec)
 * and a 48 kHz stereo beep (PCM, like AudioPlaybackCapture). Type "quit" on stdin to stop, "volume 0.25" or
 * "audio off|on" to act like the phone's volume keys and sound switch.
 *
 * java app.phoneshare.FakePhone [--pin 135790] [--port 8080] [--udp 47800] [--size 720x1280] [--rotate-every 0] [--name FakePhone] [--web web]
 */
public final class FakePhone {
    static volatile boolean running = true;
    static volatile boolean audioOn = true;   // "audio off" on stdin stops the beep like the phone's switch
    static final List<Process> procs = new ArrayList<>();

    public static void main(String[] a) throws Exception {
        String pin = arg(a, "--pin", "135790"), name = arg(a, "--name", "FakePhone");
        int port = Integer.parseInt(arg(a, "--port", "8080")), udp = Integer.parseInt(arg(a, "--udp", "47800"));
        String[] size = arg(a, "--size", "720x1280").split("x");
        int rotateEvery = Integer.parseInt(arg(a, "--rotate-every", "0"));
        boolean audio = !Arrays.asList(a).contains("--no-audio");
        Path web = Paths.get(arg(a, "--web", "web"));

        StreamServer server = new StreamServer(name, pin, f -> {
            try {
                return Files.readAllBytes(web.resolve(f));
            } catch (IOException e) {
                return null;
            }
        });
        server.onKeyframeNeeded = () -> { };   // ffmpeg emits a keyframe every second anyway (-g 30)
        server.onViewersChanged = () -> {   // UTF-8 on purpose: viewer names are Cyrillic ("ПК …") and stdout is a pipe
            byte[] line = ("FAKEPHONE VIEWERS " + server.viewers() + "\n").getBytes(StandardCharsets.UTF_8);
            synchronized (System.out) {
                System.out.write(line, 0, line.length);
                System.out.flush();
            }
        };
        server.setAudioFormat(audio ? 48000 : 0, 2);
        int actual = server.start(port, udp);
        System.out.println("FAKEPHONE READY port=" + actual);

        Thread v = new Thread(() -> video(server, Integer.parseInt(size[0]), Integer.parseInt(size[1]), rotateEvery), "video");
        v.setDaemon(true);
        v.start();
        if (audio) {
            Thread t = new Thread(() -> audio(server), "audio");
            t.setDaemon(true);
            t.start();
        }

        // stdin "quit" or EOF (parent died) ends the run and the ffmpeg children with it;
        // "volume 0.25" and "audio off|on" act like the phone's volume keys and sound switch
        StringBuilder line = new StringBuilder();
        int c;
        while ((c = System.in.read()) >= 0) {
            if (c == '\n') {
                String cmd = line.toString().trim();
                if (cmd.equals("quit")) break;
                if (cmd.startsWith("volume ")) server.setVolume(Float.parseFloat(cmd.substring(7)));
                if (cmd.equals("audio off") || cmd.equals("audio on")) {
                    audioOn = cmd.equals("audio on");
                    server.setAudioFormat(audio && audioOn ? 48000 : 0, 2);
                }
                line.setLength(0);
            } else {
                line.append((char) c);
            }
        }
        running = false;
        server.stop();
        synchronized (procs) {
            for (Process p : procs) p.destroyForcibly();
        }
        System.out.println("FAKEPHONE STOPPED");
        System.exit(0);
    }

    static void video(StreamServer server, int w, int h, int rotateEvery) {
        while (running) {
            server.setVideoSize(w, h);
            Process p = start("ffmpeg", "-hide_banner", "-loglevel", "fatal", "-re", "-f", "lavfi", "-i", "testsrc2=size=" + w + "x" + h + ":rate=30",
                    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
                    "-bf", "0", "-g", "30", "-x264-params", "aud=1", "-f", "h264", "-");
            long until = rotateEvery > 0 ? System.nanoTime() + rotateEvery * 1_000_000_000L : Long.MAX_VALUE;
            try {
                readAccessUnits(p.getInputStream(), server, until);
            } catch (IOException ignored) {
            }
            p.destroyForcibly();
            int t = w;
            w = h;
            h = t;
        }
    }

    /** Splits the Annex B stream on access unit delimiters and forwards it the way the phone's encoder loop does. */
    static void readAccessUnits(InputStream in, StreamServer server, long until) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[65536];
        byte[] lastConfig = null;
        int n;
        while (running && System.nanoTime() < until && (n = in.read(chunk)) > 0) {
            buf.write(chunk, 0, n);
            byte[] b = buf.toByteArray();
            List<Integer> aud = new ArrayList<>();
            for (int i = 0; i + 3 < b.length; i++) {
                if (b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 && (b[i + 3] & 0x1f) == 9) aud.add(i > 0 && b[i - 1] == 0 ? i - 1 : i);
            }
            if (aud.size() < 2) continue;
            for (int k = 0; k + 1 < aud.size(); k++) {
                byte[] au = Arrays.copyOfRange(b, aud.get(k), aud.get(k + 1));
                ByteArrayOutputStream config = new ByteArrayOutputStream(), frame = new ByteArrayOutputStream();
                boolean key = false;
                for (byte[] nal : nalus(au)) {
                    int type = nal[0] & 0x1f;
                    ByteArrayOutputStream dst = type == 7 || type == 8 ? config : type == 9 ? null : frame;
                    if (type == 5) key = true;
                    if (dst != null) {
                        dst.write(new byte[] {0, 0, 0, 1});
                        dst.write(nal);
                    }
                }
                long pts = System.nanoTime() / 1000;
                if (config.size() > 0 && !Arrays.equals(config.toByteArray(), lastConfig)) {
                    lastConfig = config.toByteArray();
                    server.sendVideoConfig(lastConfig, 0, lastConfig.length, pts);
                }
                byte[] f = frame.toByteArray();
                if (f.length > 0) server.sendVideoFrame(f, 0, f.length, key, pts);
            }
            int keep = aud.get(aud.size() - 1);
            buf.reset();
            buf.write(b, keep, b.length - keep);
        }
    }

    static List<byte[]> nalus(byte[] au) {
        List<byte[]> out = new ArrayList<>();
        int start = -1;
        for (int i = 0; i + 2 < au.length; i++) {
            if (au[i] == 0 && au[i + 1] == 0 && au[i + 2] == 1) {
                if (start >= 0) out.add(Arrays.copyOfRange(au, start, au[i - 1] == 0 ? i - 1 : i));
                start = i + 3;
                i += 2;
            }
        }
        if (start >= 0 && start < au.length) out.add(Arrays.copyOfRange(au, start, au.length));
        return out;
    }

    static void audio(StreamServer server) {
        Process p = start("ffmpeg", "-hide_banner", "-loglevel", "fatal", "-re", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:beep_factor=4",
                "-ac", "2", "-f", "s16le", "-");
        byte[] chunk = new byte[3840];   // 20 ms of 48 kHz stereo s16le, same as the phone
        try (InputStream in = p.getInputStream()) {
            while (running) {
                int off = 0, n;
                while (off < chunk.length && (n = in.read(chunk, off, chunk.length - off)) > 0) off += n;
                if (off < chunk.length) break;
                if (audioOn) server.sendAudio(chunk, 0, chunk.length, System.nanoTime() / 1000);
            }
        } catch (IOException ignored) {
        }
    }

    static Process start(String... cmd) {
        try {
            Process p = new ProcessBuilder(cmd).redirectError(ProcessBuilder.Redirect.INHERIT).start();
            synchronized (procs) {
                procs.add(p);
            }
            return p;
        } catch (IOException e) {
            throw new IllegalStateException("cannot start " + cmd[0], e);
        }
    }

    static String arg(String[] a, String k, String d) {
        for (int i = 0; i + 1 < a.length; i++) if (a[i].equals(k)) return a[i + 1];
        return d;
    }
}
