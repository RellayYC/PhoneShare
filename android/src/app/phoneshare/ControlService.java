package app.phoneshare;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Path;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.List;

/**
 * Performs what a viewer does on the PC's picture: taps, swipes, long presses, scrolling, the system buttons and
 * typing. An accessibility service is the only way an ordinary app may do that (no ADB, no root): the person turns it
 * on once in the phone's accessibility settings, and «Управление с ПК» in PhoneShare decides whether viewers may use it.
 * Messages come from StreamServer.onControl through CaptureService, on the main thread.
 */
public final class ControlService extends AccessibilityService {
    static volatile ControlService instance;

    private static final int MAX_POINTS = 400, MAX_MS = 10_000, TAP_MS = 50, LONG_PRESS_MS = 500, HOLD_MS = 400;

    @Override protected void onServiceConnected() {
        instance = this;
        changed();
    }

    @Override public boolean onUnbind(Intent intent) {
        instance = null;
        changed();
        return super.onUnbind(intent);
    }

    @Override public void onDestroy() {
        instance = null;
        changed();
        super.onDestroy();
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) { }

    @Override public void onInterrupt() { }

    private static void changed() {
        CaptureService s = CaptureService.instance;
        if (s != null) s.applyControl();
        Runnable r = CaptureService.onStateChanged;
        if (r != null) r.run();
    }

    /** Whether the person turned this service on in the accessibility settings (it may not be bound yet). */
    static boolean enabled(Context c) {
        String list = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        String me = new ComponentName(c, ControlService.class).flattenToString();
        if (list != null) for (String s : list.split(":")) if (s.equalsIgnoreCase(me)) return true;
        return false;
    }

    /** One message from a viewer: {"t":"touch","a":...,"p":...}, {"t":"gesture","p":...}, {"t":"nav","a":...} or {"t":"text",...}. */
    void perform(String msg) {
        String t = StreamServer.field(msg, "t");
        try {
            if ("touch".equals(t)) touch(StreamServer.field(msg, "a"), StreamServer.field(msg, "p"));
            else if ("gesture".equals(t)) gesture(StreamServer.field(msg, "p"));
            else if ("nav".equals(t)) nav(StreamServer.field(msg, "a"));
            else if ("text".equals(t)) text(StreamServer.field(msg, "s"), StreamServer.field(msg, "k"));
        } catch (IllegalArgumentException | IllegalStateException e) {
            finger = null;   // a message Android cannot perform is dropped: it never takes the phone app down
        }
    }

    // ---- touch: points are fractions of the picture, which is the whole screen as it is turned now

    /** "x,y,ms;x,y,ms;..." from the press to the release. */
    static List<float[]> points(String p) {
        return points(p, MAX_MS);
    }

    /** The same with times up to maxMs: a live press may be held for longer than a whole gesture may last. */
    static List<float[]> points(String p, float maxMs) {
        List<float[]> out = new ArrayList<>();
        if (p == null) return out;
        float last = 0;
        for (String part : p.split(";")) {
            if (out.size() >= MAX_POINTS) break;
            String[] v = part.split(",");
            if (v.length != 3) continue;
            try {
                float x = clamp(Float.parseFloat(v[0])), y = clamp(Float.parseFloat(v[1])), raw = Float.parseFloat(v[2]);
                if (Float.isNaN(raw)) continue;
                float ms = Math.max(last, Math.min(maxMs, raw));
                out.add(new float[] {x, y, ms});
                last = ms;
            } catch (NumberFormatException ignored) {
            }
        }
        return out;
    }

    private static float clamp(float v) {
        return Float.isNaN(v) ? 0 : Math.max(0, Math.min(1, v));
    }

    private void gesture(String p) {
        List<float[]> pts = points(p);
        if (pts.isEmpty()) return;
        int[] d = ScreenEncoder.displaySize(this);
        float w = d[0] - 1, h = d[1] - 1, slop = 0.012f * Math.max(d[0], d[1]);   // ~1 % of the screen: still a tap
        float[] first = pts.get(0);
        float x0 = first[0] * w, y0 = first[1] * h;
        int moved = -1;   // the first point that left the slop around the press
        for (int i = 1; i < pts.size(); i++) {
            if (Math.hypot(pts.get(i)[0] * w - x0, pts.get(i)[1] * h - y0) > slop) {
                moved = i;
                break;
            }
        }
        float end = pts.get(pts.size() - 1)[2];
        Path press = new Path();
        press.moveTo(x0, y0);
        if (moved < 0) {   // a tap, or a long press when held
            long held = end < LONG_PRESS_MS ? TAP_MS : (long) end;
            dispatch(new GestureDescription.StrokeDescription(press, 0, held), null);
            return;
        }
        Path drag = new Path();
        drag.moveTo(x0, y0);
        for (int i = moved; i < pts.size(); i++) drag.lineTo(pts.get(i)[0] * w, pts.get(i)[1] * h);
        float hold = pts.get(moved - 1)[2];
        long dragMs = Math.max(16, (long) (end - hold));
        if (hold < HOLD_MS) {   // a swipe at the speed it was drawn: a quick flick flings, a slow drag scrolls
            dispatch(new GestureDescription.StrokeDescription(drag, 0, Math.max(16, (long) end)), null);
            return;
        }
        // held, then moved (an icon to another place): the finger stays down between the two parts
        GestureDescription.StrokeDescription down = new GestureDescription.StrokeDescription(press, 0, (long) hold, true);
        dispatch(down, () -> dispatch(down.continueStroke(drag, 0, dragMs, false), null));
    }

