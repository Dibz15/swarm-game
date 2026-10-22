import { Kind, MAX_LEVEL, NEUTRAL, NestType, bastionTurret, escalation, POWER, UNIT_STATS, UPGRADE_COST, UPGRADE_PICK_RADIUS } from '../constants';
import { applyCommand, hasPower, type Command } from '../commands';
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
  /** bonus for enemy nests someone else is already fighting over */
  vulture: number;
  /** surge in any real fight instead of saving energy for Nova */
  eagerSurge: boolean;
  /** distance penalty multiplier: higher keeps fights closer to home */
  reach: number;
  /** appetite for holding energy crystals */
  crystal: number;
}

const PERSONALITY: Record<Personality, PersonalityKnobs> = {
  rusher: { neutral: 1.3, enemy: 1.5, margin: 1.0, upgrade: 0.45, reserve: 0.15, weakest: 1, bastion: 0.6, vulture: 1, eagerSurge: true, reach: 1.3, crystal: 0.6 },
  turtler: { neutral: 1.0, enemy: 0.8, margin: 1.3, upgrade: 1.9, reserve: 0.35, weakest: 1, bastion: 1.8, vulture: 1, eagerSurge: false, reach: 1, crystal: 1.2 },
  expander: { neutral: 1.5, enemy: 0.9, margin: 1.0, upgrade: 0.9, reserve: 0.18, weakest: 1, bastion: 0.9, vulture: 1, eagerSurge: false, reach: 1, crystal: 1 },
  opportunist: { neutral: 1.0, enemy: 1.2, margin: 1.0, upgrade: 1.0, reserve: 0.2, weakest: 1.8, bastion: 1, vulture: 2.2, eagerSurge: false, reach: 1, crystal: 0.8 },
};

const scratch: number[] = [];

/**
 * Opening phase: all bots favor neutral nests and mostly leave players alone,
 * so aggressive personalities don't bleed out before they have an economy.
 */
const OPENING = { ticks: 90 * 30, neutral: 1.6, enemy: 0.35 };

/** Energy bots keep banked for a Nova once their army is this big. */
const NOVA_RESERVE = { minArmy: 30, energy: 25 };

/** Crystal squads: how many units hold one, and how far bots will walk for it. */
const CRYSTAL = { guard: 5, maxTrip: 650 };

