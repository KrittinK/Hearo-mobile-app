// Tier-based haptics for the in-app (foreground, web) experience.
//
// On the native Android APK, the strong / locked / DND-proof haptics are owned
// by HearoAlertPlugin (continuous critical ring) and the Wear OS companion app,
// so this module is a NO-OP on native to avoid double-buzzing. On the web it is
// the single source of phone vibration.
//
// Distinct patterns let a user identify the tier by feel alone (phone in pocket).

import { Capacitor } from '@capacitor/core';
import { TIERS } from './severity';

const IS_NATIVE = Capacitor.isNativePlatform();

// navigator.vibrate timings in ms: [wait, buzz, wait, buzz, ...]
export const PATTERNS = {
  [TIERS.CRITICAL]:  [0, 600, 200, 600], // loops until stop()
  [TIERS.IMPORTANT]: [0, 400, 150, 400], // single distinct burst
  [TIERS.AMBIENT]:   [0, 150],           // one short tick
};

let loopTimer = null;

function canVibrate() {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator;
}

// Start the haptic for a tier. CRITICAL repeats until stop() is called.
export function start(tier) {
  stop();
  if (IS_NATIVE) return;        // native plugin / watch own haptics on the APK
  if (!canVibrate()) return;
  const pattern = PATTERNS[tier] || PATTERNS[TIERS.IMPORTANT];
  navigator.vibrate(pattern);
  if (tier === TIERS.CRITICAL) {
    // navigator.vibrate has no native "repeat" flag, so re-issue on a timer.
    const periodMs = pattern.reduce((a, b) => a + b, 0) + 200;
    loopTimer = setInterval(() => navigator.vibrate(pattern), periodMs);
  }
}

export function stop() {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  if (!IS_NATIVE && canVibrate()) navigator.vibrate(0);
}
