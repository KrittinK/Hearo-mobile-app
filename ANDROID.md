# Hearo — Native Android app (call-style critical alerts)

The web app (Vercel) works on any phone, but a browser **cannot** ring your
watch continuously like an incoming call. This native Android wrapper can:
when a **critical** sound (e.g. fire alarm) is detected, it posts a real
call-category notification that **rings the phone and Wear OS watch
non-stop until you tap Dismiss**.

Everything else — the React UI, on-device YAMNet detection — is identical.
Capacitor just runs the same web app inside a native shell that's allowed to
use Android's call-notification APIs.

## One-time setup

1. **Install Android Studio** (free): https://developer.android.com/studio
   It bundles the JDK and Android SDK you need.
2. Open it once and let it finish downloading the default SDK.

## Build & install on your phone

From the project root:

```bash
npm run android:open
```

This builds the web app, syncs it into the Android project, and opens it in
Android Studio. Then:

1. Plug in your Android phone (USB) with **Developer Options → USB debugging**
   enabled, or use an emulator.
2. In Android Studio, press the green **Run ▶** button (select your device).
3. The app installs and launches. Grant **microphone** and **notification**
   permissions when asked.

To build a shareable **APK** instead: Android Studio →
`Build → Build Bundle(s)/APK(s) → Build APK(s)`. The file lands in
`android/app/build/outputs/apk/debug/app-debug.apk` — copy it to any phone
and install (allow "install from unknown sources").

## After changing the web code

Re-sync the latest web build into the native project:

```bash
npm run android:sync
```

then Run again in Android Studio.

## How the call-style alert works

- `android/app/src/main/java/ai/hearo/app/HearoAlertPlugin.java` — posts a
  `CATEGORY_CALL` full-screen notification + a repeating phone vibration that
  loop until dismissed. Wear OS treats the call notification as an incoming
  call and rings continuously.
- `src/App.jsx` calls `HearoAlert.ring(...)` for critical alerts **only when
  running as the native app** (`Capacitor.isNativePlatform()`); on the web it
  falls back to the notification re-fire loop. So the same codebase serves
  both the Vercel site and the APK.

## Wear OS app (strong watch vibration for sleeping users)

The `wear/` module is a companion app that runs **on the Pixel Watch**. When the
phone detects a critical sound (fire alarm), it pushes a message to the watch
over the Wear Data Layer; the watch app then shows a full-screen "FIRE ALARM"
screen and vibrates at **alarm priority** — which bypasses Do Not Disturb /
Bedtime mode, so it can wake a sleeping deaf user. A regular bridged
notification can't do this (the phone can't control watch haptic strength, and
DND silences it at night).

### Install it on the watch (one-time)

1. On the phone, pair the watch for debugging: **Pixel Watch app → Settings →
   Developer options** (tap build number 7× on the watch to enable), turn on
   **ADB debugging** and **Debug over Wi-Fi/Bluetooth**.
2. In Android Studio, the watch appears as a device. Select the **`wear`**
   run configuration (module dropdown), choose the **watch** as the target,
   and press **Run ▶**. This installs the Hearo Alert app on the watch.
3. The phone `app` and the watch `wear` app share `applicationId ai.hearo.app`
   and the same debug signing key, so the Wear Data Layer pairs them
   automatically.

### Test it

With both apps installed and the watch paired to the phone, play a fire-alarm
sound. The watch should show the full-screen alert and buzz hard until you tap
**Dismiss** (on watch or phone). Tuning lives in
`wear/.../AlertActivity.java` (`timings` array = buzz/pause pattern).

## Notes

- For the full-screen "incoming call" takeover on Android 14+, the app needs
  the **USE_FULL_SCREEN_INTENT** permission (already in the manifest). Some
  devices also require enabling it under
  `Settings → Apps → Hearo → Full-screen notifications`.
- Detection still runs 100% on-device; no internet required after install.
