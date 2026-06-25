import React, { useEffect, useRef, useState, useCallback } from 'react';
import { TIERS } from '../alerts/severity';
import { startStrobe, stopStrobe } from '../alerts/strobe';

// Tier identity is conveyed by icon + WORD + color (never color alone — WCAG 1.4.1).
const TIER_META = {
  [TIERS.CRITICAL]:  { bg: '#B00020', accent: '#B00020', label: 'CRITICAL' },  // saturated red
  [TIERS.IMPORTANT]: { bg: '#9A5B00', accent: '#9A5B00', label: 'IMPORTANT' }, // amber
};

const CATEGORY_EMOJI = {
  fire_alarm: '🔥', smoke_detector: '🔥', siren: '🚨', scream: '😱', glass_break: '🔨',
  doorbell: '🔔', knock: '✊', baby_cry: '👶', phone_ring: '📞', alarm: '⏰',
  dog_bark: '🐕', car_horn: '🚗',
};

const HOLD_MS = 1500;            // deliberate hold-to-dismiss for a panic moment
const IMPORTANT_AUTO_MS = 30000; // IMPORTANT self-clears; CRITICAL never does

export default function AlertOverlay({ alert, tier, onDismiss }) {
  const meta = TIER_META[tier] || TIER_META[TIERS.IMPORTANT];
  const isCritical = tier === TIERS.CRITICAL;
  const emoji = CATEGORY_EMOJI[alert.soundType] || '🔔';
  const word = alert.rawLabel || (alert.soundType || 'Alert').replace(/_/g, ' ');

  const [holdPct, setHoldPct] = useState(0);
  const holdStart = useRef(0);
  const holdRaf = useRef(0);
  const wakeRef = useRef(null);

  // Keep the screen awake while a CRITICAL alert is on screen.
  useEffect(() => {
    if (!isCritical) return undefined;
    (async () => {
      try {
        if ('wakeLock' in navigator) wakeRef.current = await navigator.wakeLock.request('screen');
      } catch (_) { /* wake lock unsupported / denied — non-fatal */ }
    })();
    return () => {
      try { if (wakeRef.current) wakeRef.current.release(); } catch (_) {}
      wakeRef.current = null;
    };
  }, [isCritical]);

  // On-screen strobe for CRITICAL (2.5Hz — hard WCAG 2.3.1 ≤3Hz cap). Web only.
  useEffect(() => {
    if (!isCritical) return undefined;
    startStrobe();
    return () => stopStrobe();
  }, [isCritical]);

  // IMPORTANT auto-dismisses (still logged in Recent Alerts); CRITICAL stays.
  useEffect(() => {
    if (isCritical) return undefined;
    const t = setTimeout(onDismiss, IMPORTANT_AUTO_MS);
    return () => clearTimeout(t);
  }, [isCritical, onDismiss]);

  const tick = useCallback(() => {
    const pct = Math.min(100, ((Date.now() - holdStart.current) / HOLD_MS) * 100);
    setHoldPct(pct);
    if (pct >= 100) { onDismiss(); return; }
    holdRaf.current = requestAnimationFrame(tick);
  }, [onDismiss]);

  const startHold = useCallback(() => {
    holdStart.current = Date.now();
    holdRaf.current = requestAnimationFrame(tick);
  }, [tick]);

  const cancelHold = useCallback(() => {
    cancelAnimationFrame(holdRaf.current);
    setHoldPct(0);
  }, []);

  return (
    <div role="alert" aria-live="assertive"
      aria-label={`${meta.label} alert: ${word}, ${alert.confidence}% confidence at ${alert.location}, ${alert.time}`}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center text-center px-6"
      style={{ backgroundColor: meta.bg }}
      onClick={isCritical ? undefined : onDismiss}>

      <div className="text-[74px] leading-none mb-3" aria-hidden="true">{emoji}</div>
      <div className="text-white text-sm font-bold tracking-[0.2em] mb-1">{meta.label}</div>
      <div className="text-white font-extrabold text-3xl leading-tight mb-3 break-words">{word}</div>
      <div className="text-white text-base font-medium">{alert.confidence}% · {alert.location}</div>
      <div className="text-white/80 text-sm mb-8">{alert.time}</div>

      {isCritical ? (
        <button
          onPointerDown={startHold} onPointerUp={cancelHold} onPointerLeave={cancelHold} onPointerCancel={cancelHold}
          className="relative min-w-[220px] min-h-[56px] px-8 rounded-2xl bg-white font-bold text-lg overflow-hidden select-none"
          style={{ color: meta.accent }}
          aria-label="Hold to dismiss critical alert">
          <span className="absolute inset-y-0 left-0 bg-black/10" style={{ width: `${holdPct}%` }} aria-hidden="true" />
          <span className="relative">{holdPct > 0 ? 'Keep holding…' : 'Hold to dismiss'}</span>
        </button>
      ) : (
        <button onClick={onDismiss}
          className="min-w-[220px] min-h-[56px] px-8 rounded-2xl bg-white font-bold text-lg"
          style={{ color: meta.accent }}
          aria-label="Tap to dismiss alert">
          Tap to dismiss
        </button>
      )}
    </div>
  );
}
