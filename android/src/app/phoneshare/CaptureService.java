package app.phoneshare;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Display;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** Foreground service that owns the projection, the encoder, audio capture and the server for one streaming session. */
public final class CaptureService extends Service {
    static final String ACTION_STOP = "app.phoneshare.STOP";
    static final String EXTRA_CODE = "code", EXTRA_DATA = "data";

    /** Running session, read by MainActivity. */
    static volatile CaptureService instance;
    /** Set by MainActivity; always called on the main thread. */
    static volatile Runnable onStateChanged;
    static volatile String lastError;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private StreamServer server;
    private ScreenEncoder encoder;
    private AudioRecord record;
    private volatile boolean audioRunning;
    private AudioManager am;
    private int level;   // the phone's media volume step the PC follows; kept while "only PC" mutes the phone
    private boolean listening;
    private WifiManager.WifiLock wifiLock;
    private WifiManager.MulticastLock multicastLock;

    volatile int port;
    volatile boolean audioOn;
    volatile List<String> viewers = Collections.emptyList();

    // ---- prefs ----

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("phoneshare", MODE_PRIVATE);
    }

    static String pin(Context c) {
        String p = prefs(c).getString("pin", null);
        if (p == null) {
            p = newPin();
            prefs(c).edit().putString("pin", p).apply();
        }
        return p;
    }

    /**
     * {long side px, fps} the user picked. Before 1.1 one preset set both; its choice carries over:
     * economy 1280/30, balance 1920/60, maximum 2560/60.
     */
    static int[] video(Context c) {
        SharedPreferences p = prefs(c);
        int preset = Math.max(0, Math.min(2, p.getInt("preset", 1)));
        int size = p.getInt("size", new int[] {1280, 1920, 2560}[preset]);
        int fps = p.getInt("fps", preset == 0 ? 30 : 60);
        return new int[] {atMost(sizes(c), size), atMost(fpsStops(c), fps)};
    }

    /** Sharpness stops this phone offers: the sizes below its screen, then the screen's own (at most 2560 px). */
    static int[] sizes(Context c) {
        int[] d = ScreenEncoder.displaySize(c);
        int[] all = StreamServer.SIZES;
        int top = Math.min(Math.max(d[0], d[1]), all[all.length - 1]);
        int[] out = new int[all.length + 1];
        int n = 0;
        for (int s : all) if (s < top) out[n++] = s;
        out[n++] = top;
        return Arrays.copyOf(out, n);
    }

    /** Smoothness stops up to the screen's refresh rate: 15 to 60 everywhere, 90 and 120 on fast screens. */
    static int[] fpsStops(Context c) {
        float hz = 60;
        Display d = c.getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
        if (d != null) for (Display.Mode m : d.getSupportedModes()) hz = Math.max(hz, m.getRefreshRate());
        int n = 0;
        for (int f : StreamServer.FPS) if (f <= Math.round(hz)) n++;
        return Arrays.copyOf(StreamServer.FPS, n);
    }

    /** The largest stop not above v, or the first stop. */
    static int atMost(int[] stops, int v) {
        int r = stops[0];
        for (int s : stops) if (s <= v) r = s;
        return r;
    }

    /** Applies the saved sharpness and smoothness to a running stream right away. */
    void retune() {
        int[] v = video(this);
        if (encoder != null) encoder.retune(v[0], StreamServer.targetBitrate(v[0], v[1]), v[1]);
    }

    static String newPin() {
        return String.format(Locale.ROOT, "%06d", new SecureRandom().nextInt(1_000_000));
    }

    void setPin(String pin) {
        if (server != null) server.setPin(pin);
    }

    // ---- lifecycle ----

    @Override public IBinder onBind(Intent intent) {
        return null;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction()) || instance != null) {
            if (intent != null && ACTION_STOP.equals(intent.getAction())) stopSelf();
            return START_NOT_STICKY;
        }
        // Android 14+: the service must be in the foreground before the projection token is used.
        startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        try {
            begin(intent.getIntExtra(EXTRA_CODE, 0), intent.getParcelableExtra(EXTRA_DATA));
            instance = this;
            lastError = null;
        } catch (Exception e) {
            StreamServer.log("start failed: " + e);
            lastError = e.getMessage() == null ? e.toString() : e.getMessage();
            cleanup();
            stopSelf();
        }
        changed();
        return START_NOT_STICKY;
    }

    private void begin(int code, Intent data) throws IOException {
        MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
        projection = mpm.getMediaProjection(code, data);
        if (projection == null) throw new IOException("нет разрешения на запись экрана");
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() {
                stopSelf();   // the user revoked capture from the status bar or the system ended it
            }

            @Override public void onCapturedContentResize(int width, int height) {
                if (encoder != null) encoder.onContentResize(width, height);
                applyControl();   // one app instead of the screen: taps would miss, so control pauses
            }
        }, main);

        WifiManager wifi = getApplicationContext().getSystemService(WifiManager.class);
        wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "PhoneShare");   // no power-save latency spikes
        wifiLock.acquire();
        multicastLock = wifi.createMulticastLock("PhoneShare");   // receive discovery broadcasts while the screen is off
        multicastLock.acquire();

        am = getSystemService(AudioManager.class);
        level = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        IntentFilter volumeChanged = new IntentFilter(VOLUME_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(volumeKeys, volumeChanged, RECEIVER_NOT_EXPORTED);   // a system broadcast
        else registerReceiver(volumeKeys, volumeChanged);
        listening = true;

        boolean wantAudio = prefs(this).getBoolean("audio", true)
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        server = new StreamServer(deviceName(), pin(this), this::asset);
        server.onViewersChanged = () -> main.post(() -> {
            viewers = server == null ? Collections.<String>emptyList() : server.viewers();
            updateNotification();
            changed();
        });
        audioOn = wantAudio && startAudio();
        server.setAudioFormat(audioOn ? 48000 : 0, 2);
        applySpeaker();
        server.onControl = m -> main.post(() -> {
            ControlService c = ControlService.instance;
            if (c != null && controlReady()) c.perform(m);
        });
        port = server.start(StreamServer.HTTP_PORT, StreamServer.DISCOVERY_PORT);

        int[] v = video(this);
        encoder = new ScreenEncoder(this, projection, server, main, v[0], StreamServer.targetBitrate(v[0], v[1]), v[1]);
        server.onKeyframeNeeded = encoder::requestKeyframe;
        encoder.start();
        applyControl();
        updateNotification();
    }

    // ---- control from the PC: taps, keys and the system buttons, performed by ControlService ----

    /** The person allowed it, the accessibility service runs, and the picture is the whole screen. */
    boolean controlReady() {
        return prefs(this).getBoolean("control", false) && ControlService.instance != null && !singleApp();
    }

    boolean singleApp() {
        ScreenEncoder e = encoder;
        return e != null && e.singleApp();
    }

    /** Tells the viewers whether they may control the phone now; they show or hide their control button. */
    void applyControl() {
        StreamServer s = server;
        if (s != null) s.setControl(controlReady());
        changed();
    }

    @Override public void onDestroy() {
        cleanup();
        instance = null;
        changed();
        super.onDestroy();
    }

    private void cleanup() {
        if (listening) unregisterReceiver(volumeKeys);
        listening = false;
        stopAudio();
        audioOn = false;
        applySpeaker();   // the phone gets its sound back
        if (encoder != null) encoder.stop();
        encoder = null;
        if (server != null) server.stop();
        server = null;
        if (projection != null) projection.stop();
        projection = null;
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        port = 0;
        viewers = Collections.emptyList();
    }

    private void changed() {
        Runnable r = onStateChanged;
        if (r != null) main.post(r);
    }

    // ---- sound: on or off, on the phone too or only on the PC, and the PC follows the phone's volume ----
    // Playback capture only copies the sound (unlike scrcpy's REMOTE_SUBMIX, which a shell may use) and copies it at full
    // level whatever the phone's volume. So "only PC" mutes the phone's media stream while sound streams, and the
    // phone's volume step travels to the viewers, which play at that level.

    static final String VOLUME_CHANGED = "android.media.VOLUME_CHANGED_ACTION";
    private static final String EXTRA_STREAM = "android.media.EXTRA_VOLUME_STREAM_TYPE", EXTRA_VALUE = "android.media.EXTRA_VOLUME_STREAM_VALUE";

    /** Turns sound on or off in a running stream; viewers hear the change at once, the picture goes on. */
    void setAudio(boolean on) {
        if (server == null) return;
        if (on && !audioOn) {
            audioOn = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED && startAudio();
        } else if (!on && audioOn) {
            stopAudio();
            audioOn = false;
        }
        server.setAudioFormat(audioOn ? 48000 : 0, 2);
        applySpeaker();
        changed();
    }

    /** "Only PC": the phone's media stream stays muted while its sound streams; leaving that state gives it back. */
    void applySpeaker() {
        if (am == null) return;
        boolean silence = audioOn && prefs(this).getBoolean("audio_pc_only", false);
        boolean ours = prefs(this).getBoolean("muted_by_app", false);
        if (silence && !ours && !am.isStreamMute(AudioManager.STREAM_MUSIC)) {
            level = am.getStreamVolume(AudioManager.STREAM_MUSIC);
            prefs(this).edit().putBoolean("muted_by_app", true).apply();
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, 0);
        } else if (!silence && ours) {
            unmute(this);
        }
        sendVolume();
    }

    /** Gives the phone its sound back if this app muted it (also after a crash, from MainActivity). */
    static void unmute(Context c) {
        prefs(c).edit().putBoolean("muted_by_app", false).apply();
        c.getSystemService(AudioManager.class).adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0);
    }

    /**
     * Volume keys. The broadcast carries the new step even while the stream is muted (a key down keeps the mute, a key up
     * lifts it), so "only PC" follows both directions; a key that lifted our mute is answered by muting again.
     */
    private final BroadcastReceiver volumeKeys = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (am == null || i.getIntExtra(EXTRA_STREAM, -1) != AudioManager.STREAM_MUSIC) return;
            int step = i.getIntExtra(EXTRA_VALUE, -1);
            if (step >= 0) level = step;
            boolean ours = prefs(c).getBoolean("muted_by_app", false);
            if (ours && !am.isStreamMute(AudioManager.STREAM_MUSIC)) am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, 0);
            sendVolume();
        }
    };

    private void sendVolume() {
        StreamServer s = server;
        if (s == null || am == null) return;
        boolean ours = prefs(this).getBoolean("muted_by_app", false);
        int step = !ours && am.isStreamMute(AudioManager.STREAM_MUSIC) ? 0 : level;   // muted by the person: silence on the PC too
        float gain = 0;
        if (step > 0) {
            try {   // the phone's own loudness curve for its speaker
                gain = StreamServer.gain(am.getStreamVolumeDb(AudioManager.STREAM_MUSIC, step, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER));
            } catch (IllegalArgumentException e) {
                gain = (float) step / am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            }
        }
        s.setVolume(gain);
    }

    private void stopAudio() {
        audioRunning = false;
        AudioRecord r = record;
        record = null;
        if (r == null) return;
        try {
            r.stop();   // unblocks the reader thread, which then sees audioRunning off
        } catch (IllegalStateException ignored) {
        }
        r.release();
    }

    private boolean startAudio() {
        try {
            AudioPlaybackCaptureConfiguration cfg = new AudioPlaybackCaptureConfiguration.Builder(projection)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .build();
            AudioFormat fmt = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(48000)
                    .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                    .build();
            int min = AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
            record = new AudioRecord.Builder()
                    .setAudioFormat(fmt)
                    .setBufferSizeInBytes(Math.max(min, 19200))   // 100 ms
                    .setAudioPlaybackCaptureConfig(cfg)
                    .build();
            record.startRecording();
        } catch (RuntimeException e) {
            StreamServer.log("audio capture unavailable: " + e);
            if (record != null) record.release();
            record = null;
            return false;
        }
        audioRunning = true;
        final AudioRecord r = record;
        Thread t = new Thread(() -> {
            byte[] buf = new byte[3840];   // 20 ms
            while (audioRunning) {
                int n = r.read(buf, 0, buf.length);
                if (n <= 0) {
                    if (n < 0) break;
                    continue;
                }
                StreamServer s = server;
                // ponytail: silence is not sent at all (saves 1.5 Mbit/s); viewers treat the gap as silence
                if (s != null && !silent(buf, n)) s.sendAudio(buf, 0, n, System.nanoTime() / 1000);
            }
        }, "ps-audio");
        t.start();
        return true;
    }

    private static boolean silent(byte[] b, int n) {
        for (int i = 0; i < n; i++) if (b[i] != 0) return false;
        return true;
    }

    // ---- helpers ----

    private byte[] asset(String name) {
        try (InputStream in = getAssets().open("web/" + name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (IOException e) {
            return null;
        }
    }

    private String deviceName() {
        String n = Settings.Global.getString(getContentResolver(), Settings.Global.DEVICE_NAME);
        if (n == null || n.trim().isEmpty()) n = Build.MANUFACTURER + " " + Build.MODEL;
        return n.trim();
    }

    private Notification notification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("stream", getString(R.string.channel), NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, CaptureService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        int n = viewers.size();
        String text = port == 0 ? "" : n == 0 ? "Пока никто не смотрит" : "Смотрят: " + n;
        return new Notification.Builder(this, "stream")
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(getString(R.string.notif_title))
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, getString(R.string.stop), stop).build())
                .build();
    }

    private void updateNotification() {
        getSystemService(NotificationManager.class).notify(1, notification());
    }
}
