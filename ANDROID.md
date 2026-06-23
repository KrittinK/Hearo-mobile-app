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

## Notes

- For the full-screen "incoming call" takeover on Android 14+, the app needs
  the **USE_FULL_SCREEN_INTENT** permission (already in the manifest). Some
  devices also require enabling it under
  `Settings → Apps → Hearo → Full-screen notifications`.
- Detection still runs 100% on-device; no internet required after install.
