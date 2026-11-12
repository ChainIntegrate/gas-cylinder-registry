package it.chainintegrate.gascylinders;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceKeyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
