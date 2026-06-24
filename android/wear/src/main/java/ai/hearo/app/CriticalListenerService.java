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

import org.json.JSONObject;

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

    static String emojiFor(String soundType) {
        if (soundType == null) return "🔔";
        switch (soundType) {
            case "fire_alarm":     return "🔥";
            case "smoke_detector": return "🔥";
            case "siren":          return "🚨";
            case "scream":         return "😱";
            case "glass_break":    return "💥";
            case "doorbell":       return "🔔";
            case "knock":          return "👊";
            case "baby_cry":       return "👶";
            case "phone_ring":     return "📞";
            case "alarm":          return "⏰";
            case "dog_bark":       return "🐕";
            case "car_horn":       return "🚗";
            default:               return "🔔";
        }
    }

    static String labelFor(String soundType) {
        if (soundType == null || soundType.isEmpty()) return "ALERT";
        return soundType.replace("_", " ").toUpperCase();
    }

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

    private void showFullScreenAlert(String payload) {
        // Payload is JSON: {"soundType":"fire_alarm","body":"Kitchen — 97%"}
        // Fall back gracefully if it's a plain string (old format).
        String soundType = "";
        String body = payload;
        try {
            JSONObject json = new JSONObject(payload);
            soundType = json.optString("soundType", "");
            body = json.optString("body", payload);
        } catch (Exception ignored) {}

        String emoji = emojiFor(soundType);
        String label = labelFor(soundType);
        String notifTitle = emoji + " " + label;

        Context ctx = this;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Critical Watch Alerts", NotificationManager.IMPORTANCE_HIGH);
            // No channel vibration — AlertActivity does the strong vibration, so
            // the notification must not add a competing gentle buzz.
            ch.enableVibration(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }

        Intent full = new Intent(ctx, AlertActivity.class);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        full.putExtra("soundType", soundType);
        full.putExtra("label", label);
        full.putExtra("emoji", emoji);
        full.putExtra("body", body);

        // Launch the strong-vibration activity directly. When the screen is ON,
        // a full-screen-intent notification only shows a (gentle) heads-up
        // instead of launching, so we start the activity ourselves. The
        // notification below is the fallback for when the screen is off/locked.
        try {
            ctx.startActivity(full);
            Log.d("HearoWear", "started AlertActivity directly");
        } catch (Exception e) {
            Log.w("HearoWear", "direct start blocked: " + e.getMessage());
        }

        PendingIntent fsPending = PendingIntent.getActivity(ctx, 0, full,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(notifTitle)
                .setContentText(body == null || body.isEmpty() ? "Critical sound detected" : body)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(fsPending, true);

        nm.notify(NOTIF_ID, b.build());
    }
}