/** When bots start ganging up on the leader. */
const RUNAWAY = {
  afterTicks: 100 * 30,
  minUnits: 70,
  /** leader's share of all units where the bonus starts */
  share: 0.4,
  /** leader size relative to this bot where the bonus starts */
  vsMe: 1.4,
};

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
        // Roughly the dots a turret kills during a ~5s capture.
        const t = bastionTurret(n.owner, n.level);
        h += t.dps * t.targets * 0.5;
      }
      if (n.capital && n.owner >= 0 && n.owner !== NEUTRAL && w.teamOf[n.owner] !== myTeam) h += 10;
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

    // Units holding a crystal for us stay put (unless needed for defense above).
    for (const c of w.crystals) {
      if (c.holder !== me) continue;
      let kept = 0;
      for (const s of idle) {
        if (kept >= CRYSTAL.guard || used.has(s)) continue;
        if ((w.x[s] - c.x) ** 2 + (w.y[s] - c.y) ** 2 <= c.r * c.r) {
          used.add(s);
          kept++;
        }
      }
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

    // Gang up on a runaway leader (human or bot) so FFAs don't just snowball.
    // Only after the opening, and scaled by how big the lead really is, so a
    // small early edge doesn't pull the whole map onto one player.
    let leader = -1, totalUnits = 0, rivals = 0;
    for (let f = 0; f < NEUTRAL; f++) {
      const o = w.factions[f];
      if (!o.active || o.eliminated) continue;
      totalUnits += w.unitCount[f];
      rivals++;
      if (w.teamOf[f] !== myTeam && (leader < 0 || w.unitCount[f] > w.unitCount[leader])) leader = f;
    }
    let leaderBonus = 1;
    if (leader >= 0 && rivals > 2 && w.tick > RUNAWAY.afterTicks && w.unitCount[leader] >= RUNAWAY.minUnits) {
      const share = w.unitCount[leader] / Math.max(1, totalUnits);
      const vsMe = w.unitCount[leader] / Math.max(1, w.unitCount[me]);
      const k = Math.min((share - RUNAWAY.share) / 0.25, (vsMe - RUNAWAY.vsMe) / 1.5, 1);
      // Late game: stop propping up the pack so someone can close it out.
      if (k > 0) leaderBonus = 1 + 0.9 * k * (1 - escalation(w.tick));
    }

    // Finish off stragglers: a rival down to one nest and a tiny army is a
    // cheap kill, and leaving it alive just stalls the match.
    const myUnits = w.unitCount[me];
    const nestCount = new Int32Array(NEUTRAL + 1);
    for (const n of w.nests) if (n.owner >= 0 && n.owner < NEUTRAL) nestCount[n.owner]++;
    // Escalation widens what counts as a straggler, so endgames consolidate.
    const L = escalation(w.tick);
    const straggler = (f: number) =>
      nestCount[f] <= 1 + 2 * L && myUnits >= 30 && w.unitCount[f] < myUnits * (0.3 + 0.3 * L);

    // Is a third party (not us, not the owner) standing on this nest?
    const hostileNotOwner = (n: Nest): boolean => {
      queryRadius(w, n.x, n.y, n.r, scratch);
      for (const s of scratch) {
        const o = w.owner[s];
        if (o !== n.owner && w.teamOf[o] !== myTeam && o !== NEUTRAL) return true;
      }
      return false;
    };

    // Opening: everyone builds an economy first; personalities show after.
    const opening = w.tick < OPENING.ticks;

    // Counter-picking: value the nest type that beats what rivals are fielding
    // (Spire vs Tanks, Forge vs Dots, Hive vs Lancers).
    const mix = [0, 0, 0, 0];
    let mixTotal = 0;
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i] || w.owner[i] === NEUTRAL || w.teamOf[w.owner[i]] === myTeam) continue;
      mix[w.kind[i]]++;
      mixTotal++;
    }
    const share = (k: number) => (mixTotal > 20 ? mix[k] / mixTotal : 0);
    const counterBonus = [
      1 + 1.2 * share(Kind.Lancer), // Hive (Dots) beats Lancers
      1 + 1.2 * share(Kind.Dot), // Forge (Tanks) beats Dots
      1 + 1.2 * share(Kind.Tank), // Spire (Lancers) beats Tanks
      1,
      1,
    ];

    let best: Nest | null = null;
    let bestScore = -Infinity;
    let bestNeed = 0;
    // Best target we can afford right now, so small bots still act.
    let fallback: Nest | null = null;
    let fallbackScore = -Infinity;
    let fallbackNeed = 0;
    const reserve = threatened ? 0 : Math.floor(total * this.p.reserve);
    const available = idle.length - used.size - reserve;
    for (const n of w.nests) {
      if (n.owner >= 0 && w.teamOf[n.owner] === myTeam) continue;
      const def = hostile[n.id];
      let value = n.type === NestType.Bastion ? 0.95 * this.p.bastion : n.type === NestType.Hive ? 1 : 1.1;
      value *= 0.6 + 0.4 * n.level;
      value *= counterBonus[n.type];
      let margin = this.d.margin * this.p.margin;
      if (n.owner === NEUTRAL || n.owner < 0) value *= opening ? Math.max(this.p.neutral, OPENING.neutral) : this.p.neutral;
      else {
        value *= opening ? OPENING.enemy : this.p.enemy;
        // Picking on the weakest only pays with several rivals; in a
        // three-way it just hands the game to the third player.
        if (n.owner === weakest && rivals > 3) value *= this.p.weakest;
        // Third-party: a nest under attack by someone else is softened up.
        if (n.contested && hostileNotOwner(n)) value *= this.p.vulture;
        if (n.owner === leader) value *= leaderBonus;
        if (straggler(n.owner)) {
          value *= 2.4;
          margin = Math.min(margin, 1.1);
        }
      }
      // Walking distance, so a nest behind a wall counts as far as it is.
      const dist = w.terrain.pathDist(hx, hy, n.x, n.y, w.tick);
      let score = value / (def + 4) / (1 + (dist / 420) * this.p.reach);
      if (n.id === this.focus) score *= 1.25; // stick with a plan
      score *= 1 + (this.rng.next() - 0.5) * this.d.noise;
      const need = def * margin + 4 + n.level * 2;
      if (score > bestScore) {
        bestScore = score;
        best = n;
        bestNeed = need;
      }
      if (need <= available && score > fallbackScore) {
        fallbackScore = score;
        fallback = n;
        fallbackNeed = need;
      }
    }

    // Prefer the best target; if we can't afford it, take the best
    // affordable one when it is at least half as good.
    if (best && available < bestNeed && fallback && fallbackScore >= bestScore * 0.5) {
      best = fallback;
      bestNeed = fallbackNeed;
    }
    if (best && available >= bestNeed) {
      this.focus = best.id;
      const group = take(best.x, best.y, Math.min(available, bestNeed * 1.6 + 8), 1e9);
      send(group, best);
      if (this.d.powers && group.length > 0) this.supportAttack(w, group, best);
    }

    // 2b) Crystals: send a small squad to a nearby crystal nobody on our team holds.
    if (w.crystals.length > 0 && mine.length > 0 && this.rng.next() < 0.6 * this.p.crystal) {
      let pick = -1, pickScore = 0, pickNeed = 0;
      for (let k = 0; k < w.crystals.length; k++) {
        const c = w.crystals[k];
        if (c.holder >= 0 && w.teamOf[c.holder] === myTeam) continue;
        const d = w.terrain.pathDist(hx, hy, c.x, c.y, w.tick);
        if (d > CRYSTAL.maxTrip) continue;
        queryRadius(w, c.x, c.y, c.r + 60, scratch);
        let h = 0, f = 0;
        for (const s of scratch) {
          const wt = UNIT_STATS[w.kind[s]].weight;
          if (w.teamOf[w.owner[s]] === myTeam) f += wt;
          else h += wt;
        }
        if (f >= CRYSTAL.guard) continue; // already on the way
        const score = 1 / (1 + d / 300) / (1 + h * 0.3);
        if (score > pickScore) {
          pickScore = score;
          pick = k;
          pickNeed = h * this.d.margin * 1.2 + CRYSTAL.guard;
        }
      }
      const spare = idle.length - used.size - reserve;
      if (pick >= 0 && spare >= pickNeed + 4) {
        const c = w.crystals[pick];
        const squad = take(c.x, c.y, pickNeed, 1e9);
        if (squad.length) this.issue(w, { t: 'move', p: me, units: squad.map((s) => w.uid[s]), x: c.x, y: c.y, nest: -1 });
      }
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

  /**
   * Can we spend `cost` energy and still keep the Nova reserve? Once a bot's
   * army is big enough for a Nova to matter, other powers leave some energy
   * banked so it can reach a Nova when a big brawl starts.
   */
  private spendable(w: World, cost: number): boolean {
    const reserve = w.unitCount[this.faction] >= NOVA_RESERVE.minArmy ? NOVA_RESERVE.energy : 0;
    return w.factions[this.faction].energy >= cost + reserve;
  }

  /** Powers that help an attack just launched: Lockdown the target, Blink to close distance. */
  private supportAttack(w: World, group: number[], target: Nest): void {
    const me = this.faction;
    const fa = w.factions[me];
    const enemyNest = target.owner >= 0 && target.owner !== NEUTRAL;
    if (enemyNest && this.spendable(w, POWER.lockdownCost + 10) && hasPower(w, me, 'lockdown')) {
      this.issue(w, { t: 'lockdown', p: me, nest: target.id });
      return;
    }
    if (this.spendable(w, POWER.blinkCost + 15) && group.length >= 8 && hasPower(w, me, 'blink')) {
      let cx = 0, cy = 0;
      for (const s of group) {
        cx += w.x[s];
        cy += w.y[s];
      }
      cx /= group.length;
      cy /= group.length;
      // Only worth it for long walks (walls make walks longer, and Blink jumps
      // them); land short of the nest, not on its turret.
      const d = Math.hypot(target.x - cx, target.y - cy);
      if (w.terrain.pathDist(cx, cy, target.x, target.y, w.tick) > POWER.blinkRange + 120 && d > 110) {
        const k = Math.min(POWER.blinkRange, d - 50) / d;
        this.issue(w, { t: 'blink', p: me, units: group.map((s) => w.uid[s]), x: cx + (target.x - cx) * k, y: cy + (target.y - cy) * k });
      }
    }
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
    // Where are the two sides in this fight?
    let ox = 0, oy = 0;
    for (const s of own) {
      ox += w.x[s];
      oy += w.y[s];
    }
    queryRadius(w, w.x[bestC], w.y[bestC], 90, scratch);
    let ex = 0, ey = 0, ne = 0;
    for (const s of scratch) {
      if (!w.hostile(w.owner[s], me)) continue;
      ex += w.x[s];
      ey += w.y[s];
      ne++;
    }
    const brawl = own.length >= 12 && bestH >= 16;

    // Nova is the answer to a big brawl right on top of us.
    if (brawl && fa.energy >= POWER.novaCost) {
      this.issue(w, { t: 'nova', p: me, units: uids });
      return;
    }
    // Barrage is artillery: for enemies massed apart from our own troops
    // (standing off or dug in), or, when energy allows, smaller fights.
    if (ne >= 12 && fa.energy >= POWER.barrageCost && hasPower(w, me, 'barrage')) {
      const apart = own.length === 0 || Math.hypot(ex / ne - ox / own.length, ey / ne - oy / own.length) > 45;
      // In small skirmishes keep a cushion so energy can still build to a Nova.
      if (apart ? this.spendable(w, POWER.barrageCost) : !brawl && this.spendable(w, POWER.barrageCost + 20)) {
        this.issue(w, { t: 'barrage', p: me, x: ex / ne, y: ey / ne });
        return;
      }
    }
    // In a brawl, save energy toward Nova rather than spending it piecemeal;
    // only dig in if badly outnumbered. Rushers can't help themselves.
    if (brawl && !this.p.eagerSurge) {
      if (bestH > own.length * 1.5 && this.spendable(w, POWER.fortifyCost) && hasPower(w, me, 'fortify')) {
        this.issue(w, { t: 'fortify', p: me, units: uids });
      }
      return;
    }
    if (this.spendable(w, POWER.fortifyCost) && bestH >= 10 && own.length >= 8 && hasPower(w, me, 'fortify') && (this.cfg.personality === 'turtler' || bestH > own.length)) {
      // Dig in when outnumbered (Turtlers always like to).
      this.issue(w, { t: 'fortify', p: me, units: uids });
    } else if (this.p.eagerSurge && bestH >= 6 && own.length >= 6) {
      // Rushers spend energy on Surge the moment a fight starts.
      this.issue(w, { t: 'surge', p: me, units: uids });
    } else if (bestH >= 10 && own.length >= 10 && this.spendable(w, POWER.surgeCost + (this.cfg.difficulty >= 2 ? 25 : 0))) {
      this.issue(w, { t: 'surge', p: me, units: uids });
    }
  }
}
