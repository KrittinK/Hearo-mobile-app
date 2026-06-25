import React, { useEffect } from 'react';

const CATEGORY_EMOJI = {
  dog_bark: '🐕', car_horn: '🚗', knock: '✊', doorbell: '🔔',
};

// Non-intrusive top banner for AMBIENT alerts. The alert is already logged to
// Recent Alerts by the caller; this is just a glanceable, auto-clearing notice.
export default function AmbientBanner({ alert, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [alert, onDismiss]);

  return (
    <div role="status" aria-live="polite"
      className="fixed top-0 inset-x-0 z-[90] mx-auto max-w-md px-4 pt-3">
      <div className="flex items-center gap-3 rounded-xl bg-[#00A8E1] text-white shadow-lg px-4 py-3">
        <span className="text-xl" aria-hidden="true">{CATEGORY_EMOJI[alert.soundType] || '🔔'}</span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate">{alert.rawLabel || (alert.soundType || '').replace(/_/g, ' ')}</p>
          <p className="text-xs text-white/90">{alert.confidence}% · {alert.location} · {alert.time}</p>
        </div>
        <button onClick={onDismiss} aria-label="Dismiss banner"
          className="text-white text-2xl leading-none px-2 min-h-[44px]">×</button>
      </div>
    </div>
  );
}
