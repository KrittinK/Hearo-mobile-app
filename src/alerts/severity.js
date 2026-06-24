// Tiered alert severity for Hearo — the single source of truth for how loud a
// detection should be. Safety-critical: CRITICAL alerts are life-safety and
// must be unmissable; AMBIENT alerts must never be intrusive.
//
// To add a new detection class, add ONE line to TIER_MAP below.

export const TIERS = {
  CRITICAL: 'critical',   // life-safety: full-screen + continuous haptics + (phase 2) strobe
  IMPORTANT: 'important', // needs attention: full-screen, tap to dismiss
  AMBIENT: 'ambient',     // good to know: top banner + log, gentle tick
};

// detectionClass (Hearo sound category) → tier. One line per class.
const TIER_MAP = {
  // CRITICAL — life-safety
  fire_alarm: TIERS.CRITICAL,
  smoke_detector: TIERS.CRITICAL,
  siren: TIERS.CRITICAL,
  scream: TIERS.CRITICAL,
  glass_break: TIERS.CRITICAL,

  // IMPORTANT — needs attention
  doorbell: TIERS.IMPORTANT,
  knock: TIERS.IMPORTANT,
  baby_cry: TIERS.IMPORTANT,
  phone_ring: TIERS.IMPORTANT,
  alarm: TIERS.IMPORTANT,

  // AMBIENT — good to know
  dog_bark: TIERS.AMBIENT,
  car_horn: TIERS.AMBIENT,
};

// Unmapped classes default to IMPORTANT: safer to surface than to silently drop,
// but not loud enough to be a false life-safety alarm.
export function getSeverity(detectionClass) {
  return TIER_MAP[detectionClass] || TIERS.IMPORTANT;
}

// CRITICAL and IMPORTANT take over the screen; AMBIENT only shows a banner.
export function isFullScreenTier(tier) {
  return tier === TIERS.CRITICAL || tier === TIERS.IMPORTANT;
}