    // ---- live touch: the finger goes down when the mouse button does and follows the mouse until it is released

    private static final long PIECE_MAX_MS = 50;   // a pause before a move is not replayed: the finger already waited
    private GestureDescription.StrokeDescription finger;   // the press that is down, continued piece by piece
    private float fx, fy, fms;

    /**
     * {"t":"touch","a":"down|move|up","p":"x,y,ms;..."}. Each point is one straight piece that continues the press. Points
     * are whole pixels: a piece must start exactly where the last one ended, or Android lifts the finger in between.
     */
    private void touch(String a, String p) {
        List<float[]> pts = points(p, 3_600_000);
        int[] d = ScreenEncoder.displaySize(this);
        if ("down".equals(a)) {
            if (pts.isEmpty()) return;
            fx = Math.round(pts.get(0)[0] * (d[0] - 1));
            fy = Math.round(pts.get(0)[1] * (d[1] - 1));
            fms = pts.get(0)[2];
            Path at = new Path();
            at.moveTo(fx, fy);
            finger = new GestureDescription.StrokeDescription(at, 0, 1, true);   // a new press: anything still held is lifted
            dispatch(finger, null);
            return;
        }
        if (finger == null) return;
        boolean up = "up".equals(a);
        for (int i = 0; i < pts.size(); i++) {
            float[] q = pts.get(i);
            float x = Math.round(q[0] * (d[0] - 1)), y = Math.round(q[1] * (d[1] - 1));
            boolean last = up && i == pts.size() - 1;
            if (x == fx && y == fy && !last) continue;   // nothing to move: the finger just stays down
            Path piece = new Path();
            piece.moveTo(fx, fy);
            if (x != fx || y != fy) piece.lineTo(x, y);
            long ms = Math.max(1, Math.min(PIECE_MAX_MS, (long) (q[2] - fms)));
            finger = finger.continueStroke(piece, 0, ms, !last);
            dispatch(finger, null);
            fx = x;
            fy = y;
            fms = q[2];
        }
        if (up && pts.isEmpty()) {   // released where it was
            Path at = new Path();
            at.moveTo(fx, fy);
            dispatch(finger.continueStroke(at, 0, 1, false), null);
        }
        if (up) finger = null;
    }

    /** Control was switched off or the stream stopped mid-press: the finger comes up where it is. */
    void lift() {
        if (finger != null) touch("up", "");
    }

    private void dispatch(GestureDescription.StrokeDescription s, Runnable then) {
        dispatchGesture(new GestureDescription.Builder().addStroke(s).build(), then == null ? null : new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription g) {
                then.run();
            }
        }, null);
    }

    // ---- the system buttons

    private void nav(String a) {
        if ("back".equals(a)) performGlobalAction(GLOBAL_ACTION_BACK);
        else if ("home".equals(a)) performGlobalAction(GLOBAL_ACTION_HOME);
        else if ("recents".equals(a)) performGlobalAction(GLOBAL_ACTION_RECENTS);
        else if ("notifications".equals(a)) performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS);
    }

    // ---- typing into the field that has the focus on the phone

    private AccessibilityNodeInfo secretField;   // the password field typed into last, and what was typed there
    private String secret = "";

    private void text(String s, String key) {
        AccessibilityNodeInfo f = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (f == null || !f.refresh() || !f.isEditable()) return;   // refresh: the cached copy misses the last key
        if ("enter".equals(key) && Build.VERSION.SDK_INT >= 30
                && f.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER)) {
            f.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());   // send, search, next...
            return;
        }
        if ("enter".equals(key)) s = f.isMultiLine() ? "\n" : null;   // a one-line field without an Enter action: nothing to do
        else if (s != null) s = f.isMultiLine() ? s.replace("\r\n", "\n") : s.replaceAll("\r?\n|\r", " ");
        CharSequence shown = f.isShowingHintText() ? "" : f.getText();
        String now = shown == null ? "" : shown.toString();
        boolean password = f.isPassword();
        if (password) {
            // the field shows a dot per character, not its text: go on from what was typed here, or start over
            if (!f.equals(secretField) || secret.length() != now.length()) secret = "";
            now = secret;
        }
        int a = f.getTextSelectionStart(), b = f.getTextSelectionEnd();
        if (a < 0 || b < 0 || a > now.length() || b > now.length()) a = b = now.length();   // no cursor known: the end
        int lo = Math.min(a, b), hi = Math.max(a, b);
        if ("backspace".equals(key)) {
            if (lo == hi && lo > 0) lo = now.offsetByCodePoints(lo, -1);   // a whole emoji, not half of it
            s = "";
        }
        if (s == null) return;
        String next = now.substring(0, lo) + s + now.substring(hi);
        Bundle set = new Bundle();
        set.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next);
        if (!f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, set)) return;
        if (password) {
            secretField = f;
            secret = next;
        }
        Bundle sel = new Bundle();
        sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, lo + s.length());
        sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, lo + s.length());
        f.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
    }
}
