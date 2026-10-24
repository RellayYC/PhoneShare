package app.phoneshare;

import android.content.Context;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.Surface;
import android.view.WindowManager;

import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Screen -> VirtualDisplay -> H.264 encoder -> StreamServer.
 * Encoder settings follow scrcpy: repeat the last frame when the screen is static, no B-frames,
 * keyframes on request, and a smaller size when the encoder refuses the full one.
 */
final class ScreenEncoder {
    private static final String MIME = MediaFormat.MIMETYPE_VIDEO_AVC;
    private static final int[] FALLBACK_SIZES = {2560, 1920, 1600, 1280, 960};

    private final Context ctx;
    private final MediaProjection projection;
    private final StreamServer server;
    private final Handler handler;
    private final int maxSize, targetBitrate, fps;

    private VirtualDisplay display;
    private volatile MediaCodec codec;
    private int width, height, bitrate, quietSeconds;
    private boolean contentSized;   // Android 14+ reports the captured size itself (single-app capture too)
    private volatile boolean running;

    ScreenEncoder(Context ctx, MediaProjection projection, StreamServer server, Handler handler, int maxSize, int bitrate, int fps) {
        this.ctx = ctx;
        this.projection = projection;
        this.server = server;
        this.handler = handler;
        this.maxSize = maxSize;
        this.targetBitrate = bitrate;
        this.fps = fps;
    }

    void start() throws IOException {
        running = true;
        bitrate = targetBitrate;
        configure(displaySize());
        ctx.getSystemService(DisplayManager.class).registerDisplayListener(displayListener, handler);
        handler.postDelayed(adjustBitrate, 1000);
    }

    void stop() {
        running = false;
        handler.removeCallbacks(adjustBitrate);
        ctx.getSystemService(DisplayManager.class).unregisterDisplayListener(displayListener);
        releaseCodec();
        if (display != null) display.release();
        display = null;
    }

    void requestKeyframe() {
        MediaCodec c = codec;
        if (c == null) return;
        Bundle b = new Bundle();
        b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
        try {
            c.setParameters(b);
        } catch (IllegalStateException ignored) {
        }
    }

    /** MediaProjection.Callback#onCapturedContentResize (Android 14+). Called on the handler thread. */
    void onContentResize(int w, int h) {
        contentSized = true;
        resizeTo(new int[] {w, h});
    }

    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int id) { }
        @Override public void onDisplayRemoved(int id) { }
        @Override public void onDisplayChanged(int id) {
            if (id == Display.DEFAULT_DISPLAY && !contentSized) resizeTo(displaySize());
        }
    };

    private void resizeTo(int[] size) {
        if (!running) return;
        int[] s = scale(size[0], size[1], maxSize);
        if (s[0] == width && s[1] == height) return;
        try {
            configure(size);
        } catch (IOException e) {
            StreamServer.log("resize failed: " + e);
        }
    }

    private final Runnable adjustBitrate = new Runnable() {
        @Override public void run() {
            if (!running) return;
            int drops = server.takeDrops();
            quietSeconds = drops > 0 ? 0 : quietSeconds + 1;
            int next = StreamServer.nextBitrate(bitrate, targetBitrate, drops > 0, quietSeconds);
            if (next != bitrate) {
                bitrate = next;
                MediaCodec c = codec;
                if (c != null) {
                    Bundle b = new Bundle();
                    b.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, next);
                    try {
                        c.setParameters(b);
                    } catch (IllegalStateException ignored) {
                    }
                }
                StreamServer.log("bitrate " + next / 1000 + " kbps");
            }
            handler.postDelayed(this, 1000);
        }
    };

    private int[] displaySize() {
        if (Build.VERSION.SDK_INT >= 30) {
            Rect b = ctx.getSystemService(WindowManager.class).getMaximumWindowMetrics().getBounds();
            return new int[] {b.width(), b.height()};
        }
        DisplayMetrics m = new DisplayMetrics();
        ctx.getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(m);
        return new int[] {m.widthPixels, m.heightPixels};
    }

    /** Fits the long side into limit and rounds both sides to a multiple of 8, like scrcpy. */
    static int[] scale(int w, int h, int limit) {
        int longSide = Math.max(w, h);
        if (longSide > limit) {
            w = (int) ((long) w * limit / longSide);
            h = (int) ((long) h * limit / longSide);
        }
        return new int[] {Math.max(8, w & ~7), Math.max(8, h & ~7)};
    }

    private synchronized void configure(int[] size) throws IOException {
        releaseCodec();
        IOException last = null;
        for (int limit : FALLBACK_SIZES) {
            if (limit > maxSize && limit != FALLBACK_SIZES[FALLBACK_SIZES.length - 1]) continue;
            int[] s = scale(size[0], size[1], Math.min(limit, maxSize));
            MediaCodec c = null;
            try {
                c = MediaCodec.createEncoderByType(MIME);
                c.configure(format(s[0], s[1]), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                Surface surface = c.createInputSurface();
                c.start();
                int dpi = ctx.getResources().getDisplayMetrics().densityDpi;
                if (display == null) {
                    display = projection.createVirtualDisplay("PhoneShare", s[0], s[1], dpi,
                            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, handler);
                } else {
                    display.resize(s[0], s[1], dpi);
                    display.setSurface(surface);
                }
                width = s[0];
                height = s[1];
                codec = c;
                server.setVideoSize(width, height);
                final MediaCodec running = c;
                Thread t = new Thread(() -> drain(running), "ps-encoder");
                t.start();
                StreamServer.log("encoder " + width + "x" + height + " @" + fps + " " + bitrate / 1000 + " kbps (" + c.getName() + ")");
                return;
            } catch (IOException | RuntimeException e) {
                last = e instanceof IOException ? (IOException) e : new IOException(e);
                StreamServer.log("encoder refused " + s[0] + "x" + s[1] + ": " + e);
                if (c != null) c.release();
            }
        }
        throw last;
    }

    private MediaFormat format(int w, int h) {
        MediaFormat f = MediaFormat.createVideoFormat(MIME, w, h);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
        f.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
        f.setFloat("max-fps-to-encoder", fps);
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10);           // keyframes come on demand
        f.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000); // a static screen still sends a frame every 100 ms
        f.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
        f.setInteger(MediaFormat.KEY_PRIORITY, 0);                     // realtime
        return f;
    }

    private void drain(MediaCodec c) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        byte[] buf = new byte[256 * 1024];
        try {
            while (running && codec == c) {
                int i = c.dequeueOutputBuffer(info, 100_000);
                if (i < 0) continue;
                ByteBuffer out = c.getOutputBuffer(i);
                if (out != null && info.size > 0) {
                    if (buf.length < info.size) buf = new byte[info.size * 2];
                    out.position(info.offset);
                    out.get(buf, 0, info.size);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                        server.sendVideoConfig(buf, 0, info.size, info.presentationTimeUs);
                    } else {
                        server.sendVideoFrame(buf, 0, info.size, (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0, info.presentationTimeUs);
                    }
                }
                c.releaseOutputBuffer(i, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
            }
        } catch (IllegalStateException ignored) {
            // codec released by a resize or stop
        }
    }

    private void releaseCodec() {
        MediaCodec c = codec;
        codec = null;
        if (display != null) display.setSurface(null);
        if (c == null) return;
        try {
            c.stop();
        } catch (IllegalStateException ignored) {
        }
        c.release();
    }
}
