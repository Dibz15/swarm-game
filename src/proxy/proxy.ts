/**
 * A scripted stand-in for the human player (#29, #37), for probes and the
 * campaign run sims. It plays the way the recordings show the owner playing:
 *
 * - Expand fast, moving one big blob (box-select everything).
 * - Hold at the front nest, inside turret cover, levelling it, with every
 *   nest rallied there.
 * - Punish: when an enemy wave reaches our territory, the whole blob answers
 *   it (after a human reaction time) with Surge, Fortify and Nova.
 * - Counter: once our army clearly outweighs the enemy's, push the weakest
 *   nearby enemy nest, and fall back to Hold if the push bleeds out.
 *
 * Recorded targets (scripts/death-split.ts on the recording builds): K/L about
 * 1.7-2; the human's losses split about 35% attacking, 36% defending, 19% at
 * neutral nests and 11% in the open, while bots lose about half theirs
 * attacking. The `skill` dial (0..1) scales it down toward a typical player.
 *
 * It only issues Commands from outside the sim, the way a client does, so it
 * plays any setup: 1v1, FFA, domination, and campaign battles.
 */

import { barrageLaunch, feedNeed, hasPower, surgeCost, type Command } from '../sim/commands';
import { LEVEL, MAX_LEVEL, NEUTRAL, NestType, POWER, TICK_HZ, UNIT_STATS, UPGRADE_COST, UPGRADE_PICK_RADIUS, bastionTurret } from '../sim/constants';
import { heartSlot, standingNests } from '../sim/heart';
import { queryRadius } from '../sim/spatial';
import { UNIT_FEEDING, type Nest, type World } from '../sim/world';

/** `goal` while assaulting the Bloom's heart (not a nest id) */
const HEART_GOAL = -2;
/** blob size at which the proxy goes for a stronghold's citadel... */
const CITADEL_BLOB = 60;
/** ...once it outnumbers the hostile units within CITADEL_R of it this many times over */
const CITADEL_EDGE = 1.5;
const CITADEL_R = 300;

export interface ProxyKnobs {
  /** seconds between strategic decisions */
  every: number;
  /** seconds a held order is re-issued after, even if the goal didn't change */
  refresh: number;
  /** force over the defenders before taking a nest */
  margin: number;
  /** seconds before reacting to a nest under attack (recordings: 6-9 s) */
  react: number;
  /** enemy weight near one of our nests that counts as a wave */
  wave: number;
  /** push enemy nests only while our army outweighs the target's owner by this much */
  counter: number;
  /** abandon a push when the blob is down to this share of its size at the start */
  bleed: number;
  /** seconds between level-ups at most */
  upgradeEvery: number;
  /** seconds between powers of one kind at most */
  powerEvery: number;
  /** share of the army (the stragglers furthest from the blob) left out of orders */
  straggle: number;
  /** share of the enemy army near an enemy nest counted as its defense */
  scout: number;
  /** the same, for pushes made without the upper hand overall (border retakes, domination emergencies) */
  scoutBehind: number;
  /** enemy nests this close to one of ours are fair game without outweighing their owner */
  border: number;
  /** a detachment answering a wave is this many times its weight (plus 4) */
  defend: number;
  /** energy at which any fight gets a Surge (recordings bank about 55 after 30 s) */
  dumpAt: number;
  /** a rival this many nests short of the domination share becomes the main target */
  domWatch: number;
  /** in an FFA, how strongly to leave weaker rivals alone (0: no preference) */
  buffer: number;
}

/** Tuned to the recordings (see the module comment). */
export const EXPERT: ProxyKnobs = {
  every: 2,
  refresh: 15,
  margin: 1.1,
  react: 6,
  wave: 6,
  counter: 1.35,
  bleed: 0.55,
  upgradeEvery: 40,
  powerEvery: 12,
  straggle: 0,
  scout: 0.25,
  scoutBehind: 0.25,
  border: 420,
  defend: 1.2,
  dumpAt: 80,
  domWatch: 3,
  buffer: 0,
};

