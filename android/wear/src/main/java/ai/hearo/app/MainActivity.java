package ai.hearo.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * Minimal launcher screen for the watch app. Opening it once takes the app out
 * of Android's "stopped" state so CriticalListenerService can receive messages
 * from the phone. The Test button fires the alert locally to check vibration.
 */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        findViewById(R.id.test_btn).setOnClickListener(v -> {
            Intent i = new Intent(this, AlertActivity.class);
            i.putExtra("body", "Test alert");
            startActivity(i);
        });
    }
}
