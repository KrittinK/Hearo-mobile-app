package ai.hearo.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HearoAlertPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