/** Knobs for a player of `skill` (1: like the recordings, 0: a struggling beginner). */
export function knobsFor(skill: number): ProxyKnobs {
  const s = Math.max(0, Math.min(1, skill));
  const lack = 1 - s;
  return {
    ...EXPERT,
    every: EXPERT.every + 6 * lack,
    refresh: EXPERT.refresh + 15 * lack,
    react: EXPERT.react + 15 * lack,
    // Weaker players are slow and timid: they wait for bigger odds before taking a
    // nest, rarely counter, answer waves with too few dots, and forget stragglers.
    margin: EXPERT.margin + 0.9 * lack,
    counter: EXPERT.counter + 0.8 * lack,
    defend: EXPERT.defend - 0.5 * lack,
    upgradeEvery: EXPERT.upgradeEvery + 80 * lack,
    powerEvery: EXPERT.powerEvery + 60 * lack,
    dumpAt: EXPERT.dumpAt + 20 * lack,
    straggle: 0.5 * lack,
    scout: EXPERT.scout * s,
    scoutBehind: EXPERT.scoutBehind * s,
  };
}

export interface ProxyOptions {
  knobs?: Partial<ProxyKnobs>;
  /** skill 0..1 (default 1); explicit knobs override it */
  skill?: number;
  /** Nova is locked (campaign: a client-side lock the sim doesn't know about) */
  novaLocked?: boolean;
  /** blob size at which it goes for a stronghold's citadel (default CITADEL_BLOB; low = a rush) */
  citadelBlob?: number;
}

type Mode = 'expand' | 'hold' | 'punish' | 'counter';

const scratch: number[] = [];

export class Proxy {
  readonly k: ProxyKnobs;
  mode: Mode = 'expand';
  private goal = -1;
  private lastOrder = -1e9;
  /** where we last sent a detachment for each nest's wave */
  private answered = new Map<number, { x: number; y: number; tick: number }>();
  private lastUpgrade = -1e9;
  private lastPower: Record<string, number> = {};
  private alertSince = new Map<number, number>();
  /** army weight when the current push started */
  private pushFrom = 0;
  private readonly novaLocked: boolean;
  private readonly citadelBlob: number;

  /** Hostile units within r of (x, y). */
  private near(w: World, x: number, y: number, r: number): number {
    queryRadius(w, x, y, r, scratch);
    let n = 0;
    for (const s of scratch) if (w.hostile(w.owner[s], this.f)) n++;
    return n;
  }

  constructor(
    readonly f: number,
    opts: ProxyOptions = {},
  ) {
    this.k = { ...knobsFor(opts.skill ?? 1), ...opts.knobs };
    this.novaLocked = !!opts.novaLocked;
    this.citadelBlob = opts.citadelBlob ?? CITADEL_BLOB;
  }

  private hostile(w: World, o: number): boolean {
    return o !== NEUTRAL && o >= 0 && w.teamOf[o] !== w.teamOf[this.f];
  }

  /** Enemy weight standing on or around a nest (theirs), plus its turrets. */
  private defense(w: World, n: Nest, scout = this.k.scout): number {
    let h = 0;
    queryRadius(w, n.x, n.y, n.r + 70, scratch);
    for (const s of scratch) if (w.teamOf[w.owner[s]] !== w.teamOf[this.f]) h += UNIT_STATS[w.kind[s]].weight;
    if (this.hostile(w, n.owner)) {
      if (scout > 0) {
        const r2 = (n.r + 70) ** 2;
        queryRadius(w, n.x, n.y, 380, scratch);
        for (const s of scratch) {
          if (!this.hostile(w, w.owner[s])) continue;
          if ((w.x[s] - n.x) ** 2 + (w.y[s] - n.y) ** 2 > r2) h += UNIT_STATS[w.kind[s]].weight * scout;
        }
      }
      if (n.type === NestType.Bastion && n.control > 0.5) {
        const t = bastionTurret(n.owner, n.level);
        h += t.dps * t.targets * 0.5;
      } else if (n.level >= 2) h += LEVEL.turret.dps * LEVEL.turret.targets * 0.5;
      if (n.capital) h += 10;
    }
    return h;
  }

