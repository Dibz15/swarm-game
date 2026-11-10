/**
 * Mobile mode: one switch (`body.mobile`) for the touch-first layout and
 * wording. Auto-detected from the device, overridable in Settings.
 */

export type UiMode = 'auto' | 'mobile' | 'desktop';
export const UI_MODES: UiMode[] = ['auto', 'mobile', 'desktop'];

const MODE_KEY = 'swarm.uiMode';
const NOTICE_KEY = 'swarm.mobileNoticeSeen';

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

/** Touch-first device: the primary pointer is coarse and can't hover. No user-agent sniffing. */
export function detectMobile(): boolean {
  const mq = (q: string) => window.matchMedia?.(q).matches ?? false;
  return mq('(pointer: coarse)') && !mq('(hover: hover)');
}

export function uiMode(): UiMode {
  const m = load(MODE_KEY);
  return m === 'mobile' || m === 'desktop' ? m : 'auto';
}

export function isMobile(): boolean {
  const m = uiMode();
  return m === 'auto' ? detectMobile() : m === 'mobile';
}

export function setUiMode(m: UiMode): void {
  save(MODE_KEY, m);
  applyUiMode();
}

export function applyUiMode(): void {
  const was = document.body.classList.contains('mobile');
  document.body.classList.toggle('mobile', isMobile());
  if (was !== isMobile()) window.dispatchEvent(new Event(LAYOUT_EVENT));
}

/**
 * A short, wide view (#113): a phone held sideways, not a tablet or a desktop
 * window that merely is wider than tall. Gets the side-rail layout (`body.land`).
 */
export function isShortWide(w: number, h: number): boolean {
  return h > 0 && h <= 540 && w >= h * (4 / 3);
}

/** Fired on window when `body.land` turns on or off, so the HUD re-measures at once. */
export const LAYOUT_EVENT = 'swarm:layout';

export function applyLayout(): void {
  const land = isShortWide(window.innerWidth, window.innerHeight);
  if (document.body.classList.contains('land') === land) return;
  document.body.classList.toggle('land', land);
  window.dispatchEvent(new Event(LAYOUT_EVENT));
}

/** Apply now, and again if the pointer changes (tablet keyboard docks, devtools emulation). */
export function initUiMode(): void {
  applyUiMode();
  applyLayout();
  for (const q of ['(pointer: coarse)', '(hover: hover)']) window.matchMedia?.(q).addEventListener?.('change', applyUiMode);
  window.addEventListener('resize', applyLayout);
  window.addEventListener('orientationchange', applyLayout);
}

/** First time auto-detection turns mobile mode on, say so once. */
export function shouldShowMobileNotice(): boolean {
  return uiMode() === 'auto' && detectMobile() && load(NOTICE_KEY) !== '1';
}

export function markMobileNoticeSeen(): void {
  save(NOTICE_KEY, '1');
}

/**
 * On mobile data, where the browser says (#190: such a player runs the match
 * only when nobody better placed can). Most browsers don't say: false.
 */
export function onCellData(): boolean {
  const c = (navigator as Navigator & { connection?: { type?: string } }).connection;
  return c?.type === 'cellular';
}
