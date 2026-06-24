// On-screen strobe for CRITICAL alerts — wakes a sleeping user even without sound.
//
// WCAG 2.3.1 hard cap: ≤3 flashes/second (3Hz). We run at 2.5Hz (400ms period,
// 200ms on / 200ms off) to stay comfortably under the limit.
//
// Web only. On the native APK the notification light / Wear OS alert cover this.

const PERIOD_MS = 400; // 2.5Hz — well below the 3Hz WCAG 2.3.1 cap
const OPACITY = 0.35;  // bright enough to wake, dim enough not to blind

let el = null;
let timer = null;
let phase = false;

function attach() {
  if (el || typeof document === 'undefined') return;
  el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:199', 'pointer-events:none',
    'background:white', `opacity:${OPACITY}`, 'display:none',
  ].join(';');
  document.body.appendChild(el);
}

function detach() {
  if (el) { el.remove(); el = null; }
  phase = false;
}

export function startStrobe() {
  stopStrobe();
  attach();
  phase = true;
  if (el) el.style.display = 'block';
  timer = setInterval(() => {
    phase = !phase;
    if (el) el.style.display = phase ? 'block' : 'none';
  }, PERIOD_MS / 2);
}

export function stopStrobe() {
  if (timer) { clearInterval(timer); timer = null; }
  detach();
}
