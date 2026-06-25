package ai.hearo.app;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import android.view.WindowManager;
import android.widget.TextView;

import com.google.android.gms.tasks.Tasks;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;

/**
 * Full-screen alarm shown on the WATCH. Vibrates at ALARM priority (which
 * bypasses Do Not Disturb / Bedtime mode) on a continuous loop until the user
 * taps Dismiss or the phone signals stop.
 */
public class AlertActivity extends Activity {

    static final String ACTION_STOP = "ai.hearo.app.WEAR_STOP";

    private Vibrator vibrator;
    private BroadcastReceiver stopReceiver;
    private boolean userDismissed = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Show over the lock screen and wake the display, even during sleep
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                  | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setContentView(R.layout.activity_alert);

        String emoji = getIntent().getStringExtra("emoji");
        String label = getIntent().getStringExtra("label");
        String body  = getIntent().getStringExtra("body");
        Log.d("HearoWear", "AlertActivity onCreate: emoji='" + emoji + "' label='" + label + "' body='" + body + "'");

        TextView titleTv = findViewById(R.id.alert_title);
        if (titleTv != null) {
            String e = (emoji != null && !emoji.isEmpty()) ? emoji : "🔔";
            String l = (label != null && !label.isEmpty()) ? label : "ALERT";
            titleTv.setText(e + " " + l);
        }

        TextView bodyTv = findViewById(R.id.alert_body);
        if (bodyTv != null && body != null && !body.isEmpty()) bodyTv.setText(body);

        findViewById(R.id.dismiss_btn).setOnClickListener(v -> {
            userDismissed = true;
            finish();
        });

        startVibration();

        stopReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) { finish(); }
        };
        IntentFilter filter = new IntentFilter(ACTION_STOP);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(stopReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(stopReceiver, filter);
        }
    }

    private void startVibration() {
        vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (vibrator == null) return;

        // USAGE_ALARM lets the vibration punch through Do Not Disturb / Bedtime
        AudioAttributes alarmAttrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .build();

        long[] timings = {0, 800, 350};   // buzz 800ms, pause 350ms, repeat
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            VibrationEffect effect;
            if (vibrator.hasAmplitudeControl()) {
                effect = VibrationEffect.createWaveform(timings, new int[]{0, 255, 0}, 0);
            } else {
                effect = VibrationEffect.createWaveform(timings, 0);
            }
            vibrator.vibrate(effect, alarmAttrs);
        } else {
            vibrator.vibrate(timings, 0);
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (vibrator != null) { vibrator.cancel(); vibrator = null; }
        if (stopReceiver != null) {
            try { unregisterReceiver(stopReceiver); } catch (Exception ignored) {}
            stopReceiver = null;
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(CriticalListenerService.NOTIF_ID);

        // If the user dismissed on the watch, tell the phone to stop too
        if (userDismissed) sendStopToPhone();
    }

    private void sendStopToPhone() {
        final Context appCtx = getApplicationContext();
        new Thread(() -> {
            try {
                for (Node node : Tasks.await(Wearable.getNodeClient(appCtx).getConnectedNodes())) {
                    Tasks.await(Wearable.getMessageClient(appCtx)
                            .sendMessage(node.getId(), CriticalListenerService.PATH_STOP, new byte[0]));
                }
            } catch (Exception ignored) {}
        }).start();
    }
}