  /**
   * The wave at a nest we hold: hostile weight around it, and where it stands.
   * Units on their own nests nearby are a garrison, not a wave, so they don't count.
   */
  private threat(w: World, n: Nest): { h: number; x: number; y: number } {
    let h = 0, x = 0, y = 0;
    queryRadius(w, n.x, n.y, n.r + 140, scratch);
    for (const s of scratch) {
      const o = w.owner[s];
      if (!this.hostile(w, o)) continue;
      if (w.nests.some((m) => m.owner === o && (m.x - w.x[s]) ** 2 + (m.y - w.y[s]) ** 2 < (m.r + 40) ** 2)) continue;
      const wt = UNIT_STATS[w.kind[s]].weight;
      h += wt;
      x += w.x[s] * wt;
      y += w.y[s] * wt;
    }
    return h > 0 ? { h, x: x / h, y: y / h } : { h, x: n.x, y: n.y };
  }

  think(w: World): Command[] {
    const out: Command[] = [];
    const me = this.f;
    if (w.factions[me].eliminated) return out;

    // Our blob, and every faction's army weight.
    const army: number[] = [];
    const weight = new Float64Array(w.factions.length);
    let cx = 0, cy = 0;
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i] || w.state[i] === UNIT_FEEDING) continue;
      const o = w.owner[i];
      weight[o] += UNIT_STATS[w.kind[i]].weight;
      if (o !== me) continue;
      army.push(i);
      cx += w.x[i];
      cy += w.y[i];
    }
    if (!army.length) return out;
    cx /= army.length;
    cy /= army.length;

    if (w.tick % TICK_HZ === 0) this.powers(w, army, out);
    if (w.tick % Math.max(1, Math.round(this.k.every * TICK_HZ)) !== 0) return out;

    const mine = w.nests.filter((n) => n.owner === me);
    const enemyNests = w.nests.filter((n) => this.hostile(w, n.owner));
    const mySize = weight[me];

    // Punish: each wave that has been in our territory longer than our reaction
    // time gets a detachment sized to beat it (biggest first), sent at the wave.
    // A wave bigger than the army takes the whole army.
    const waves: { n: Nest; h: number; x: number; y: number }[] = [];
    for (const n of mine) {
      const t = this.threat(w, n);
      if (t.h < this.k.wave) {
        this.alertSince.delete(n.id);
        continue;
      }
      const since = this.alertSince.get(n.id) ?? w.tick;
      this.alertSince.set(n.id, since);
      if (w.tick - since >= this.k.react * TICK_HZ) waves.push({ n, ...t });
    }
    waves.sort((a, b) => b.h + (b.n.capital ? 5 : 0) - (a.h + (a.n.capital ? 5 : 0)) || a.n.id - b.n.id);
    const busy = new Set<number>();
    const answering = new Set<number>();
    for (const wave of waves) {
      const free = army.filter((s) => !busy.has(s));
      if (!free.length) break;
      const d2 = (s: number) => (w.x[s] - wave.x) ** 2 + (w.y[s] - wave.y) ** 2;
      free.sort((a, b) => d2(a) - d2(b) || a - b);
      const team = free.slice(0, Math.ceil(wave.h * this.k.defend + 4));
      for (const s of team) busy.add(s);
      answering.add(wave.n.id);
      const last = this.answered.get(wave.n.id);
      const moved = !last || (wave.x - last.x) ** 2 + (wave.y - last.y) ** 2 > 120 ** 2;
      if (moved || w.tick - last.tick >= this.k.refresh * TICK_HZ) {
        out.push({ t: 'move', p: me, units: team.map((s) => w.uid[s]), x: wave.x, y: wave.y, nest: -1 });
        this.answered.set(wave.n.id, { x: wave.x, y: wave.y, tick: w.tick });
      }
    }
    for (const id of [...this.answered.keys()]) if (!answering.has(id)) this.answered.delete(id);
    const blob = army.filter((s) => !busy.has(s));

    // The main blob: take what it can. Neutrals always; enemy nests when we clearly
    // outweigh their owner, when they sit on our border (taking back what we lost),
    // or when their owner is about to win by domination.
    let goal: Nest | null = null;
    let mode: Mode = waves.length ? 'punish' : 'hold';
    if (blob.length) {
      let bx = 0, by = 0;
      for (const s of blob) (bx += w.x[s]), (by += w.y[s]);
      bx /= blob.length;
      by /= blob.length;
      // The Bloom's heart (campaign finale): once its nests are taken, or the
      // blob is big enough to grind through the ward, go for it.
      const heart = heartSlot(w);
      if (heart >= 0 && blob.length >= 45 && (standingNests(w) === 0 || blob.length >= 90)) {
        const hx = w.x[heart], hy = w.y[heart];
        if (this.goal !== HEART_GOAL || w.tick - this.lastOrder >= this.k.refresh * TICK_HZ) {
          const units = this.straggle(w, blob, bx, by);
          out.push({ t: 'move', p: me, units: units.map((s) => w.uid[s]), x: hx, y: hy, nest: -1 });
          if (mine.length && this.goal !== HEART_GOAL) out.push({ t: 'rally', p: me, nests: mine.map((n) => n.id), x: hx, y: hy });
          this.goal = HEART_GOAL;
          this.lastOrder = w.tick;
        }
        this.mode = 'counter';
        this.upgrade(w, mine, army, out);
        return out;
      }
      // A stronghold (#100): taking the citadel wins, so once the blob is big
      // enough it marches through the gates for it, like a human would.
      // Only with the upper hand there, though: like a human, it expands until then.
      const cit = w.citadel >= 0 ? w.nests[w.citadel] : null;
      if (cit && cit.owner !== me && blob.length >= this.citadelBlob && blob.length >= CITADEL_EDGE * this.near(w, cit.x, cit.y, CITADEL_R)) {
        if (this.goal !== cit.id || w.tick - this.lastOrder >= this.k.refresh * TICK_HZ) {
          const units = this.straggle(w, blob, bx, by);
          out.push({ t: 'move', p: me, units: units.map((s) => w.uid[s]), x: cit.x, y: cit.y, nest: cit.id });
          if (mine.length && this.goal !== cit.id) out.push({ t: 'rally', p: me, nests: mine.map((n) => n.id), x: cit.x, y: cit.y });
          this.goal = cit.id;
          this.lastOrder = w.tick;
        }
        this.mode = 'counter';
        this.upgrade(w, mine, army, out);
        return out;
      }
      const pushing = this.mode === 'counter' && this.pushFrom > 0;
      const bled = pushing && mySize < this.pushFrom * this.k.bleed;
      if (bled) this.pushFrom = 0;
      const need = Math.ceil(w.nests.length * w.domShare);
      const held = new Map<number, number>();
      for (const n of w.nests) if (n.owner >= 0) held.set(w.teamOf[n.owner], (held.get(w.teamOf[n.owner]) ?? 0) + 1);
      // A rival nearing the domination share is everyone's problem: like the
      // recorded human, raid its nests to keep it under the line.
      const leaders = new Set<number>();
      let racing = false;
      for (const [team, k] of held) {
        if (team === w.teamOf[me] || k < need - this.k.domWatch) continue;
        leaders.add(team);
        if (k >= need) racing = true;
      }
      // In an FFA, weak rivals are buffers that soak up the strong one: lean on the strongest.
      let most = 0, rivals = 0;
      for (const [team, k] of held) {
        if (team === w.teamOf[me] || team === w.teamOf[NEUTRAL]) continue;
        rivals++;
        most = Math.max(most, k);
      }
      let best = -Infinity;
      for (const n of w.nests) {
        if (n.owner === me || (n.owner >= 0 && w.teamOf[n.owner] === w.teamOf[me])) continue;
        const enemy = this.hostile(w, n.owner);
        const leader = enemy && leaders.has(w.teamOf[n.owner]);
        // Without the upper hand overall, a push must beat the enemy army nearby too.
        let scout = this.k.scout;
        if (enemy) {
          if (bled && !leader) continue;
          const ahead = mySize >= weight[n.owner] * this.k.counter;
          if (!ahead) {
            const border = mine.some((m) => (m.x - n.x) ** 2 + (m.y - n.y) ** 2 < this.k.border ** 2);
            if (!leader && !border) continue;
            scout = this.k.scoutBehind;
          }
          // In an FFA, leave nests a third party is already fighting over (not the leader's).
          if (n.contested && !leader && !this.closeTo(w, n, blob)) continue;
        }
        const def = this.defense(w, n, scout);
        if (def * this.k.margin + 3 > blob.length) continue;
        const dist = Math.sqrt((n.x - bx) ** 2 + (n.y - by) ** 2);
        let score = (enemy ? 1.15 : 1) / (1 + dist / 350) / (def + 4);
        if (leader) score *= racing ? 8 : 3;
        else if (racing) score *= 0.3;
        if (enemy && rivals > 1) score *= ((held.get(w.teamOf[n.owner]) ?? 0) / Math.max(1, most)) ** this.k.buffer;
        if (n.id === this.goal) score *= 1.4;
        if (score > best) {
          best = score;
          goal = n;
        }
      }
      if (goal && this.hostile(w, goal.owner)) {
        mode = 'counter';
        if (this.mode !== 'counter' || this.pushFrom === 0) this.pushFrom = mySize;
      } else if (goal) {
        mode = 'expand';
      } else {
        // Hold at the front: our nest nearest the enemy, where turrets help.
        goal = this.front(w, mine, enemyNests);
        if (!waves.length) mode = 'hold';
        this.pushFrom = 0;
      }
      if (goal && (goal.id !== this.goal || w.tick - this.lastOrder >= this.k.refresh * TICK_HZ)) {
        // Like a player, select only the dots not already headed there (rallies send new ones).
        const g = goal;
        const units = this.straggle(w, blob, bx, by).filter((s) => g.id !== this.goal || (w.ox[s] - g.x) ** 2 + (w.oy[s] - g.y) ** 2 > 40 ** 2);
        if (units.length) out.push({ t: 'move', p: me, units: units.map((s) => w.uid[s]), x: g.x, y: g.y, nest: g.id });
        if (mine.length && goal.id !== this.goal) out.push({ t: 'rally', p: me, nests: mine.map((n) => n.id), x: goal.x, y: goal.y });
        this.goal = goal.id;
        this.lastOrder = w.tick;
      }
    }
    this.mode = mode;

    this.upgrade(w, mine, army, out);
    return out;
  }

  private closeTo(w: World, n: Nest, army: number[]): boolean {
    for (let k = 0; k < army.length; k += 3) if ((w.x[army[k]] - n.x) ** 2 + (w.y[army[k]] - n.y) ** 2 < (n.r + 120) ** 2) return true;
    return false;
  }

  /** The nest to hold: ours nearest an enemy nest, or the capital. */
  private front(w: World, mine: Nest[], enemy: Nest[]): Nest | null {
    if (!mine.length) return null;
    if (!enemy.length) return mine.find((n) => n.capital) ?? mine[0];
    let best = mine[0], bestD = Infinity;
    for (const n of mine) {
      for (const e of enemy) {
        const d = (n.x - e.x) ** 2 + (n.y - e.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
    }
    return best;
  }

  /** The units an order includes: all but the stragglers furthest from the blob. */
  private straggle(w: World, army: number[], cx: number, cy: number): number[] {
    if (this.k.straggle <= 0) return army;
    const d2 = (s: number) => (w.x[s] - cx) ** 2 + (w.y[s] - cy) ** 2;
    const sorted = [...army].sort((a, b) => d2(a) - d2(b) || a - b);
    return sorted.slice(0, Math.max(1, Math.ceil(sorted.length * (1 - this.k.straggle))));
  }

  /** Level a safe nest the blob is standing on. */
  private upgrade(w: World, mine: Nest[], army: number[], out: Command[]): void {
    if (w.tick - this.lastUpgrade < this.k.upgradeEvery * TICK_HZ) return;
    for (const n of mine) {
      if (n.level >= MAX_LEVEL || n.contested || n.control < 1) continue;
      let near = 0;
      for (const s of army) if ((w.x[s] - n.x) ** 2 + (w.y[s] - n.y) ** 2 <= UPGRADE_PICK_RADIUS ** 2) near++;
      if (near >= Math.max(feedNeed(n), UPGRADE_COST[n.level]) * 1.5) {
        out.push({ t: 'upgrade', p: this.f, nest: n.id });
        this.lastUpgrade = w.tick;
        return;
      }
    }
  }

  private ready(w: World, power: string): boolean {
    return w.tick - (this.lastPower[power] ?? -1e9) >= this.k.powerEvery * TICK_HZ;
  }

  /** Surge into real fights, Fortify a defense, Barrage clumps, Nova big brawls. */
  private powers(w: World, army: number[], out: Command[]): void {
    const me = this.f;
    const e = w.factions[me].energy;
    let center = -1, most = 0;
    for (let k = 0; k < army.length; k += 4) {
      const i = army[k];
      if (!w.engaged[i]) continue;
      queryRadius(w, w.x[i], w.y[i], 90, scratch);
      let h = 0;
      for (const s of scratch) if (w.hostile(w.owner[s], me)) h++;
      if (h > most) {
        most = h;
        center = i;
      }
    }
    // Near full energy, any fight is worth a power: income is wasted at the cap.
    const flush = e >= this.k.dumpAt;
    if (center < 0 || most < (flush ? 3 : 6)) return;
    queryRadius(w, w.x[center], w.y[center], 90, scratch);
    const own = scratch.filter((s) => w.owner[s] === me && w.state[s] !== UNIT_FEEDING).map((s) => w.uid[s]);
    let ex = 0, ey = 0, ne = 0;
    for (const s of scratch) {
      if (!w.hostile(w.owner[s], me)) continue;
      ex += w.x[s];
      ey += w.y[s];
      ne++;
    }
    const cast = (c: Command) => {
      out.push(c);
      this.lastPower[c.t] = w.tick;
    };
    if (!this.novaLocked && most >= 20 && own.length >= 15 && e >= POWER.novaCost && this.ready(w, 'nova')) cast({ t: 'nova', p: me, units: own });
    else if (ne >= 12 && e >= POWER.barrageCost && this.ready(w, 'barrage') && hasPower(w, me, 'barrage') && barrageLaunch(w, me, ex / ne, ey / ne)) cast({ t: 'barrage', p: me, x: ex / ne, y: ey / ne });
    else if (this.mode === 'punish' && own.length >= 10 && e >= POWER.fortifyCost && this.ready(w, 'fortify') && hasPower(w, me, 'fortify')) cast({ t: 'fortify', p: me, units: own });
    else if (own.length >= (flush ? 3 : 6) && e >= surgeCost(w, me) && (flush || this.ready(w, 'surge'))) cast({ t: 'surge', p: me, units: own });
  }
}
