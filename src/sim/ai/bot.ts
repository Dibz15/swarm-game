import { MAX_LEVEL, NEUTRAL, NestType, POWER, UNIT_STATS, UPGRADE_COST, UPGRADE_PICK_RADIUS } from '../constants';
import { applyCommand, type Command } from '../commands';
import { Rng } from '../rng';
import { queryRadius } from '../spatial';
import { UNIT_FEEDING, type Nest, type World } from '../world';

export type Personality = 'rusher' | 'turtler' | 'expander' | 'opportunist';
export const PERSONALITIES: readonly Personality[] = ['rusher', 'turtler', 'expander', 'opportunist'];
export const DIFFICULTY_NAMES = ['Easy', 'Normal', 'Hard', 'Brutal'] as const;

export interface BotConfig {
  difficulty: number; // 0..3
  personality: Personality;
}

interface DifficultyKnobs {
  /** ticks between decisions */
  think: number;
  /** extra force a bot wants over the defenders before attacking */
  margin: number;
  powers: boolean;
  upgradeSkill: number;
  /** randomness in target scoring */
  noise: number;
  /** production multiplier (only Brutal cheats) */
  prod: number;
  /** stream new spawns to the front instead of idling at home */
  frontRally: boolean;
}

export const DIFFICULTY: readonly DifficultyKnobs[] = [
  { think: 80, margin: 1.9, powers: false, upgradeSkill: 0.35, noise: 0.6, prod: 1, frontRally: false },
  { think: 45, margin: 1.45, powers: true, upgradeSkill: 0.7, noise: 0.3, prod: 1, frontRally: false },
  { think: 24, margin: 1.25, powers: true, upgradeSkill: 1, noise: 0.12, prod: 1, frontRally: true },
  { think: 14, margin: 1.15, powers: true, upgradeSkill: 1, noise: 0.06, prod: 1.25, frontRally: true },
];

interface PersonalityKnobs {
  neutral: number;
  enemy: number;
  margin: number;
  upgrade: number;
  /** fraction of the army kept home */
  reserve: number;
  /** bonus for hitting the weakest rival */
  weakest: number;
  bastion: number;
}

const PERSONALITY: Record<Personality, PersonalityKnobs> = {
  rusher: { neutral: 1.0, enemy: 1.7, margin: 0.85, upgrade: 0.45, reserve: 0.08, weakest: 1, bastion: 0.6 },
  turtler: { neutral: 1.0, enemy: 0.8, margin: 1.3, upgrade: 1.9, reserve: 0.35, weakest: 1, bastion: 1.8 },
  expander: { neutral: 1.9, enemy: 0.9, margin: 1.0, upgrade: 0.9, reserve: 0.18, weakest: 1, bastion: 0.9 },
  opportunist: { neutral: 1.0, enemy: 1.2, margin: 1.0, upgrade: 1.0, reserve: 0.2, weakest: 2.4, bastion: 1 },
};

const scratch: number[] = [];

/**
 * A bot player. Runs inside the sim step (deterministic, own seeded RNG)
 * and acts only by issuing the same Commands a human would.
 */
export class Bot {
  readonly faction: number;
  readonly cfg: BotConfig;
  private readonly rng: Rng;
  private readonly d: DifficultyKnobs;
  private readonly p: PersonalityKnobs;
  /** nest id currently being pushed */
  private focus = -1;

  constructor(faction: number, cfg: BotConfig, seed: number) {
    this.faction = faction;
    this.cfg = cfg;
    this.rng = new Rng((seed ^ Math.imul(faction + 1, 0x9e3779b1)) >>> 0);
    this.d = DIFFICULTY[cfg.difficulty] ?? DIFFICULTY[1];
    this.p = PERSONALITY[cfg.personality];
  }

  update(w: World): void {
    const fa = w.factions[this.faction];
    if (fa.eliminated) return;
    if ((w.tick + this.faction * 7) % this.d.think !== 0) return;
    this.think(w);
  }

  private issue(w: World, c: Command): void {
    applyCommand(w, c);
  }

