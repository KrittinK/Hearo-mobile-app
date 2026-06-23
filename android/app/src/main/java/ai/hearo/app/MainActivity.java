package ai.hearo.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HearoAlertPlugin.class);
        super.onCreate(savedInstanceState);
        requestRuntimePermissions();
    }

    // The WebView's getUserMedia is denied unless the app holds RECORD_AUDIO
    // at runtime. Request mic (+ notifications on Android 13+) on launch.
    private void requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        List<String> need = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!need.isEmpty()) {
            requestPermissions(need.toArray(new String[0]), 100);
        }
    }
}
