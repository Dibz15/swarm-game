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
  document.body.classList.toggle('mobile', isMobile());
}

/** Apply now, and again if the pointer changes (tablet keyboard docks, devtools emulation). */
export function initUiMode(): void {
  applyUiMode();
  for (const q of ['(pointer: coarse)', '(hover: hover)']) window.matchMedia?.(q).addEventListener?.('change', applyUiMode);
}

/** First time auto-detection turns mobile mode on, say so once. */
export function shouldShowMobileNotice(): boolean {
  return uiMode() === 'auto' && detectMobile() && load(NOTICE_KEY) !== '1';
}

export function markMobileNoticeSeen(): void {
  save(NOTICE_KEY, '1');
}
