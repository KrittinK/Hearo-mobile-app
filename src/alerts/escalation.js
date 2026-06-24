import { FAMILY_NETWORK_ENABLED } from '../config/flags';

// Escalation stub — will notify family network when FAMILY_NETWORK_ENABLED is true.
// Right now it's a no-op that logs; Phase 3 will wire in the real send.
export function triggerEscalation(alert) {
  if (!FAMILY_NETWORK_ENABLED) {
    console.warn('[escalation] stub — FAMILY_NETWORK_ENABLED=false, not sending', alert?.soundType);
    return;
  }
  // Phase 3: POST to family notification endpoint
}
