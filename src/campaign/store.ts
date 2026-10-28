/**
 * Run saves. Each active run lives under its own versioned key, so one bad
 * save can't break the others; finished runs move to a short history.
 */

import { RUN_VERSION, type RunState, type RunStatus } from './run';

const PREFIX = `swarm.run.v${RUN_VERSION}.`;
/** every run version's saves start with this (the history key doesn't) */
const OLD_PREFIX = 'swarm.run.v';
const HISTORY = 'swarm.runHistory';

export interface PastRun {
  seedText: string;
  status: RunStatus;
  turns: number;
  biomass: number;
  ended: number;
}

export function saveRun(run: RunState): void {
  try {
    localStorage.setItem(PREFIX + run.id, JSON.stringify(run));
  } catch {
    /* storage full or unavailable */
  }
}

export function loadRun(id: string): RunState | null {
  try {
    const raw = localStorage.getItem(PREFIX + id);
    const run = raw ? (JSON.parse(raw) as RunState) : null;
    if (!run || run.v !== RUN_VERSION) return null;
    // Saves from before rewards (#64) have no perks or strains.
    run.perks ??= [];
    // Saves from before the following Bloom (#88): their front stays where it stopped, and the Bloom follows from here.
    run.bloom.time ??= 0;
    run.bloom.seeds ??= [];
    for (const b of run.broods) b.strains ??= [];
    return run;
  } catch {
    return null;
  }
}

/** Active runs, most recently played first. Unreadable saves are skipped; older versions' are deleted. */
export function listRuns(): RunState[] {
  const out: RunState[] = [];
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(OLD_PREFIX) && !key.startsWith(PREFIX)) stale.push(key);
      if (!key?.startsWith(PREFIX)) continue;
      const run = loadRun(key.slice(PREFIX.length));
      if (run && run.status === 'active') out.push(run);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export function deleteRun(id: string): void {
  try {
    localStorage.removeItem(PREFIX + id);
  } catch {
    /* ignore */
  }
}

export function loadHistory(): PastRun[] {
  try {
    const raw = localStorage.getItem(HISTORY);
    return raw ? (JSON.parse(raw) as PastRun[]) : [];
  } catch {
    return [];
  }
}

/** A run ended: drop its save and remember it (newest first, last 12). */
export function finishRun(run: RunState): void {
  deleteRun(run.id);
  const past: PastRun = { seedText: run.seedText, status: run.status, turns: run.turn, biomass: run.biomass, ended: run.updated };
  try {
    localStorage.setItem(HISTORY, JSON.stringify([past, ...loadHistory()].slice(0, 12)));
  } catch {
    /* ignore */
  }
}
