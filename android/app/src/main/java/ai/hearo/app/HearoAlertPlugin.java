package ai.hearo.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.android.gms.tasks.Tasks;
import com.google.android.gms.wearable.MessageClient;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;

/**
 * Critical alert: re-posts a high-priority notification every few seconds
 * (so it bridges to Wear OS and re-buzzes the watch on each post) and vibrates
 * the phone with a repeating waveform — continuous until the user dismisses it.
 *
 * Note: CATEGORY_CALL notifications do NOT mirror to Wear OS (the watch expects
 * calls via telephony), so we use a repeating normal notification instead.
 */
@CapacitorPlugin(name = "HearoAlert")
public class HearoAlertPlugin extends Plugin {

    private static final String CHANNEL_ID = "hearo_critical";
    private static final String CHANNEL_ALERTS = "hearo_alerts";
    private static final int NOTIF_ID = 7001;
    private static final String ACTION_DISMISS = "ai.hearo.app.DISMISS_ALERT";

    private static final long REPEAT_MS = 3000;
    private static final String PATH_CRITICAL = "/hearo/critical";
    private static final String PATH_STOP = "/hearo/stop";

    private Vibrator vibrator;
    private BroadcastReceiver dismissReceiver;
    private Handler repeatHandler;
    private Runnable repeatRunnable;
    private MessageClient.OnMessageReceivedListener wearStopListener;

    @Override
    public void load() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager)
                    getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Critical Alerts", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Fire alarm and other life-safety sounds");
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[]{0, 600, 300, 600});
            nm.createNotificationChannel(ch);

            NotificationChannel alerts = new NotificationChannel(
                    CHANNEL_ALERTS, "Sound Alerts", NotificationManager.IMPORTANCE_HIGH);
            alerts.setDescription("Detected sounds (non-critical)");
            alerts.enableVibration(true);
            alerts.setVibrationPattern(new long[]{0, 300, 150, 300});
            nm.createNotificationChannel(alerts);
        }
    }

    // Regular heads-up notification for non-critical sounds (buzzes the phone
    // and mirrors to the watch with a single alert).
    @PluginMethod
    public void showAlert(PluginCall call) {
        String title = call.getString("title", "Hearo Alert");
        String body = call.getString("body", "");
        Context ctx = getContext();

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPending = PendingIntent.getActivity(ctx, 2, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ALERTS)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setDefaults(NotificationCompat.DEFAULT_VIBRATE)
                .setContentIntent(openPending);

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
        call.resolve();
    }

    @PluginMethod
    public void ring(PluginCall call) {
        final String title = call.getString("title", "Hearo Alert");
        final String body = call.getString("body", "Critical sound detected");
        final Context ctx = getContext();

        registerDismiss();

        // Push the critical alert to the watch (strong vibration runs there) and
        // listen for the watch's Dismiss so we can stop the phone alert too.
        sendToWatch(PATH_CRITICAL, body);
        registerWearStopListener();

        // Continuous phone vibration until dismissed (repeat from index 0 = forever)
        vibrator = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
        long[] timings = {0, 600, 400};
        if (vibrator != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(timings, 0));
            } else {
                vibrator.vibrate(timings, 0);
            }
        }

        // CATEGORY_CALL notifications are NOT mirrored to Wear OS (the watch
        // expects calls via telephony). So instead, RE-POST a normal high-
        // priority notification every few seconds: it bridges to the watch and
        // re-buzzes it on each post — continuous until the user dismisses.
        repeatHandler = new Handler(Looper.getMainLooper());
        repeatRunnable = new Runnable() {
            @Override public void run() {
                postCriticalNotification(ctx, title, body);
                repeatHandler.postDelayed(this, REPEAT_MS);
            }
        };
        repeatHandler.post(repeatRunnable); // fire immediately, then every REPEAT_MS

        call.resolve();
    }

    private void postCriticalNotification(Context ctx, String title, String body) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPending = PendingIntent.getActivity(ctx, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent dismissIntent = new Intent(ACTION_DISMISS).setPackage(ctx.getPackageName());
        PendingIntent dismissPending = PendingIntent.getBroadcast(ctx, 1, dismissIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(false)   // re-alert (re-buzz watch) on every re-post
                .setLocalOnly(false)       // allow bridging to the watch
                .setContentIntent(openPending)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dismiss", dismissPending);

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTIF_ID, b.build());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        clearAll();
        call.resolve();
    }

    // Opens the system phone dialer with the number pre-filled.
    // ACTION_DIAL requires no permission — the user still has to tap Call.
    @PluginMethod
    public void dialNumber(PluginCall call) {
        String number = call.getString("number", "");
        if (number.isEmpty()) { call.reject("number required"); return; }
        try {
            Intent intent = new Intent(Intent.ACTION_DIAL,
                    android.net.Uri.parse("tel:" + number));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open dialer: " + e.getMessage());
        }
    }

    private void registerDismiss() {
        if (dismissReceiver != null) return;
        dismissReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) { clearAll(); }
        };
        IntentFilter filter = new IntentFilter(ACTION_DISMISS);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(dismissReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(dismissReceiver, filter);
        }
    }

    private void clearAll() {
        if (repeatHandler != null && repeatRunnable != null) {
            repeatHandler.removeCallbacks(repeatRunnable);
            repeatHandler = null;
            repeatRunnable = null;
        }
        if (vibrator != null) { vibrator.cancel(); vibrator = null; }
        NotificationManager nm = (NotificationManager)
                getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancel(NOTIF_ID);
        if (dismissReceiver != null) {
            try { getContext().unregisterReceiver(dismissReceiver); } catch (Exception ignored) {}
            dismissReceiver = null;
        }
        // Tell the watch to stop, and remove the watch->phone stop listener
        sendToWatch(PATH_STOP, "");
        if (wearStopListener != null) {
            Wearable.getMessageClient(getContext()).removeListener(wearStopListener);
            wearStopListener = null;
        }
    }

    private void registerWearStopListener() {
        if (wearStopListener != null) return;
        wearStopListener = event -> {
            if (PATH_STOP.equals(event.getPath())) clearAll();
        };
        Wearable.getMessageClient(getContext()).addListener(wearStopListener);
    }

    // Send a message to every connected watch node (off the main thread).
    private void sendToWatch(final String path, final String payload) {
        final Context ctx = getContext().getApplicationContext();
        new Thread(() -> {
            try {
                byte[] data = payload == null ? new byte[0] : payload.getBytes();
                java.util.List<Node> nodes = Tasks.await(Wearable.getNodeClient(ctx).getConnectedNodes());
                Log.d("HearoAlert", "sendToWatch path=" + path + " nodes=" + nodes.size());
                for (Node node : nodes) {
                    Tasks.await(Wearable.getMessageClient(ctx).sendMessage(node.getId(), path, data));
                    Log.d("HearoAlert", "sent '" + path + "' to " + node.getDisplayName());
                }
            } catch (Exception e) {
                Log.w("HearoAlert", "sendToWatch failed: " + e.getMessage());
            }
        }).start();
    }
}