  private think(w: World): void {
    const me = this.faction;
    const myTeam = w.teamOf[me];
    const fa = w.factions[me];

    // Idle units: arrived at their order point and not fighting.
    const idle: number[] = [];
    let total = 0;
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i] || w.owner[i] !== me) continue;
      total++;
      if (w.state[i] === UNIT_FEEDING || w.engaged[i]) continue;
      const dx = w.ox[i] - w.x[i], dy = w.oy[i] - w.y[i];
      if (dx * dx + dy * dy <= (w.arrive[i] * 1.8 + 6) ** 2) idle.push(i);
    }

    // Strength around each nest.
    const hostile: number[] = [];
    const friendly: number[] = [];
    for (const n of w.nests) {
      let h = 0, f = 0;
      queryRadius(w, n.x, n.y, n.r + 70, scratch);
      for (const s of scratch) {
        const wt = UNIT_STATS[w.kind[s]].weight;
        if (w.teamOf[w.owner[s]] === myTeam) f += wt;
        else h += wt;
      }
      if (n.type === NestType.Bastion && n.owner >= 0 && w.teamOf[n.owner] !== myTeam && n.control > 0.5) {
        h += 7 * (n.owner === NEUTRAL ? 1 : n.level);
      }
      hostile.push(h);
      friendly.push(f);
    }

    const mine = w.nests.filter((n) => n.owner === me);
    const used = new Set<number>();
    const take = (cx: number, cy: number, count: number, maxDist: number): number[] => {
      const pool = idle.filter((s) => !used.has(s));
      const d2 = (s: number) => (w.x[s] - cx) ** 2 + (w.y[s] - cy) ** 2;
      const near = pool.filter((s) => d2(s) <= maxDist * maxDist);
      near.sort((a, b) => d2(a) - d2(b) || a - b);
      const out = near.slice(0, Math.max(0, Math.ceil(count)));
      for (const s of out) used.add(s);
      return out;
    };
    const send = (slots: number[], nest: Nest) => {
      if (slots.length === 0) return;
      this.issue(w, { t: 'move', p: me, units: slots.map((s) => w.uid[s]), x: nest.x, y: nest.y, nest: nest.id });
    };

    // 1) Defend threatened nests.
    let threatened = false;
    for (const n of mine) {
      const h = hostile[n.id];
      if (h <= 0) continue;
      threatened = true;
      const need = h * 1.3 + 3 - friendly[n.id];
      if (need > 0) send(take(n.x, n.y, need * 1.3, 480), n);
    }

    // 2) Pick a target: value / (defense) / distance.
    let hx = 0, hy = 0;
    if (mine.length > 0) {
      for (const n of mine) {
        hx += n.x;
        hy += n.y;
      }
      hx /= mine.length;
      hy /= mine.length;
    } else if (idle.length > 0) {
      for (const s of idle) {
        hx += w.x[s];
        hy += w.y[s];
      }
      hx /= idle.length;
      hy /= idle.length;
    }

    let weakest = -1;
    for (let f = 0; f < NEUTRAL; f++) {
      const o = w.factions[f];
      if (!o.active || o.eliminated || w.teamOf[f] === myTeam) continue;
      if (weakest < 0 || w.unitCount[f] < w.unitCount[weakest]) weakest = f;
    }

    let best: Nest | null = null;
    let bestScore = -Infinity;
    let bestNeed = 0;
    for (const n of w.nests) {
      if (n.owner >= 0 && w.teamOf[n.owner] === myTeam) continue;
      const def = hostile[n.id];
      let value = n.type === NestType.Bastion ? 0.75 * this.p.bastion : n.type === NestType.Hive ? 1 : 1.1;
      value *= 0.6 + 0.4 * n.level;
      if (n.owner === NEUTRAL || n.owner < 0) value *= this.p.neutral;
      else {
        value *= this.p.enemy;
        if (n.owner === weakest) value *= this.p.weakest;
      }
      const dist = Math.sqrt((n.x - hx) ** 2 + (n.y - hy) ** 2);
      let score = value / (def + 4) / (1 + dist / 420);
      if (n.id === this.focus) score *= 1.25; // stick with a plan
      score *= 1 + (this.rng.next() - 0.5) * this.d.noise;
      if (score > bestScore) {
        bestScore = score;
        best = n;
        bestNeed = def * this.d.margin * this.p.margin + 4 + n.level * 2;
      }
    }

    const reserve = threatened ? 0 : Math.floor(total * this.p.reserve);
    const available = idle.length - used.size - reserve;
    if (best && available >= bestNeed) {
      this.focus = best.id;
      send(take(best.x, best.y, Math.min(available, bestNeed * 1.6 + 8), 1e9), best);
    }

    // Rally: easy bots idle new spawns at home; better bots stream them to
    // the friendly nest closest to the current target.
    if (this.d.frontRally && best && mine.length > 0) {
      let front = mine[0];
      let fd = Infinity;
      for (const n of mine) {
        const d = (n.x - best.x) ** 2 + (n.y - best.y) ** 2;
        if (d < fd) {
          fd = d;
          front = n;
        }
      }
      const toRally = mine.filter((n) => n !== front && hostile[n.id] === 0).map((n) => n.id);
      const rx = this.cfg.personality === 'rusher' ? best.x : front.x;
      const ry = this.cfg.personality === 'rusher' ? best.y : front.y;
      if (toRally.length) this.issue(w, { t: 'rally', p: me, nests: toRally, x: rx, y: ry });
    }

    // 3) Upgrade when there is slack.
    if (!threatened && mine.length > 0 && this.rng.next() < this.d.upgradeSkill * this.p.upgrade * 0.5) {
      const cand = mine.filter((n) => n.level < MAX_LEVEL && n.control >= 1 && n.feedIncoming === 0);
      if (cand.length > 0) {
        cand.sort((a, b) => {
          const pa = a.level - (a.type === NestType.Bastion ? this.p.bastion - 1 : 0);
          const pb = b.level - (b.type === NestType.Bastion ? this.p.bastion - 1 : 0);
          return pa - pb || a.id - b.id;
        });
        const n = cand[0];
        const cost = UPGRADE_COST[n.level] - n.feedProgress;
        let near = 0;
        for (const s of idle) {
          if (!used.has(s) && (w.x[s] - n.x) ** 2 + (w.y[s] - n.y) ** 2 <= UPGRADE_PICK_RADIUS ** 2) near++;
        }
        if (near >= cost * 1.4) this.issue(w, { t: 'upgrade', p: me, nest: n.id });
      }
    }

    // 4) Powers at the biggest fight.
    if (this.d.powers && fa.energy >= POWER.surgeCost) this.usePowers(w);
  }

  private usePowers(w: World): void {
    const me = this.faction;
    const fa = w.factions[me];
    // Sample engaged units as fight centers.
    let bestC = -1, bestH = 0;
    let seen = 0;
    for (let i = 0; i < w.n && seen < 24; i++) {
      if (!w.alive[i] || w.owner[i] !== me || !w.engaged[i]) continue;
      if (this.rng.next() > 0.3) continue;
      seen++;
      queryRadius(w, w.x[i], w.y[i], 90, scratch);
      let h = 0;
      for (const s of scratch) if (w.hostile(w.owner[s], me)) h++;
      if (h > bestH) {
        bestH = h;
        bestC = i;
      }
    }
    if (bestC < 0) return;
    queryRadius(w, w.x[bestC], w.y[bestC], 75, scratch);
    const own = scratch.filter((s) => w.owner[s] === me && w.state[s] !== UNIT_FEEDING);
    const uids = own.map((s) => w.uid[s]);
    if (fa.energy >= POWER.novaCost && bestH >= 16 && own.length >= 10) {
      this.issue(w, { t: 'nova', p: me, units: uids });
    } else if (bestH >= 10 && own.length >= 10 && fa.energy >= POWER.surgeCost + (this.cfg.difficulty >= 2 ? 25 : 0)) {
      this.issue(w, { t: 'surge', p: me, units: uids });
    }
  }
}
