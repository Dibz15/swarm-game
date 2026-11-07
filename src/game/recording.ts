import type { Command } from '../sim/commands';
import { TICK_HZ } from '../sim/constants';
import { worldHash } from '../sim/hash';
import { supplyCap } from '../sim/nests';
import type { MatchSetup } from '../sim/setup';
import type { World } from '../sim/world';
import type { TimedCommand } from './session';

/**
 * One recorded match (#29): the setup and command log reproduce it on the
 * same build; the trace holds client-only signals and periodic per-faction
 * stats so recordings stay useful after the sim changes.
 */
export interface Recording {
  v: 1;
  id: string;
  /** git commit of the build that recorded it; replays need the same one */
  build: string;
  date: string;
  /** recording-session preset, if one was used */
  scenario?: string;
  setup: MatchSetup;
  human: number;
  log: TimedCommand[];
  end: { reason: EndReason; tick: number; hash: number };
  client: { mobile: boolean; touch: boolean; w: number; h: number };
  trace: Trace;
}

export type EndReason = 'victory' | 'defeat' | 'quit' | 'restart' | 'unload';

/** How a selection was made. */
export type SelectMethod = 'box' | 'click' | 'paint' | 'all' | 'type' | 'kind' | 'filter' | 'cycle' | 'group' | 'clear';
/** What the player touched last before an order: a key, the HUD, or the map. */
export type InputSource = 'key' | 'hud' | 'mouse' | 'touch';

export interface Trace {
  /** every CAM_EVERY ticks: [tick, cx, cy, half width, half height] of the view in world units */
  cam: number[][];
  /** [tick, method, units, nests] */
  sel: [number, SelectMethod, number, number][];
  /** [tick, command type, source, units in it, x, y] (x/y -1 when the order has no point) */
  orders: [number, Command['t'], InputSource, number, number, number][];
  /** one of the player's nests became contested: [tick, nest id, x, y] */
  alerts: [number, number, number, number][];
  /** [tick paused, real seconds paused] */
  pauses: [number, number][];
  /** every STATS_EVERY ticks: [tick, ...per faction (nests, units, cap, energy)] */
  stats: number[][];
}

export const CAM_EVERY = TICK_HZ / 2;
export const STATS_EVERY = TICK_HZ * 5;
/** fields per faction in a stats row */
export const STAT_FIELDS = 4;

declare const __BUILD__: string;
export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

export interface CameraView {
  cx: number;
  cy: number;
  viewW: number;
  viewH: number;
  zoom: number;
  /** quarter turns of the view (#98), none if absent */
  turn?: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Collects one match's trace as it is played. Never touches the sim. */
export class Recorder {
  readonly trace: Trace = { cam: [], sel: [], orders: [], alerts: [], pauses: [], stats: [] };
  readonly id = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  readonly date = new Date().toISOString();
  source: InputSource = 'mouse';
  private lastCam = -1e9;
  private lastStats = -1e9;
  private contested: boolean[] = [];
  private pausedAt = -1;
  private pauseStart = 0;
  private lastSel: { tick: number; method: SelectMethod } | null = null;

  constructor(
    private readonly setup: MatchSetup,
    private readonly human: number,
    private readonly client: Recording['client'],
    readonly scenario?: string,
  ) {}

  /** Call once per frame after the sim advanced. */
  frame(w: World, cam: CameraView | null): void {
    const t = w.tick;
    if (cam && t - this.lastCam >= CAM_EVERY) {
      this.lastCam = t;
      // Half-extents in world axes: swapped on a turned view (#98).
      const [hw, hh] = (cam.turn ?? 0) % 2 ? [cam.viewH, cam.viewW] : [cam.viewW, cam.viewH];
      this.trace.cam.push([t, r1(cam.cx), r1(cam.cy), r1(hw / cam.zoom / 2), r1(hh / cam.zoom / 2)]);
      for (const n of w.nests) {
        const c = n.owner === this.human && n.contested;
        if (c && !this.contested[n.id]) this.trace.alerts.push([t, n.id, r1(n.x), r1(n.y)]);
        this.contested[n.id] = c;
      }
    }
    if (t - this.lastStats >= STATS_EVERY) {
      this.lastStats = t;
      this.trace.stats.push(statsRow(w));
    }
  }

  order(w: World, c: Command): void {
    const n = 'units' in c ? c.units.length : 'nests' in c ? c.nests.length : 0;
    const x = 'x' in c ? r1(c.x) : -1;
    const y = 'y' in c ? r1(c.y) : -1;
    this.trace.orders.push([w.tick, c.t, this.source, n, x, y]);
  }

  /** Repeats of the same method within half a second (a drag or paint stroke) collapse into one. */
  select(w: World, method: SelectMethod, units: number, nests: number): void {
    const last = this.lastSel;
    if (last && last.method === method && w.tick - last.tick < TICK_HZ / 2) {
      const row = this.trace.sel[this.trace.sel.length - 1];
      row[2] = units;
      row[3] = nests;
      last.tick = w.tick;
      return;
    }
    this.lastSel = { tick: w.tick, method };
    this.trace.sel.push([w.tick, method, units, nests]);
  }

  pause(w: World, on: boolean, now: number): void {
    if (on && this.pausedAt < 0) {
      this.pausedAt = w.tick;
      this.pauseStart = now;
    } else if (!on && this.pausedAt >= 0) {
      this.trace.pauses.push([this.pausedAt, r1(now - this.pauseStart)]);
      this.pausedAt = -1;
    }
  }

  finish(w: World, log: TimedCommand[], reason: EndReason): Recording {
    return {
      v: 1,
      id: this.id,
      build: BUILD,
      date: this.date,
      scenario: this.scenario,
      setup: this.setup,
      human: this.human,
      log: log.slice(),
      end: { reason, tick: w.tick, hash: worldHash(w) },
      client: this.client,
      trace: this.trace,
    };
  }
}

/** [tick, ...per faction (nests held, units, supply cap, energy)] */
export function statsRow(w: World): number[] {
  const row = [w.tick];
  for (let f = 0; f < w.factions.length; f++) {
    let nests = 0;
    for (const n of w.nests) if (n.owner === f) nests++;
    row.push(nests, w.unitCount[f] ?? 0, supplyCap(w, f), Math.round(w.factions[f].energy));
  }
  return row;
}
