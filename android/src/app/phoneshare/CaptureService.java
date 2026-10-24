package app.phoneshare;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
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

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** Foreground service that owns the projection, the encoder, audio capture and the server for one streaming session. */
public final class CaptureService extends Service {
    static final String ACTION_STOP = "app.phoneshare.STOP";
    static final String EXTRA_CODE = "code", EXTRA_DATA = "data";

    // quality presets: max long side, bitrate, fps
    static final int[][] PRESETS = {{1280, 4_000_000, 30}, {1920, 8_000_000, 60}, {2560, 16_000_000, 60}};

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
            }
        }, main);

        WifiManager wifi = getApplicationContext().getSystemService(WifiManager.class);
        wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "PhoneShare");   // no power-save latency spikes
        wifiLock.acquire();
        multicastLock = wifi.createMulticastLock("PhoneShare");   // receive discovery broadcasts while the screen is off
        multicastLock.acquire();

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
        port = server.start(StreamServer.HTTP_PORT, StreamServer.DISCOVERY_PORT);

        int[] p = PRESETS[Math.max(0, Math.min(2, prefs(this).getInt("preset", 1)))];
        encoder = new ScreenEncoder(this, projection, server, main, p[0], p[1], p[2]);
        server.onKeyframeNeeded = encoder::requestKeyframe;
        encoder.start();
        updateNotification();
    }

    @Override public void onDestroy() {
        cleanup();
        instance = null;
        changed();
        super.onDestroy();
    }

    private void cleanup() {
        audioRunning = false;
        if (encoder != null) encoder.stop();
        encoder = null;
        if (record != null) {
            try {
                record.stop();
            } catch (IllegalStateException ignored) {
            }
            record.release();
            record = null;
        }
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

    // ---- audio: playback capture keeps the sound playing on the phone, unlike scrcpy's REMOTE_SUBMIX ----

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
