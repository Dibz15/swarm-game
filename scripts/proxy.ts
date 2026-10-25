// A scripted stand-in for the human player (#28/#29), built from recorded games:
// it expands immediately, moves one big blob (box-select everything), rallies
// every nest to where the blob is going, levels nests the blob walks past, and
// spends energy freely on Surge, Barrage and Nova. It issues Commands from
// outside the sim, the way a human client does.
import { hasPower, feedNeed, type Command } from '../src/sim/commands';
import { LEVEL, MAX_LEVEL, NEUTRAL, NestType, POWER, TICK_HZ, UNIT_STATS, UPGRADE_COST, UPGRADE_PICK_RADIUS, bastionTurret } from '../src/sim/constants';
import { queryRadius } from '../src/sim/spatial';
import { UNIT_FEEDING, type Nest, type World } from '../src/sim/world';

export interface ProxyKnobs {
  /** seconds between strategic decisions (~6 moves/min in recordings) */
  every: number;
  /** force over the defenders before attacking */
  margin: number;
  /** seconds between level-ups at most */
  upgradeEvery: number;
  /** seconds to notice a nest under attack (recordings: ~6 s) */
  react: number;
}

export const PROXY: ProxyKnobs = { every: 5, margin: 1.2, upgradeEvery: 30, react: 6 };

const scratch: number[] = [];

export class Proxy {
  private target = -1;
  private lastUpgrade = -1e9;
  private alertSince = new Map<number, number>();
  constructor(
    readonly f: number,
    readonly k: ProxyKnobs = PROXY,
  ) {}

  private defense(w: World, n: Nest): number {
    const team = w.teamOf[this.f];
    let h = 0;
    queryRadius(w, n.x, n.y, n.r + 70, scratch);
    for (const s of scratch) if (w.teamOf[w.owner[s]] !== team) h += UNIT_STATS[w.kind[s]].weight;
    if (n.owner >= 0 && n.owner !== NEUTRAL && w.teamOf[n.owner] !== team) {
      if (n.type === NestType.Bastion && n.control > 0.5) {
        const t = bastionTurret(n.owner, n.level);
        h += t.dps * t.targets * 0.5;
      } else if (n.level >= 2) h += LEVEL.turret.dps * LEVEL.turret.targets * 0.5;
      if (n.capital) h += 10;
    }
    return h;
  }

  think(w: World): Command[] {
    const out: Command[] = [];
    const me = this.f;
    if (w.factions[me].eliminated) return out;
    const army: number[] = [];
    let cx = 0, cy = 0;
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i] || w.owner[i] !== me || w.state[i] === UNIT_FEEDING) continue;
      army.push(i);
      cx += w.x[i];
      cy += w.y[i];
    }
    if (!army.length) return out;
    cx /= army.length;
    cy /= army.length;
    const uids = () => army.map((s) => w.uid[s]);

    if (w.tick % TICK_HZ === 0) this.powers(w, army, out);
    if (w.tick % Math.round(this.k.every * TICK_HZ) !== 0) return out;

    const mine = w.nests.filter((n) => n.owner === me);
    // Defend: a nest under attack for longer than our reaction time pulls the blob home.
    let defend: Nest | null = null;
    for (const n of mine) {
      if (!n.contested) {
        this.alertSince.delete(n.id);
        continue;
      }
      const since = this.alertSince.get(n.id) ?? w.tick;
      this.alertSince.set(n.id, since);
      if (w.tick - since >= this.k.react * TICK_HZ && (!defend || n.capital)) defend = n;
    }

    let goal: Nest | null = defend;
    if (!goal) {
      let best = -Infinity;
      for (const n of w.nests) {
        if (n.owner === me) continue;
        const def = this.defense(w, n);
        if (def * this.k.margin + 3 > army.length) continue;
        const dist = Math.sqrt((n.x - cx) ** 2 + (n.y - cy) ** 2);
        let score = (n.type === NestType.Hive ? 1 : 1.1) / (1 + dist / 350) / (def + 4);
        if (n.id === this.target) score *= 1.4;
        if (score > best) {
          best = score;
          goal = n;
        }
      }
    }
    if (goal) {
      this.target = goal.id;
      out.push({ t: 'move', p: me, units: uids(), x: goal.x, y: goal.y, nest: goal.id });
      if (mine.length) out.push({ t: 'rally', p: me, nests: mine.map((n) => n.id), x: goal.x, y: goal.y });
    }

    // Level a safe nest the blob is standing on.
    if (w.tick - this.lastUpgrade >= this.k.upgradeEvery * TICK_HZ) {
      for (const n of mine) {
        if (n.level >= MAX_LEVEL || n.contested || n.control < 1) continue;
        let near = 0;
        for (const s of army) if ((w.x[s] - n.x) ** 2 + (w.y[s] - n.y) ** 2 <= UPGRADE_PICK_RADIUS ** 2) near++;
        if (near >= Math.max(feedNeed(n), UPGRADE_COST[n.level]) * 1.5) {
          out.push({ t: 'upgrade', p: me, nest: n.id });
          this.lastUpgrade = w.tick;
          break;
        }
      }
    }
    return out;
  }

  /** Surge into any real fight, Barrage clumps, Nova big brawls. */
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
    if (center < 0 || most < 6) return;
    queryRadius(w, w.x[center], w.y[center], 90, scratch);
    const own = scratch.filter((s) => w.owner[s] === me && w.state[s] !== UNIT_FEEDING).map((s) => w.uid[s]);
    let ex = 0, ey = 0, ne = 0;
    for (const s of scratch) {
      if (!w.hostile(w.owner[s], me)) continue;
      ex += w.x[s];
      ey += w.y[s];
      ne++;
    }
    if (most >= 20 && own.length >= 15 && e >= POWER.novaCost) out.push({ t: 'nova', p: me, units: own });
    else if (ne >= 12 && e >= POWER.barrageCost && hasPower(w, me, 'barrage')) out.push({ t: 'barrage', p: me, x: ex / ne, y: ey / ne });
    else if (own.length >= 6 && e >= POWER.surgeCost) out.push({ t: 'surge', p: me, units: own });
  }
}
