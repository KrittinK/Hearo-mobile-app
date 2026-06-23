package ai.hearo.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.WearableListenerService;

/**
 * Runs on the WATCH. Receives critical-alert messages pushed from the phone
 * over the Wear Data Layer and launches a full-screen alarm (AlertActivity)
 * that vibrates the watch strongly until dismissed.
 */
public class CriticalListenerService extends WearableListenerService {

    static final int NOTIF_ID = 9001;
    private static final String CHANNEL = "hearo_watch_critical";
    static final String PATH_CRITICAL = "/hearo/critical";
    static final String PATH_STOP = "/hearo/stop";

    @Override
    public void onMessageReceived(MessageEvent event) {
        final String path = event.getPath();
        Log.d("HearoWear", "onMessageReceived path=" + path);
        if (PATH_CRITICAL.equals(path)) {
            showFullScreenAlert(new String(event.getData()));
        } else if (PATH_STOP.equals(path)) {
            // Phone was dismissed → stop the watch alert too
            sendBroadcast(new Intent(AlertActivity.ACTION_STOP).setPackage(getPackageName()));
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIF_ID);
        }
    }

    private void showFullScreenAlert(String body) {
        Context ctx = this;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Critical Watch Alerts", NotificationManager.IMPORTANCE_HIGH);
            ch.enableVibration(true);
            nm.createNotificationChannel(ch);
        }

        Intent full = new Intent(ctx, AlertActivity.class);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        full.putExtra("body", body);
        PendingIntent fsPending = PendingIntent.getActivity(ctx, 0, full,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("🔥 FIRE ALARM")
                .setContentText(body == null || body.isEmpty() ? "Critical sound detected" : body)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(fsPending, true);

        nm.notify(NOTIF_ID, b.build());
    }
}
