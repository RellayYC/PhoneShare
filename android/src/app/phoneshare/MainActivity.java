package app.phoneshare;

import android.Manifest;
import android.animation.LayoutTransition;
import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.TransitionDrawable;
import android.graphics.Typeface;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.PathInterpolator;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final int REQ_PROJECTION = 1, REQ_PERMISSIONS = 2, REQ_AUDIO = 3;
    private static final String ACTION_INSTALL = "app.phoneshare.INSTALL";
    private static final long UPDATE_EVERY = 3600_000L;   // while the app is open, and when it opens after that long
    private static long checkedAt = -UPDATE_EVERY;   // per process: reopening the app does not ask GitHub again

    private TextView statusTitle, statusText, error, url, howHint, viewers, qualityHint, audioHint;
    private View statusDot, statusCard;
    private Button toggle, copy, updateGo;
    private View update;
    private TextView updateText;
    private Updater.Release offer;
    private boolean updating;
    private final TextView[] cells = new TextView[6];
    private TextView sizeValue, fpsValue;
    private SeekBar sizeBar, fpsBar;
    private int[] sizes, fpsStops;   // the stops this phone's screen can show
    private boolean dragging;
    private Switch audio;
    private RadioGroup where;
    private TextView version, updateStatus;
    private Button updateCheck;
    private boolean checking;
    private TransitionDrawable statusBg;
    private Boolean shownOn;     // what the status card shows, to fade only on a change
    private String shownPin = "";
    private ProgressBar updateBar;
    private TextView controlHint;
    private Button controlSetup;
    private ObjectAnimator onAir;   // the status dot breathing while the phone is on air
    private static final PathInterpolator EASE = new PathInterpolator(0.2f, 0, 0, 1);   // the page's ease
    private final Runnable render = this::render;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        statusTitle = findViewById(R.id.status_title);
        statusText = findViewById(R.id.status_text);
        statusDot = findViewById(R.id.status_dot);
        statusCard = findViewById(R.id.status_card);
        error = findViewById(R.id.error);
        url = findViewById(R.id.url);
        howHint = findViewById(R.id.how_hint);
        viewers = findViewById(R.id.viewers);
        qualityHint = findViewById(R.id.quality_hint);
        audioHint = findViewById(R.id.audio_hint);
        toggle = findViewById(R.id.toggle);
        copy = findViewById(R.id.copy);
        update = findViewById(R.id.update);
        updateText = findViewById(R.id.update_text);
        updateGo = findViewById(R.id.update_go);
        updateGo.setOnClickListener(v -> applyUpdate());

        // Edge-to-edge (targetSdk 35+): keep content clear of the status and navigation bars.
        View root = findViewById(R.id.root);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
            return insets;
        });

        // PIN cells look exactly like the ones on the PC, so typing is copying.
        LinearLayout row = findViewById(R.id.pin_cells);
        for (int i = 0; i < 6; i++) {
            TextView c = new TextView(this);
            c.setBackgroundResource(R.drawable.bg_cell);
            c.setGravity(Gravity.CENTER);
            c.setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD));
            c.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
            c.setTextColor(getColor(R.color.ink));
            c.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1);
            if (i > 0) lp.setMarginStart(dp(8));
            row.addView(c, lp);
            cells[i] = c;
        }

        toggle.setOnClickListener(v -> {
            if (CaptureService.instance != null) startService(new Intent(this, CaptureService.class).setAction(CaptureService.ACTION_STOP));
            else beginStart();
        });
        copy.setOnClickListener(v -> {
            getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("PhoneShare", url.getText()));
            // the button answers itself: "Адрес скопирован" fades in, then the label comes back
            swapText(copy, getString(R.string.copied));
            copy.removeCallbacks(copyBack);
            copy.postDelayed(copyBack, 1600);
        });
        findViewById(R.id.new_pin).setOnClickListener(v -> {
            String pin = CaptureService.newPin();
            CaptureService.prefs(this).edit().putString("pin", pin).apply();
            CaptureService s = CaptureService.instance;
            if (s != null) s.setPin(pin);
            render();
        });

        // sharpness and smoothness apart: a sharp slow picture or a rough fast one, changed on the fly
        sizeValue = findViewById(R.id.size_value);
        fpsValue = findViewById(R.id.fps_value);
        sizes = CaptureService.sizes(this);
        fpsStops = CaptureService.fpsStops(this);
        int[] video = CaptureService.video(this);
        sizeBar = stops(R.id.size, sizes, video[0]);
        fpsBar = stops(R.id.fps, fpsStops, video[1]);

        // sound on or off, and where it plays: both reach a running stream at once
        audio = findViewById(R.id.audio);
        audio.setChecked(CaptureService.prefs(this).getBoolean("audio", true));
        audio.setOnCheckedChangeListener((b, on) -> {
            CaptureService.prefs(this).edit().putBoolean("audio", on).apply();
            CaptureService s = CaptureService.instance;
            if (s != null && on && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
            } else if (s != null) {
                s.setAudio(on);
            }
            render();
        });
        where = findViewById(R.id.audio_where);
        where.check(CaptureService.prefs(this).getBoolean("audio_pc_only", false) ? R.id.audio_pc : R.id.audio_both);
        where.setOnCheckedChangeListener((g, id) -> {
            CaptureService.prefs(this).edit().putBoolean("audio_pc_only", id == R.id.audio_pc).apply();
            CaptureService s = CaptureService.instance;
            if (s != null) s.applySpeaker();
            render();
        });
        // the app died while "only PC" had the phone muted: give the phone its sound back
        if (CaptureService.instance == null && CaptureService.prefs(this).getBoolean("muted_by_app", false)) CaptureService.unmute(this);

        version = findViewById(R.id.version);
        updateStatus = findViewById(R.id.update_status);
        updateCheck = findViewById(R.id.update_check);
        try {
            version.setText(getString(R.string.version, getPackageManager().getPackageInfo(getPackageName(), 0).versionName));
        } catch (PackageManager.NameNotFoundException ignored) {
        }
        updateCheck.setOnClickListener(v -> checkUpdate(true));
        updateBar = findViewById(R.id.update_bar);

        // control from the PC: allowed here, performed by the accessibility service the person turns on once
        Switch control = findViewById(R.id.control);
        controlHint = findViewById(R.id.control_hint);
        controlSetup = findViewById(R.id.control_setup);
        control.setChecked(CaptureService.prefs(this).getBoolean("control", false));
        control.setOnCheckedChangeListener((b, on) -> {
            CaptureService.prefs(this).edit().putBoolean("control", on).apply();
            if (on && !ControlService.enabled(this)) openAccessibility();
            CaptureService s = CaptureService.instance;
            if (s != null) s.applyControl();
            render();
        });
        controlSetup.setOnClickListener(v -> openAccessibility());

        // cards resize smoothly when their text changes (viewers, hints), not only when one shows or hides
        ViewGroup column = (ViewGroup) ((ViewGroup) findViewById(R.id.root)).getChildAt(0);
        smoothResize(column);
        for (int i = 0; i < column.getChildCount(); i++) if (column.getChildAt(i) instanceof ViewGroup) smoothResize((ViewGroup) column.getChildAt(i));
        // first open: the cards rise in one after another; a rotation or a return keeps them still
        if (state == null && ValueAnimator.areAnimatorsEnabled()) {
            float rise = 16 * getResources().getDisplayMetrics().density;
            for (int i = 0; i < column.getChildCount(); i++) {
                View card = column.getChildAt(i);
                card.setAlpha(0);
                card.setTranslationY(rise);
                card.animate().alpha(1).translationY(0).setStartDelay(i * 45L).setDuration(320).setInterpolator(EASE).start();
            }
        }
    }

    private final Runnable copyBack = () -> swapText(copy, getString(R.string.copy));

    private void openAccessibility() {
        startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
    }

    /** New text with a short fade, for a button that answers its own tap. */
    private static void swapText(TextView v, CharSequence text) {
        v.setText(text);
        v.setAlpha(0.3f);
        v.animate().alpha(1).setDuration(180).setInterpolator(EASE).start();
    }

    private static void smoothResize(ViewGroup g) {
        LayoutTransition t = g.getLayoutTransition();
        if (t == null) g.setLayoutTransition(t = new LayoutTransition());
        t.enableTransitionType(LayoutTransition.CHANGING);
    }

    @Override protected void onResume() {
        super.onResume();
        CaptureService.onStateChanged = render;
        render();   // the network may have changed while we were away
        if (!updating && SystemClock.elapsedRealtime() - checkedAt > UPDATE_EVERY) checkUpdate(false);
        update.postDelayed(hourly, UPDATE_EVERY);
    }

    private final Runnable hourly = new Runnable() {
        @Override public void run() {
            if (!updating) checkUpdate(false);
            update.postDelayed(this, UPDATE_EVERY);
        }
    };

    // ---- updates: Updater checks GitHub, PackageInstaller installs; Android asks the user to confirm unless it may skip that

    /** Asks GitHub for a newer signed release; the answer of a check the person asked for is shown, an automatic one stays quiet. */
    private void checkUpdate(boolean manual) {
        long current;
        try {
            current = getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
        } catch (PackageManager.NameNotFoundException e) {
            return;
        }
        if (checking) return;
        checking = true;
        if (manual) {
            updateCheck.setEnabled(false);
            updateStatus.setVisibility(View.VISIBLE);
            updateStatus.setText(R.string.update_checking);
        }
        new Thread(() -> {
            Updater.Release found = null;
            boolean ok = true;
            try {
                found = Updater.check(Updater.URL, current);
                checkedAt = SystemClock.elapsedRealtime();
            } catch (IOException | RuntimeException e) {
                ok = false;   // offline or a bad release: the stream does not depend on it
            }
            Updater.Release r = found;
            boolean answered = ok;
            runOnUiThread(() -> checked(r, answered, manual));
        }, "update-check").start();
    }

    private void checked(Updater.Release r, boolean ok, boolean manual) {
        checking = false;
        updateCheck.setEnabled(true);
        if (ok && !updating) {
            offer = r;
            showUpdate(r == null ? null : getString(R.string.update_available, r.version), R.string.update);
        }
        if (!manual) return;
        updateStatus.setText(!ok ? getString(R.string.update_check_failed)
                : r == null ? getString(R.string.update_latest) : getString(R.string.update_found, r.version));
        if (ok && r != null) ((ScrollView) findViewById(R.id.root)).smoothScrollTo(0, 0);   // the offer is in the card at the top
    }

    private void showUpdate(String text, int button) {
        update.setVisibility(text == null ? View.GONE : View.VISIBLE);
        updateText.setText(text);
        updateGo.setText(button);
        updateGo.setEnabled(!updating);
    }

    private void applyUpdate() {
        Updater.Release r = offer;
        if (r == null || updating) return;
        if (!getPackageManager().canRequestPackageInstalls()) {
            showUpdate(getString(R.string.update_allow), R.string.update);
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            return;
        }
        updating = true;
        showUpdate(getString(R.string.update_progress, r.version, 0), R.string.update);
        updateBar.setProgress(0);
        updateBar.setVisibility(View.VISIBLE);
        File apk = new File(getCacheDir(), "update.apk");
        new Thread(() -> {
            try {
                Updater.download(Updater.URL, r, apk, p -> runOnUiThread(() -> {
                    updateText.setText(getString(R.string.update_progress, r.version, p));
                    updateBar.setProgress(p, true);
                }));
                runOnUiThread(() -> showUpdate(getString(R.string.update_installing, r.version), R.string.update));
                install(apk);
            } catch (IOException | RuntimeException e) {
                runOnUiThread(() -> updateFailed(e.getMessage()));
            }
        }, "update-download").start();
    }

    private void install(File apk) throws IOException {
        PackageInstaller pi = getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (OutputStream out = s.openWrite("PhoneShare.apk", 0, apk.length()); InputStream in = new FileInputStream(apk)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                s.fsync(out);
            }
            // the result comes back to onNewIntent; the installer fills in its extras, so the intent must be mutable
            Intent done = new Intent(this, MainActivity.class).setAction(ACTION_INSTALL);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getActivity(this, 0, done, flags).getIntentSender());
        } catch (IOException | RuntimeException e) {
            pi.abandonSession(id);
            throw e;
        } finally {
            apk.delete();   // the session holds its own copy
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (!ACTION_INSTALL.equals(intent.getAction())) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) startActivity(confirm);
        } else if (status != PackageInstaller.STATUS_SUCCESS) {   // on success Android restarts nothing: the old process just ends
            String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            updateFailed(status == PackageInstaller.STATUS_FAILURE_ABORTED ? "установка отменена." : msg != null ? msg : "код " + status);
        }
    }

    private void updateFailed(String why) {
        updating = false;
        updateBar.setVisibility(View.GONE);
        showUpdate(getString(R.string.update_failed, why), R.string.update_retry);
    }

    @Override protected void onPause() {
        super.onPause();
        update.removeCallbacks(hourly);
        breathe(false);   // nothing to animate in the background; render() starts it again on return
        if (CaptureService.onStateChanged == render) CaptureService.onStateChanged = null;
    }

    private void beginStart() {
        List<String> need = new ArrayList<>();
        if (CaptureService.prefs(this).getBoolean("audio", true) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (need.isEmpty()) askProjection();
        else requestPermissions(need.toArray(new String[0]), REQ_PERMISSIONS);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code == REQ_PERMISSIONS) askProjection();   // without RECORD_AUDIO the stream is video only
        if (code == REQ_AUDIO) {   // sound switched on mid-stream: without the permission it stays off, and the hint says so
            CaptureService s = CaptureService.instance;
            if (s != null) s.setAudio(true);
            render();
        }
    }

    private void askProjection() {
        startActivityForResult(getSystemService(MediaProjectionManager.class).createScreenCaptureIntent(), REQ_PROJECTION);
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        if (code != REQ_PROJECTION) return;
        if (result != RESULT_OK || data == null) {
            CaptureService.lastError = getString(R.string.projection_denied);
            render();
            return;
        }
        CaptureService.lastError = null;
        startForegroundService(new Intent(this, CaptureService.class)
                .putExtra(CaptureService.EXTRA_CODE, result)
                .putExtra(CaptureService.EXTRA_DATA, data));
    }

    private void render() {
        CaptureService s = CaptureService.instance;
        boolean on = s != null && s.port > 0;

        statusTitle.setText(on ? R.string.status_on : R.string.status_off);
        statusDot.setBackgroundResource(on ? R.drawable.dot_live : R.drawable.dot);
        breathe(on);
        if (statusBg == null) {   // the card lights up like the lamp, fading over 250 ms
            statusBg = new TransitionDrawable(new Drawable[] {getDrawable(R.drawable.bg_card), getDrawable(R.drawable.bg_card_live)});
            statusBg.setCrossFadeEnabled(true);
            statusCard.setBackground(statusBg);
        }
        if (shownOn == null || shownOn != on) {
            int ms = shownOn == null ? 0 : 250;   // no fade when the screen opens
            if (on) statusBg.startTransition(ms);
            else if (shownOn != null) statusBg.reverseTransition(ms);
            shownOn = on;
        }
        toggle.setText(on ? R.string.stop : R.string.start);
        toggle.setBackgroundResource(on ? R.drawable.bg_secondary : R.drawable.bg_primary);
        toggle.setTextColor(getColor(on ? R.color.ink : R.color.on_lamp));
        String err = CaptureService.lastError;
        error.setVisibility(err != null && !on ? View.VISIBLE : View.GONE);
        if (err != null) error.setText(err.equals(getString(R.string.projection_denied)) ? err : getString(R.string.error_start, err));

        List<String> ips = localIps();
        int port = on ? s.port : StreamServer.HTTP_PORT;
        if (ips.isEmpty()) {
            url.setText("—");
            howHint.setText(R.string.no_network);
            copy.setVisibility(View.GONE);
        } else {
            StringBuilder b = new StringBuilder();
            for (String ip : ips) b.append(b.length() == 0 ? "" : "\n").append("http://").append(ip).append(':').append(port);
            url.setText(b);
            howHint.setText(R.string.how_hint);
            copy.setVisibility(View.VISIBLE);
        }
        url.setTextColor(getColor(on ? R.color.ink : R.color.ink2));

        String pin = CaptureService.pin(this);
        for (int i = 0; i < 6; i++) cells[i].setText(String.valueOf(pin.charAt(i)));
        if (!shownPin.isEmpty() && !pin.equals(shownPin)) {   // a new PIN: the digits fade in, left to right
            for (int i = 0; i < 6; i++) {
                cells[i].setAlpha(0);
                cells[i].animate().alpha(1).setStartDelay(i * 30L).setDuration(160).start();
            }
        }
        shownPin = pin;
        findViewById(R.id.pin_cells).setContentDescription("PIN " + pin.replace("", " ").trim());

        List<String> v = on ? s.viewers : Collections.<String>emptyList();
        viewers.setText(v.isEmpty() ? getString(R.string.viewers_none) : String.join("\n", v));
        if (on) statusText.setText(v.isEmpty() ? "Открой адрес ниже на ПК и введи PIN." : "Смотрят: " + v.size());
        else statusText.setText(R.string.status_off_text);

        renderQuality();
        boolean wantControl = CaptureService.prefs(this).getBoolean("control", false);
        boolean serviceOn = ControlService.enabled(this);
        controlSetup.setVisibility(wantControl && !serviceOn ? View.VISIBLE : View.GONE);
        controlHint.setText(!wantControl ? R.string.control_hint_off : !serviceOn ? R.string.control_setup
                : on && s.singleApp() ? R.string.control_single_app : R.string.control_on);
        boolean wantAudio = CaptureService.prefs(this).getBoolean("audio", true);
        boolean audioMissing = on && !s.audioOn && wantAudio;
        audioHint.setText(audioMissing ? R.string.audio_denied : R.string.audio_hint);
        where.setAlpha(wantAudio ? 1 : 0.5f);
        for (int i = 0; i < where.getChildCount(); i++) where.getChildAt(i).setEnabled(wantAudio);
    }

    /** On air, the lamp dot breathes like a tally light; off air it rests. */
    private void breathe(boolean on) {
        if (on && onAir == null && ValueAnimator.areAnimatorsEnabled()) {
            onAir = ObjectAnimator.ofPropertyValuesHolder(statusDot,
                    PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.35f, 1f),
                    PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.35f, 1f),
                    PropertyValuesHolder.ofFloat(View.ALPHA, 1f, 0.7f, 1f));
            onAir.setDuration(1800);
            onAir.setRepeatCount(ValueAnimator.INFINITE);
            onAir.start();
        } else if (!on && onAir != null) {
            onAir.cancel();
            onAir = null;
            statusDot.setScaleX(1);
            statusDot.setScaleY(1);
            statusDot.setAlpha(1);
        }
    }

    private static final int UNIT = 100;   // fine steps between two stops: the thumb follows the finger, then glides to a stop

    /**
     * A slider over stops: the thumb follows the finger and grows while held, the value rolls over at each stop with a
     * tick under the finger, and on release the thumb glides to the nearest stop; the choice is saved then. Keys and
     * TalkBack go stop by stop.
     */
    private SeekBar stops(int id, int[] values, int current) {
        SeekBar bar = findViewById(id);
        bar.setMax((values.length - 1) * UNIT);
        bar.setKeyProgressIncrement(UNIT);
        bar.setTickMark(null);   // one tick per fine step would be hundreds: the stops are drawn under the track instead
        bar.setBackground(stopDots(bar, values.length));   // in place of the system ripple: the thumb has its own halo
        Thumb thumb = new Thumb(getColor(R.color.lamp), dp(8), dp(12));
        bar.setThumb(thumb);
        for (int i = 0; i < values.length; i++) if (values[i] == current) bar.setProgress(i * UNIT);
        bar.setTag(stop(bar));   // the chosen stop; the thumb may still be on its way there
        bar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar b, int progress, boolean fromUser) {
                if (!fromUser) return;   // a glide: its stop is already shown
                int was = chosen(b), now = stop(b);
                if (!dragging) now = Math.max(0, Math.min(values.length - 1, was + Integer.signum(progress - was * UNIT)));   // a key or TalkBack: one whole stop that way
                if (now != was) {
                    b.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
                    b.setTag(now);
                    renderQuality(now - was);
                }
                if (!dragging) {
                    glide(b, now * UNIT);
                    saveQuality();
                }
            }
            @Override public void onStartTrackingTouch(SeekBar b) {
                dragging = true;
                thumb.press(true);
            }
            @Override public void onStopTrackingTouch(SeekBar b) {
                dragging = false;
                thumb.press(false);
                glide(b, chosen(b) * UNIT);
                saveQuality();   // one encoder rebuild per drag, not one per stop
            }
        });
        return bar;
    }

    /** The stop nearest the thumb. */
    private static int stop(SeekBar bar) {
        return Math.round(bar.getProgress() / (float) UNIT);
    }

    /** The stop the person chose (shown, saved, and where the thumb goes). */
    private static int chosen(SeekBar bar) {
        return (Integer) bar.getTag();
    }

    /** The thumb slides to a stop instead of jumping there (instantly when the system turns animations off). */
    private static void glide(SeekBar bar, int progress) {
        ObjectAnimator a = ObjectAnimator.ofInt(bar, "progress", bar.getProgress(), progress);
        a.setDuration(200);
        a.setInterpolator(EASE);
        a.start();
    }

    /** The stops of a slider: dots on the track where its values are. */
    private Drawable stopDots(SeekBar bar, int count) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(getColor(R.color.ink2));
        float r = dp(2);
        return new Drawable() {
            @Override public void draw(Canvas c) {
                Rect b = getBounds();
                float x0 = b.left + bar.getPaddingLeft(), w = b.width() - bar.getPaddingLeft() - bar.getPaddingRight();
                for (int i = 0; i < count; i++) c.drawCircle(count < 2 ? x0 : x0 + w * i / (count - 1), b.exactCenterY(), r, p);
            }
            @Override public void setAlpha(int alpha) { p.setAlpha(alpha); }
            @Override public void setColorFilter(ColorFilter f) { p.setColorFilter(f); }
            @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        };
    }

    /** The slider's thumb: a lamp-coloured dot that swells, with a soft halo, while the finger holds it. */
    private static final class Thumb extends Drawable {
        private final Paint dot = new Paint(Paint.ANTI_ALIAS_FLAG), halo = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final int radius, size;
        private float held;   // 0 at rest, 1 while held
        private ValueAnimator anim;

        Thumb(int color, int radius, int haloRadius) {
            dot.setColor(color);
            halo.setColor(color);
            this.radius = radius;
            size = haloRadius * 2;
        }

        void press(boolean on) {
            if (anim != null) anim.cancel();
            anim = ValueAnimator.ofFloat(held, on ? 1 : 0);
            anim.setDuration(on ? 160 : 220);
            anim.setInterpolator(EASE);
            anim.addUpdateListener(a -> { held = (float) a.getAnimatedValue(); invalidateSelf(); });
            anim.start();
        }

        @Override public void draw(Canvas c) {
            Rect b = getBounds();
            float cx = b.exactCenterX(), cy = b.exactCenterY();
            halo.setAlpha(Math.round(0.22f * 255 * held));
            if (held > 0) c.drawCircle(cx, cy, size / 2f * (0.6f + 0.4f * held), halo);
            c.drawCircle(cx, cy, radius * (1 + 0.25f * held), dot);
        }
        @Override public int getIntrinsicWidth() { return size; }
        @Override public int getIntrinsicHeight() { return size; }
        @Override public void setAlpha(int alpha) { dot.setAlpha(alpha); }
        @Override public void setColorFilter(ColorFilter f) { dot.setColorFilter(f); halo.setColorFilter(f); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }

    private void saveQuality() {
        CaptureService.prefs(this).edit()
                .putInt("size", sizes[chosen(sizeBar)]).putInt("fps", fpsStops[chosen(fpsBar)]).apply();
        CaptureService s = CaptureService.instance;
        if (s != null) s.retune();
    }

    private void renderQuality() {
        renderQuality(0);
    }

    /** dir: which way the value just moved (its text rolls in from that side), 0 for none. */
    private void renderQuality(int dir) {
        if (sizeBar == null || fpsBar == null) return;   // the first setProgress comes before both exist
        int size = sizes[chosen(sizeBar)], fps = fpsStops[chosen(fpsBar)];
        int[] screen = ScreenEncoder.displaySize(this);
        String sizeText = getString(size >= Math.max(screen[0], screen[1]) ? R.string.size_value_screen : R.string.size_value, size);
        String fpsText = getString(R.string.fps_value, fps);
        roll(sizeValue, sizeText, dir);
        roll(fpsValue, fpsText, dir);
        describe(sizeBar, R.string.size_label, sizeText);
        describe(fpsBar, R.string.fps_label, fpsText);
        String mbps = String.format(Locale.forLanguageTag("ru"), "%.1f", StreamServer.targetBitrate(size, fps) / 1e6);
        CaptureService s = CaptureService.instance;
        qualityHint.setText(getString(s != null && s.port > 0 ? R.string.quality_live : R.string.quality_hint, mbps));
    }

    /** A value that changed rolls in: from below when it grew, from above when it shrank. */
    private void roll(TextView v, String text, int dir) {
        if (text.contentEquals(v.getText())) return;
        v.setText(text);
        if (dir == 0) return;
        v.setTranslationY(Integer.signum(dir) * dp(8));
        v.setAlpha(0.2f);
        v.animate().translationY(0).alpha(1).setDuration(180).setInterpolator(EASE).start();
    }

    /** TalkBack reads "Плавность, 60 кадров/с", not a percentage. */
    private void describe(SeekBar bar, int label, String value) {
        if (Build.VERSION.SDK_INT >= 30) bar.setStateDescription(value);
        else bar.setContentDescription(getString(label) + ", " + value);
    }

    /** Wi-Fi and hotspot addresses (private IPv4), Wi-Fi first. */
    private static List<String> localIps() {
        List<String> wifi = new ArrayList<>(), other = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    String n = ni.getName();
                    (n.startsWith("wlan") || n.startsWith("ap") || n.startsWith("swlan") ? wifi : other).add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) {
        }
        wifi.addAll(other);
        return wifi;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
