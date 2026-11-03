/**
 * Resolution: how many backing pixels the battle and the run map draw per CSS
 * pixel. High-DPI screens on slow hardware can trade sharpness for frame rate
 * (#130). Chosen in Settings; applies live, since both read it every frame.
 */

export type Resolution = 'sharp' | 'balanced' | 'fast';
export const RESOLUTIONS: Resolution[] = ['sharp', 'balanced', 'fast'];

/** the most pixels per CSS pixel each setting draws (the screen's own ratio if lower) */
const CAP: Record<Resolution, number> = { sharp: 2, balanced: 1.5, fast: 1 };

const KEY = 'swarm.resolution';

function load(): Resolution {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'balanced' || v === 'fast' ? v : 'sharp';
  } catch {
    return 'sharp';
  }
}

let current: Resolution = load();

export function resolution(): Resolution {
  return current;
}

export function setResolution(r: Resolution): void {
  current = r;
  try {
    localStorage.setItem(KEY, r);
  } catch {
    /* storage unavailable: this session only */
  }
}

/** Backing pixels per CSS pixel for full-screen canvases. */
export function renderScale(): number {
  return Math.min(window.devicePixelRatio || 1, CAP[current]);
}
