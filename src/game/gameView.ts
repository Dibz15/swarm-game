import type { TraitId } from '../campaign/warlords';
import { WAVE_KINDS } from '../sim/siege';
import { FACTION_NAMES, FACTION_RGB, WHITE, mixRgb, type RGB } from '../content/factions';
import { Selection } from '../input/selection';
import type { Camera } from '../render/camera';
import type { Particles, Rings } from '../render/particles';
import type { Renderer } from '../render/renderer';
import { DROP_RGB as DROP_MARK, FERAL, drawWorld } from '../render/scene';
import type { AudioEngine } from '../audio/engine';
import { DAMAGE_VS, dominationStatus, MAX_LEVEL, MAX_UNITS, TICK_HZ, NEST_NAMES, NEUTRAL, POWER, POWER_NEST, UNIT_FEEDING, supplyCap, type MatchSetup, type NestPower } from '../sim/index';
import { barrageLaunch, feedNeed, hasPower, novaRadius, powerBoost, surgeCost } from '../sim/commands';
import type { Nest, World } from '../sim/world';
import { Recorder, type SelectMethod } from './recording';
import { nearestNestOrders } from './nearest';
import { LocalSession } from './session';
import type { Lock, MissionRun } from './tutorial';

export interface Services {
  renderer: Renderer;
  camera: Camera;
  particles: Particles;
  rings: Rings;
  sfx: AudioEngine;
  toast(msg: string, color?: string): void;
}

export type MatchResult = 'victory' | 'defeat';

/** Seconds the game holds when a tutorial instruction changes (missions with readPause). */
const READ_PAUSE = 10;
/** Barrage aim outside every nest's range */
const OUT_OF_RANGE: RGB = [150, 155, 175];

/** A match in progress: owns the session, selection and event feedback. */
export class GameView {
  readonly session: LocalSession;
  readonly human: number;
  readonly selection = new Selection();
  hoverNest = -1;
  /** a targeted power waiting for a click (touch / HUD buttons) */
  aim: NestPower | null = null;
  /** world position under the cursor, for previews and key casts */
  cursor: [number, number] | null = null;
  /** world units per ~1 css px, for HUD pick radii */
  get zoomForPick(): number {
    return this.s.camera.zoom / this.s.renderer.dpr;
  }
  /** paint-select brush shown at the cursor while Space is held */
  brush: { x: number; y: number; r: number } | null = null;
  result: MatchResult | null = null;
  resultTime = 0;
  /** match recorder (#29), when the player opted in */
  readonly rec: Recorder | null;
  /** tutorial mission being played, if any (#17) */
  mission: MissionRun | null = null;
  /** actions this mission hides */
  locked = new Set<Lock>();
  /** why a locked action is locked, when it isn't the tutorial's "not in this lesson" */
  private lockReason = new Map<Lock, string>();
  private highlightAt = 0;
  /** reading pause: the step it is for, and when it ends (seconds); see READ_PAUSE */
  private readStep = -1;
  readUntil = 0;
  readFrom = 0;
  /** 0..1 of the reading pause left, for the coach's bar */
  readLeft = 0;
  private mask = new Uint8Array(MAX_UNITS);
  private spawnSeen: number[] = [];
  private domSecs = -1;
  private siegeSecs = -1;
  private frame = 0;
  /** supply state last frame, to announce hitting the cap once */
  private supplyBlocked = false;
  private supplyNests = 0;
  private supplyToastTick = -1e9;
  private bloomToasted = false;
  /** a campaign warlord in this battle (#66, #100): its units' look, its citadel's marker */
  warlord: { faction: number; trait: TraitId } | null = null;
  /** the citadel's walls were breached (sounded once) */
  private breached = false;

  constructor(
    readonly setup: MatchSetup,
    private readonly s: Services,
    record: { scenario?: string; mobile: boolean } | null = null,
  ) {
    this.session = new LocalSession(setup);
    this.human = setup.players.find((p) => p.human)?.faction ?? -1;
    this.rec = record
      ? new Recorder(setup, this.human, { mobile: record.mobile, touch: matchMedia('(pointer: coarse)').matches, w: innerWidth, h: innerHeight }, record.scenario)
      : null;
    if (this.rec) {
      const rec = this.rec;
      this.session.onIssue = (c) => rec.order(this.world, c);
    }
    s.camera.setMap(this.world.width, this.world.height);
    s.camera.fit();
    s.particles.clear();
    s.rings.list = [];
  }

  get world(): World {
    return this.session.world;
  }

  update(dt: number, time: number): void {
    this.session.update(dt);
    this.drainEvents();
    this.selection.prune(this.world, this.human);
    const w = this.world;
    this.rec?.frame(w, this.s.camera);
    if (!this.result) {
      const me = w.factions[this.human];
      if (me?.eliminated) this.finish('defeat', time);
      else if (w.over) this.finish(w.winnerTeam === w.teamOf[this.human] ? 'victory' : 'defeat', time);
    }
    if (!this.result) this.checkSupply();
    if (!this.result && this.mission) this.updateMission(time);
    this.s.sfx.update(dt, w, this.human, this.result ? 'ended' : this.session.paused ? 'paused' : 'play');
    // Domination countdown ticks in the last ten seconds.
    const ds = this.result ? null : dominationStatus(w);
    const secs = ds ? Math.ceil(ds.left / TICK_HZ) : -1;
    if (secs !== this.domSecs) {
      if (ds && secs <= 10 && secs > 0) this.s.sfx.domTick(1 - secs / 10, ds.team === w.teamOf[this.human]);
      this.domSecs = secs;
    }
    // Holding the line (#67): the clock ticks through its last ten seconds.
    const sg = this.result ? null : w.siege;
    const left = sg ? Math.ceil((sg.until - w.tick) / TICK_HZ) : -1;
    if (left !== this.siegeSecs) {
      if (sg && left <= 10 && left > 0) this.s.sfx.domTick(1 - left / 10, true);
      this.siegeSecs = left;
    }
    // Soft ticks for your own nests spawning, if they are on screen.
    for (const n of w.nests) {
      if (n.owner === this.human && n.lastSpawn !== this.spawnSeen[n.id]) {
        this.spawnSeen[n.id] = n.lastSpawn;
        if (n.lastSpawn === w.tick) this.s.sfx.spawn(n.x, n.y);
      }
    }
  }

  /** Advance the tutorial steps, pulse the nests the current step is about, end on success. */
  private updateMission(time: number): void {
    const m = this.mission!;
    const ctx = { w: this.world, human: this.human, log: this.session.log };
    for (const c of m.take(ctx)) this.session.issue(c);
    if (m.update(ctx)) {
      const c = this.s.camera;
      this.s.sfx.levelUp(c.cx, c.cy, true);
    }
    if (m.complete) {
      this.session.held = false;
      return this.finish('victory', time);
    }
    // Hold the game briefly on each new instruction, so it can be read before things move.
    if (m.mission.readPause && this.readStep !== m.step) {
      this.readStep = m.step;
      this.readFrom = time;
      this.readUntil = time + READ_PAUSE;
    }
    this.session.held = time < this.readUntil;
    this.readLeft = this.session.held ? (this.readUntil - time) / READ_PAUSE : 0;
    if (time - this.highlightAt < 1.1) return;
    this.highlightAt = time;
    for (const id of m.current?.highlight?.(ctx) ?? []) {
      const n = this.world.nests[id];
      if (n) this.s.rings.add({ x: n.x, y: n.y, r0: n.r * 1.3, r1: n.r * 2.6, dur: 0.9, c: WHITE, thick: 3 });
    }
  }

  /** End the reading pause now (the coach's Go button). */
  skipRead(): void {
    this.readUntil = 0;
    this.readLeft = 0;
    this.session.held = false;
  }

  /** A mission hides this action: say so instead of doing it. */
  private blocked(a: Lock): boolean {
    if (!this.locked.has(a)) return false;
    this.s.toast(this.lockReason.get(a) ?? 'Not in this lesson: it comes later', '#9aa4c7');
    return true;
  }

  /** Lock an action for this match (campaign unlocks), with the toast that explains it. */
  lock(a: Lock, reason: string): void {
    this.locked.add(a);
    this.lockReason.set(a, reason);
  }

  private finish(r: MatchResult, time: number): void {
    this.result = r;
    this.resultTime = time;
    if (r === 'victory' && this.world.winReason === 'held') this.s.sfx.lineHeld();
    if (r === 'victory') this.s.sfx.victory();
    else this.s.sfx.defeat();
  }

  render(time: number): void {
    this.frame++;
    this.hitSparks();
    drawWorld(this.s.renderer, this.world, {
      alpha: this.session.alpha,
      time,
      frame: this.frame,
      selected: this.selection.units.size ? this.selection.mask(this.world, this.mask) : null,
      selectedNests: this.selection.nests,
      hoverNest: this.hoverNest,
      human: this.human,
      warlord: this.warlord,
    });
    this.drawAim();
    this.drawEdgeMarkers(time);
    if (this.brush) {
      const b = this.brush;
      this.s.renderer.shape(true, b.x, b.y, b.r, 0, 1, 0, 1.5 / b.r, WHITE, 120);
    }
  }

  /** Sparks where counters land, glints where shots bounce off. Sampled, client-only. */
  private hitSparks(): void {
    const w = this.world;
    if (w.beamCount === 0 || this.session.paused) return;
    const { particles, camera } = this.s;
    for (let n = 0; n < 8; n++) {
      const k = Math.floor(Math.random() * w.beamCount);
      const a = w.beams[k * 2], t = w.beams[k * 2 + 1];
      if (a < 0) continue;
      const [sx, sy] = camera.toScreen(w.x[t], w.y[t]);
      if (sx < 0 || sy < 0 || sx > camera.viewW || sy > camera.viewH) continue;
      const eff = DAMAGE_VS[w.kind[a]][w.kind[t]];
      if (eff >= 1.3 && Math.random() < 0.5) {
        particles.burst(w.x[t], w.y[t], mixRgb(FACTION_RGB[w.owner[a]], WHITE, 0.5), 2, 70, 1.6, 0.22);
      } else if (eff <= 0.75 && Math.random() < 0.2) {
        particles.burst(w.x[t], w.y[t], [170, 176, 196], 1, 50, 1.2, 0.15);
      }
    }
  }

  /** Arrows at the screen edge pointing to off-screen drops, Colossi and swarms. */
  private drawEdgeMarkers(time: number): void {
    const ev = this.world.events;
    const w = this.world;
    const marks: [number, number, readonly number[]][] = [];
    // A stronghold's citadel (#100), while it's still the goal.
    if (w.citadel >= 0 && w.nests[w.citadel].owner !== this.human) {
      const c = w.nests[w.citadel];
      marks.push([c.x, c.y, FACTION_RGB[this.warlord?.faction ?? c.owner] ?? WHITE]);
    }
    for (const d of ev?.drops ?? []) marks.push([d.x, d.y, DROP_MARK]);
    for (const c of ev?.colossi ?? []) {
      const s = w.uidToSlot.get(c.uid);
      if (s !== undefined) marks.push([w.x[s], w.y[s], FERAL]);
    }
    for (const sw of ev?.swarms ?? []) {
      let x = 0, y = 0, n = 0;
      for (const u of sw.uids) {
        const s = w.uidToSlot.get(u);
        if (s === undefined) continue;
        x += w.x[s];
        y += w.y[s];
        n++;
      }
      if (n >= 6) marks.push([x / n, y / n, FERAL]);
    }
    const { camera, renderer } = this.s;
    const pad = 28;
    const pulse = 0.6 + 0.4 * Math.sin(time * 5);
    for (const [x, y, c] of marks) {
      const [sx, sy] = camera.toScreen(x, y);
      if (sx >= 0 && sy >= 0 && sx <= camera.viewW && sy <= camera.viewH) continue;
      const cx = camera.viewW / 2, cy = camera.viewH / 2;
      const dx = sx - cx, dy = sy - cy;
      const k = Math.min((cx - pad) / Math.abs(dx || 1e-6), (cy - pad) / Math.abs(dy || 1e-6));
      const [wx, wy] = camera.toWorld(cx + dx * k, cy + dy * k);
      // Triangle shape points "up" at rotation 0; turn it toward the target.
      const rot = Math.atan2(dx, -dy);
      renderer.shape(true, wx, wy, (11 * renderer.dpr) / camera.zoom, 3, 0, -rot, 0.6, c, Math.round(230 * pulse));
    }
  }

  private drawAim(): void {
    const power = this.aim;
    const cur = this.cursor;
    if (!power || !cur) return;
    const r = this.s.renderer;
    const c = FACTION_RGB[this.human];
    const boost = powerBoost(this.world, this.human, power);
    if (power === 'barrage') {
      const R = POWER.barrageRadius * boost;
      // Where it can reach: a ring around every nest we own.
      for (const n of this.world.nests) {
        if (n.owner === this.human) r.shape(true, n.x, n.y, POWER.barrageRange, 0, 1, 0, 0.006, c, 55);
      }
      const from = barrageLaunch(this.world, this.human, cur[0], cur[1]);
      if (!from) {
        r.shape(true, cur[0], cur[1], R, 0, 1, 0, 0.03, OUT_OF_RANGE, 160);
        return;
      }
      r.beam(from.x, from.y, cur[0], cur[1], c[0], c[1], c[2], 60, 1.2);
      r.shape(true, cur[0], cur[1], R, 0, 1, 0, 0.03, c, 200);
      r.shape(true, cur[0], cur[1], R, 7, 1, 0, 0, c, 40);
    } else if (power === 'blink') {
      const from = this.selectionCenter();
      if (!from) return;
      let dx = cur[0] - from[0], dy = cur[1] - from[1];
      const d = Math.hypot(dx, dy);
      const range = POWER.blinkRange * boost * this.world.factions[this.human].mods.blinkRange;
      if (d > range) {
        dx *= range / d;
        dy *= range / d;
      }
      r.shape(true, from[0], from[1], range, 0, 1, 0, 0.01, c, 90);
      r.beam(from[0], from[1], from[0] + dx, from[1] + dy, c[0], c[1], c[2], 160, 1.5);
      r.shape(true, from[0] + dx, from[1] + dy, 16, 0, 1, 0, 0.12, WHITE, 220);
    } else if (power === 'lockdown') {
      const n = this.nestAt(cur[0], cur[1], 1.6);
      const ok = n && n.owner >= 0 && n.owner !== NEUTRAL && this.world.hostile(n.owner, this.human);
      if (n) r.shape(true, n.x, n.y, n.r * 1.6, 0, 1, 0, 0.06, ok ? WHITE : [255, 93, 115], 220);
      else r.shape(true, cur[0], cur[1], 14, 0, 1, 0, 0.1, [255, 93, 115], 160);
    }
  }

  /** Your army vs your supply cap. */
  supply(): { units: number; cap: number; blocked: boolean } {
    const w = this.world;
    const units = w.unitCount[this.human] ?? 0;
    const cap = supplyCap(w, this.human);
    return { units, cap, blocked: units >= cap };
  }

  /** Say so when production stops at the cap (at most every 20s), louder if a lost nest caused it. */
  private checkSupply(): void {
    const w = this.world;
    const { units, cap, blocked } = this.supply();
    let nests = 0;
    for (const n of w.nests) if (n.owner === this.human) nests++;
    if (blocked && !this.supplyBlocked && w.tick - this.supplyToastTick > 20 * TICK_HZ && nests > 0) {
      this.supplyToastTick = w.tick;
      this.s.sfx.fail();
      this.s.toast(
        nests < this.supplyNests
          ? `Lost a nest: over supply (${units}/${cap}). Production paused`
          : `Supply cap reached (${cap}). Take or upgrade nests to grow your army`,
        '#ffb627',
      );
    }
    this.supplyBlocked = blocked;
    this.supplyNests = nests;
  }

  private drainEvents(): void {
    const w = this.world;
    const { particles, rings, sfx, camera, toast } = this.s;
    const d = w.deaths;
    for (let k = 0; k < d.length; k += 3) {
      particles.burst(d[k], d[k + 1], FACTION_RGB[d[k + 2]], 4, 55, 2, 0.5);
      sfx.death(d[k], d[k + 1], d[k + 2]);
    }
    w.deaths = [];
    // A stronghold's walls breached: the first time you contest the citadel.
    if (!this.breached && w.citadel >= 0 && w.nests[w.citadel].contested && w.nests[w.citadel].owner !== this.human) {
      this.breached = true;
      sfx.citadelBreach();
      toast('At the citadel: take it to win', hex(this.warlord?.faction ?? w.nests[w.citadel].owner));
    }

    for (const e of w.fx) {
      const c = FACTION_RGB[e.f] ?? WHITE;
      const nest = w.nests[e.nest];
      switch (e.type) {
        case 'capture':
          if (e.nest === w.citadel && e.f === this.human) sfx.citadelFall();
          rings.add({ x: e.x, y: e.y, r0: e.r, r1: e.r * 3.2, dur: 0.7, c, thick: 2.5 });
          particles.burst(e.x, e.y, c, 26, 120, 2.6, 0.8);
          sfx.capture(e.x, e.y, e.f === this.human);
          if (e.f === this.human) toast(`Captured ${NEST_NAMES[nest.type]}`, hex(e.f));
          break;
        case 'neutralize':
          rings.add({ x: e.x, y: e.y, r0: e.r * 1.4, r1: e.r * 0.6, dur: 0.5, c: FACTION_RGB[e.prev] ?? WHITE, thick: 2 });
          if (e.prev === this.human) {
            sfx.lost(e.x, e.y);
            toast(`Lost ${NEST_NAMES[nest.type]}`, '#ff5d73');
          }
          break;
        case 'levelup':
          rings.add({ x: e.x, y: e.y, r0: e.r, r1: e.r * 2.2, dur: 0.6, c: WHITE, thick: 2 });
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.5, r1: e.r * 1.6, dur: 0.5, c, thick: 4 });
          sfx.levelUp(e.x, e.y, e.f === this.human);
          if (e.f === this.human) {
            toast(`${NEST_NAMES[nest.type]} upgraded to level ${nest.level}`, hex(e.f));
          }
          break;
        case 'nova': {
          rings.add({ x: e.x, y: e.y, r0: 6, r1: e.r, dur: 0.55, c: WHITE, thick: 5 });
          rings.add({ x: e.x, y: e.y, r0: 4, r1: e.r * 1.15, dur: 0.8, c, thick: 3 });
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.2, r1: e.r, dur: 0.35, c, thick: 0, disc: true });
          particles.burst(e.x, e.y, c, 60, e.r * 2.2, 2.8, 1.2);
          const [sx, sy] = camera.toScreen(e.x, e.y);
          if (sx > -200 && sy > -200 && sx < camera.viewW + 200 && sy < camera.viewH + 200) {
            camera.shake = Math.min(1, camera.shake + (e.f === this.human ? 0.9 : 0.5));
          }
          sfx.nova(e.x, e.y, e.f === this.human);
          break;
        }
        case 'surge':
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.3, r1: e.r * 1.4, dur: 0.5, c, thick: 2 });
          sfx.surge(e.x, e.y, e.f === this.human);
          break;
        case 'fortify':
          rings.add({ x: e.x, y: e.y, r0: e.r * 1.3, r1: e.r * 0.8, dur: 0.45, c: WHITE, thick: 3 });
          sfx.fortify(e.x, e.y, e.f === this.human);
          break;
        case 'barrage':
          sfx.barrageCast(e.x, e.y);
          if (e.f !== this.human && this.isNearMine(e.x, e.y, e.r * 1.5)) toast('Incoming Barrage! Move out', '#ff5d73');
          break;
        case 'barrageHit': {
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.2, r1: e.r * 1.1, dur: 0.5, c: WHITE, thick: 4 });
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.5, r1: e.r, dur: 0.3, c, thick: 0, disc: true });
          particles.burst(e.x, e.y, c, 40, e.r * 2, 2.6, 1.5);
          const [sx, sy] = camera.toScreen(e.x, e.y);
          if (sx > -200 && sy > -200 && sx < camera.viewW + 200 && sy < camera.viewH + 200) {
            camera.shake = Math.min(1, camera.shake + (e.f === this.human ? 0.9 : 0.5));
          }
          sfx.barrageHit(e.x, e.y, e.f === this.human);
          break;
        }
        case 'blink':
          particles.burst(e.x0, e.y0, c, 30, 90, 2.2, 0.5);
          particles.burst(e.x, e.y, c, 30, 90, 2.2, 0.5);
          rings.add({ x: e.x0, y: e.y0, r0: e.r, r1: 4, dur: 0.3, c, thick: 2 });
          rings.add({ x: e.x, y: e.y, r0: 4, r1: e.r * 1.3, dur: 0.4, c, thick: 2 });
          sfx.blink(e.x0, e.y0, e.x, e.y, e.f === this.human);
          break;
        case 'lockdown':
          rings.add({ x: e.x, y: e.y, r0: e.r * 3, r1: e.r * 1.2, dur: 0.5, c: WHITE, thick: 3 });
          sfx.lockdown(e.x, e.y, e.f === this.human || e.prev === this.human);
          if (e.prev === this.human) toast(`Your ${NEST_NAMES[nest.type]} is locked down`, '#ff5d73');
          break;
        case 'upgradeFail':
          if (e.f === this.human) {
            sfx.fail();
            toast(`Need ${e.r} more dots near the nest to upgrade`, '#ffb627');
          }
          break;
        case 'eliminated':
          if (e.f === this.human) toast('You have been eliminated', '#ff5d73');
          else {
            toast(`${FACTION_NAMES[e.f]} eliminated`, hex(e.f));
            sfx.eliminated();
          }
          break;
        case 'absorb':
          break;
        case 'swarmSpawn':
          rings.add({ x: e.x, y: e.y, r0: e.r * 2.5, r1: e.r * 0.5, dur: 0.8, c: FERAL, thick: 3 });
          sfx.swarmHorn();
          toast('A wild swarm is coming! It hunts the biggest army', '#d65c4e');
          break;
        case 'bloomSwarm':
          rings.add({ x: e.x, y: e.y, r0: e.r * 2.5, r1: e.r * 0.5, dur: 0.9, c: FERAL, thick: 3 });
          sfx.bloomSwarm();
          if (!this.bloomToasted) toast('The Bloom sends its swarms. They hunt every army alike', '#d65c4e');
          this.bloomToasted = true;
          break;
        case 'heartWindup':
          rings.add({ x: e.x, y: e.y, r0: e.r * 1.6, r1: e.r, dur: 0.9, c: FERAL, thick: 2 });
          sfx.heartWindup(e.x, e.y);
          break;
        case 'siegeWave': {
          // e.prev: the wave's index in the schedule; pincers fire once per side.
          const wave = w.siege?.waves[e.prev];
          rings.add({ x: e.x, y: e.y, r0: 20, r1: 140, dur: 0.9, c: FERAL, thick: 3 });
          if (wave && wave.from[0] === w.siege!.spawns.findIndex((p) => p[0] === e.x && p[1] === e.y)) {
            sfx.siegeWave();
            toast(`Wave ${e.prev + 1}: ${WAVE_KINDS[wave.kind].name}, ${wave.size} strong`, '#e3707a');
          }
          break;
        }
        case 'capitalLost':
          sfx.capitalAlarm();
          rings.add({ x: e.x, y: e.y, r0: e.r * 3, r1: e.r, dur: 0.6, c: [255, 93, 115], thick: 3 });
          toast('Your capital has fallen: retake it within 20 seconds!', '#ff5d73');
          break;
        case 'capitalRetaken':
          toast('Capital retaken', hex(this.human));
          break;
        case 'heartPulse': {
          rings.add({ x: e.x, y: e.y, r0: 20, r1: e.r, dur: 0.4, c: FERAL, thick: 5 });
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.4, r1: e.r, dur: 0.35, c: FERAL, thick: 0, disc: true });
          const [sx, sy] = camera.toScreen(e.x, e.y);
          if (sx > -100 && sy > -100 && sx < camera.viewW + 100 && sy < camera.viewH + 100) camera.shake = Math.min(1, camera.shake + 0.3);
          sfx.heartPulse(e.x, e.y);
          break;
        }
        case 'heartPhase':
          rings.add({ x: e.x, y: e.y, r0: 20, r1: e.r * 2.2, dur: 1, c: WHITE, thick: 4 });
          particles.burst(e.x, e.y, FERAL, 60, 160, 3, 1);
          camera.shake = Math.min(1, camera.shake + 0.5);
          sfx.heartPhase();
          toast('The heart rages! Its swarms rally to defend it', '#d65c4e');
          break;
        case 'heartDown': {
          const kc = e.f >= 0 && e.f < NEUTRAL ? c : FERAL;
          rings.add({ x: e.x, y: e.y, r0: 10, r1: e.r * 3, dur: 1.4, c: WHITE, thick: 6 });
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.3, r1: e.r * 2, dur: 0.8, c: kc, thick: 0, disc: true });
          particles.burst(e.x, e.y, FERAL, 140, 240, 3.4, 1.6);
          camera.shake = 1;
          sfx.heartDown(e.x, e.y, e.f === this.human);
          if (e.f === this.human) toast('You destroyed the heart of the Bloom!', hex(e.f));
          else if (e.f >= 0 && e.f < NEUTRAL) toast(`${FACTION_NAMES[e.f]} destroyed the heart. Now beat them`, hex(e.f));
          break;
        }
        case 'dropIncoming':
          sfx.dropIncoming();
          toast('Supply drop incoming: hold it alone for energy and a free upgrade', '#ffe28c');
          break;
        case 'dropTaken':
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.4, r1: e.r * 2.4, dur: 0.7, c, thick: 3 });
          particles.burst(e.x, e.y, c, 30, 110, 2.4, 0.8);
          sfx.dropTaken(e.x, e.y, e.f === this.human);
          if (e.f === this.human) toast(e.nest >= 0 ? 'Supply drop: +energy and a free upgrade' : 'Supply drop: +energy', hex(e.f));
          else toast(`${FACTION_NAMES[e.f]} took the supply drop`, hex(e.f));
          break;
        case 'colossusSpawn':
          rings.add({ x: e.x, y: e.y, r0: e.r * 3, r1: e.r * 0.5, dur: 1.2, c: FERAL, thick: 4 });
          sfx.colossus();
          toast('The Colossus wakes. Land the killing blow for full energy and a free upgrade', '#d65c4e');
          break;
        case 'stomp': {
          rings.add({ x: e.x, y: e.y, r0: 8, r1: e.r, dur: 0.35, c: FERAL, thick: 3 });
          const [sx, sy] = camera.toScreen(e.x, e.y);
          if (sx > -50 && sy > -50 && sx < camera.viewW + 50 && sy < camera.viewH + 50) camera.shake = Math.min(1, camera.shake + 0.15);
          sfx.stomp(e.x, e.y);
          break;
        }
        case 'colossusDown': {
          const kc = e.f >= 0 && e.f < NEUTRAL ? c : FERAL;
          rings.add({ x: e.x, y: e.y, r0: 10, r1: e.r * 2, dur: 0.9, c: WHITE, thick: 5 });
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.3, r1: e.r * 1.5, dur: 0.5, c: kc, thick: 0, disc: true });
          particles.burst(e.x, e.y, FERAL, 70, 180, 3, 1.1);
          camera.shake = Math.min(1, camera.shake + 0.6);
          sfx.colossusDown(e.x, e.y, e.f === this.human);
          if (e.f === this.human) toast('You felled the Colossus! Full energy and a free upgrade', hex(e.f));
          else if (e.f >= 0 && e.f < NEUTRAL) toast(`${FACTION_NAMES[e.f]} felled the Colossus`, hex(e.f));
          break;
        }
        case 'domStart': {
          const mine = w.teamOf[e.f] === w.teamOf[this.human];
          sfx.domStart(mine);
          if (mine) toast(`You are dominating! Hold ${Math.ceil(w.nests.length * w.domShare)} nests for 30s to win`, hex(e.f));
          else toast(`${FACTION_NAMES[e.f]} is dominating! Take back a nest to stop them`, '#ff5d73');
          for (const n of w.nests) {
            if (n.owner >= 0 && n.owner !== NEUTRAL && w.teamOf[n.owner] === w.teamOf[e.f]) {
              rings.add({ x: n.x, y: n.y, r0: n.r, r1: n.r * 3, dur: 0.8, c: FACTION_RGB[n.owner], thick: 3 });
            }
          }
          break;
        }
        case 'domBreak': {
          const mine = w.teamOf[e.f] === w.teamOf[this.human];
          sfx.domBreak(mine);
          toast(mine ? 'Your domination was broken' : `${FACTION_NAMES[e.f]}'s domination is broken`, mine ? '#ff5d73' : '#9aa4c7');
          break;
        }
        case 'crystal':
          rings.add({ x: e.x, y: e.y, r0: e.r * 0.4, r1: e.r * 1.5, dur: 0.6, c, thick: 2 });
          particles.burst(e.x, e.y, c, 14, 70, 2, 0.6);
          sfx.crystal(e.x, e.y, e.f === this.human);
          break;
        case 'escalation':
          toast('Escalation: comeback bonuses are fading. Time to close it out!', '#ffb627');
          sfx.escalation();
          break;
      }
    }
    w.fx = [];
  }

  // ---- player actions (from input and HUD) -------------------------------

  nestAt(wx: number, wy: number, slack = 1.25): Nest | null {
    let best: Nest | null = null;
    let bd = Infinity;
    for (const n of this.world.nests) {
      const d = (n.x - wx) ** 2 + (n.y - wy) ** 2;
      if (d <= (n.r * slack) ** 2 && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  private ownUnitsIn(test: (x: number, y: number) => boolean): number[] {
    const w = this.world;
    const out: number[] = [];
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i] || w.owner[i] !== this.human || w.state[i] === UNIT_FEEDING) continue;
      if (test(w.x[i], w.y[i])) out.push(w.uid[i]);
    }
    return out;
  }

  selectBox(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    this.typeCycle = null;
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    const units = this.ownUnitsIn((x, y) => x >= ax && x <= bx && y >= ay && y <= by);
    const nests = this.world.nests
      .filter((n) => n.owner === this.human && n.x >= ax && n.x <= bx && n.y >= ay && n.y <= by)
      .map((n) => n.id);
    this.selection.set(units, nests, additive);
    if (units.length || nests.length) this.s.sfx.click();
    this.noteSelection('box');
  }

  /** Tell the recorder how the selection just changed. */
  noteSelection(method: SelectMethod): void {
    this.rec?.select(this.world, method, this.selection.units.size, this.selection.nests.size);
  }

  clearSelection(): void {
    this.selection.clear();
    this.noteSelection('clear');
  }

  /**
   * Click-select. Dots win over nests: a nest is picked only by clicking its
   * center, or when no dots are under the cursor.
   */
  selectAt(wx: number, wy: number, radius: number, additive: boolean): boolean {
    this.typeCycle = null;
    const n = this.nestAt(wx, wy);
    const own = n && n.owner === this.human ? n : null;
    const units = this.ownUnitsIn((x, y) => (x - wx) ** 2 + (y - wy) ** 2 <= radius * radius);
    const onCore = own && (own.x - wx) ** 2 + (own.y - wy) ** 2 <= (own.r * 0.4) ** 2;
    if (own && (onCore || units.length === 0)) {
      if (additive && this.selection.nests.has(own.id)) this.selection.nests.delete(own.id);
      else this.selection.set([], [own.id], additive);
      this.s.sfx.click();
      this.noteSelection('click');
      return true;
    }
    if (units.length) {
      // Grow to the whole local blob so a click grabs a group, not one dot.
      const w = this.world;
      let cx = 0, cy = 0;
      for (const u of units) {
        const s = w.uidToSlot.get(u)!;
        cx += w.x[s];
        cy += w.y[s];
      }
      cx /= units.length;
      cy /= units.length;
      const R = radius * 2.2;
      this.selection.set(this.ownUnitsIn((x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= R * R), [], additive);
      this.s.sfx.click();
      this.noteSelection('click');
      return true;
    }
    if (!additive) this.selection.clear();
    return false;
  }

  /** Brush selection (hold Space and move): adds own dots under the brush. */
  paintSelect(wx: number, wy: number, radius: number): void {
    const before = this.selection.units.size;
    for (const u of this.ownUnitsIn((x, y) => (x - wx) ** 2 + (y - wy) ** 2 <= radius * radius)) {
      this.selection.units.add(u);
    }
    if (this.selection.units.size > before) {
      this.s.sfx.click();
      this.noteSelection('paint');
    }
  }

  selectAll(): void {
    this.selection.set(this.ownUnitsIn(() => true), [], false);
    this.typeCycle = null;
    this.s.sfx.click();
    this.noteSelection('all');
  }

  // ---- picking unit types out of a selection ------------------------------

  /** set while Tab-cycling: the selection we started from and where we are */
  private typeCycle: { base: number[]; idx: number } | null = null;

  /** Selected unit counts by kind. */
  selectionMix(): number[] {
    const w = this.world;
    const counts = [0, 0, 0, 0];
    for (const u of this.selection.units) {
      const s = w.uidToSlot.get(u);
      if (s !== undefined) counts[w.kind[s]]++;
    }
    return counts;
  }

  private kindOf(uid: number): number {
    const s = this.world.uidToSlot.get(uid);
    return s === undefined ? -1 : this.world.kind[s];
  }

  /** Keep only `kind` in the selection (or drop it, when `remove`). */
  filterSelection(kind: number, remove = false): void {
    const keep = [...this.selection.units].filter((u) => (this.kindOf(u) === kind) !== remove);
    if (!keep.length) return;
    this.selection.set(keep, [], false);
    this.typeCycle = null;
    this.s.sfx.click();
    this.noteSelection('filter');
  }

  /** Every own unit of `kind` inside the given world rect (the screen). */
  selectKindIn(kind: number, x0: number, y0: number, x1: number, y1: number): void {
    const w = this.world;
    const units: number[] = [];
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i] || w.owner[i] !== this.human || w.kind[i] !== kind || w.state[i] === UNIT_FEEDING) continue;
      if (w.x[i] >= x0 && w.x[i] <= x1 && w.y[i] >= y0 && w.y[i] <= y1) units.push(w.uid[i]);
    }
    if (!units.length) return;
    this.selection.set(units, [], false);
    this.typeCycle = null;
    this.s.sfx.click();
    this.noteSelection('kind');
  }

  /**
   * Number keys 1-4: keep just this type from the current group. The group
   * is remembered, so 1 then 3 picks Spears from the same blob. If the group
   * has none of this type, grab that type on screen instead.
   */
  selectType(kind: number): void {
    const base = this.typeCycle?.base ?? [...this.selection.units];
    const pick = base.filter((u) => this.kindOf(u) === kind);
    if (!pick.length) return this.selectKindOnScreen(kind);
    this.selection.set(pick, [], false);
    this.typeCycle = { base, idx: [0, 1, 2, 3].filter((k) => base.some((u) => this.kindOf(u) === k)).indexOf(kind) };
    this.s.sfx.click();
    this.noteSelection('type');
  }

  /** Every own unit of `kind` currently on screen. */
  selectKindOnScreen(kind: number): void {
    const cam = this.s.camera;
    const [x0, y0] = cam.toWorld(0, 0);
    const [x1, y1] = cam.toWorld(cam.viewW, cam.viewH);
    this.selectKindIn(kind, x0, y0, x1, y1);
  }

  /** Own unit kind under a world point, or -1. */
  kindAt(wx: number, wy: number, radius: number): number {
    const w = this.world;
    let best = -1, bd = radius * radius;
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i] || w.owner[i] !== this.human) continue;
      const d = (w.x[i] - wx) ** 2 + (w.y[i] - wy) ** 2;
      if (d < bd) {
        bd = d;
        best = w.kind[i];
      }
    }
    return best;
  }

  /**
   * Tab: narrow the selection to one unit type at a time, cycling through the
   * types it started with; after the last, back to the whole group.
   */
  cycleType(dir: 1 | -1): void {
    const base = this.typeCycle?.base ?? [...this.selection.units];
    const kinds = [0, 1, 2, 3].filter((k) => base.some((u) => this.kindOf(u) === k));
    if (kinds.length < 2) return;
    // Steps: each kind, then "all" (index kinds.length).
    const n = kinds.length + 1;
    const idx = ((this.typeCycle ? this.typeCycle.idx : kinds.length) + dir + n) % n;
    const units = idx === kinds.length ? base : base.filter((u) => this.kindOf(u) === kinds[idx]);
    this.selection.set(units, [], false);
    this.typeCycle = { base, idx };
    this.s.sfx.click();
    this.noteSelection('cycle');
  }

  commandAt(wx: number, wy: number): boolean {
    const sel = this.selection;
    if (sel.empty) return false;
    const n = this.nestAt(wx, wy);
    const tx = n ? n.x : wx, ty = n ? n.y : wy;
    if (sel.units.size) {
      this.session.issue({ t: 'move', p: this.human, units: [...sel.units], x: wx, y: wy, nest: n ? n.id : -1 });
    }
    if (sel.nests.size) {
      this.session.issue({ t: 'rally', p: this.human, nests: [...sel.nests], x: tx, y: ty });
    }
    const c = FACTION_RGB[this.human];
    this.s.rings.add({ x: tx, y: ty, r0: n ? n.r * 1.8 : 22, r1: n ? n.r * 1.1 : 4, dur: 0.35, c, thick: 2 });
    this.s.sfx.order();
    return true;
  }

  /** N: send the selected dots to the nearest nest we own; split groups go to their own. Returns the first nest. */
  toNearestNest(): Nest | null {
    if (!this.selection.units.size) {
      this.s.toast('Select dots first, then N', '#9aa4c7');
      return null;
    }
    const orders = nearestNestOrders(this.world, this.human, [...this.selection.units]);
    if (!orders.length) {
      this.s.toast('No nest to fall back to', '#9aa4c7');
      return null;
    }
    const c = FACTION_RGB[this.human];
    for (const o of orders) {
      const n = this.world.nests[o.nest];
      this.session.issue({ t: 'move', p: this.human, units: o.units, x: n.x, y: n.y, nest: n.id });
      this.s.rings.add({ x: n.x, y: n.y, r0: n.r * 1.8, r1: n.r * 1.1, dur: 0.35, c, thick: 2 });
    }
    this.s.sfx.order();
    return this.world.nests[orders[0].nest];
  }

  surge(): void {
    if (this.blocked('surge')) return;
    if (!this.selection.units.size) return this.s.toast('Select dots first, then Surge', '#9aa4c7');
    if (this.world.factions[this.human].energy < surgeCost(this.world, this.human)) return this.s.sfx.fail();
    this.session.issue({ t: 'surge', p: this.human, units: [...this.selection.units] });
  }

  nova(): void {
    if (this.blocked('nova')) return;
    // In a lesson, don't let a Nova fizzle on empty ground: it costs dots and energy.
    if (this.mission && this.selection.units.size >= 4 && !this.novaWouldHit()) {
      return this.s.toast('Nova only hits around your selected dots: wait until the enemy reaches them', '#ffd166');
    }
    if (this.selection.units.size < 4) return this.s.toast('Select at least 4 dots for Nova', '#9aa4c7');
    if (this.world.factions[this.human].energy < POWER.novaCost) return this.s.sfx.fail();
    this.session.issue({ t: 'nova', p: this.human, units: [...this.selection.units] });
  }

  private novaWouldHit(): boolean {
    const w = this.world;
    let cx = 0, cy = 0, n = 0;
    for (const u of this.selection.units) {
      const s = w.uidToSlot.get(u);
      if (s === undefined) continue;
      cx += w.x[s];
      cy += w.y[s];
      n++;
    }
    if (!n) return false;
    cx /= n;
    cy /= n;
    const r = novaRadius(n, w.factions[this.human].mods.novaRadius);
    for (let i = 0; i < w.n; i++) {
      if (w.alive[i] && w.hostile(w.owner[i], this.human) && (w.x[i] - cx) ** 2 + (w.y[i] - cy) ** 2 < r * r) return true;
    }
    return false;
  }

  canUse(power: NestPower): boolean {
    return hasPower(this.world, this.human, power);
  }

  private power(power: NestPower, cost: number): boolean {
    if (!this.canUse(power)) {
      this.s.toast(`Hold a ${NEST_NAMES[POWER_NEST[power]]} to use this`, '#9aa4c7');
      return false;
    }
    if (this.world.factions[this.human].energy < cost) {
      this.s.sfx.fail();
      return false;
    }
    return true;
  }

  fortify(): void {
    if (this.blocked('fortify')) return;
    if (!this.selection.units.size) return this.s.toast('Select dots first, then Fortify', '#9aa4c7');
    if (!this.power('fortify', POWER.fortifyCost)) return;
    this.session.issue({ t: 'fortify', p: this.human, units: [...this.selection.units] });
  }

  /** Targeted powers: cast at a world point. */
  castAt(power: NestPower, wx: number, wy: number): void {
    this.aim = null;
    if (this.blocked(power)) return;
    if (power === 'fortify') return this.fortify();
    if (power === 'barrage') {
      if (!this.power('barrage', POWER.barrageCost)) return;
      if (!barrageLaunch(this.world, this.human, wx, wy)) {
        this.s.sfx.fail();
        return this.s.toast('Out of range: Barrage launches from your nests', '#9aa4c7');
      }
      this.session.issue({ t: 'barrage', p: this.human, x: wx, y: wy });
    } else if (power === 'blink') {
      if (!this.selection.units.size) return this.s.toast('Select dots first, then Blink', '#9aa4c7');
      if (!this.power('blink', POWER.blinkCost)) return;
      this.session.issue({ t: 'blink', p: this.human, units: [...this.selection.units], x: wx, y: wy });
    } else {
      const n = this.nestAt(wx, wy, 1.6);
      if (!n || n.owner < 0 || n.owner === NEUTRAL || !this.world.hostile(n.owner, this.human)) {
        return this.s.toast('Lockdown needs an enemy nest under the cursor', '#9aa4c7');
      }
      if (!this.power('lockdown', POWER.lockdownCost)) return;
      this.session.issue({ t: 'lockdown', p: this.human, nest: n.id });
    }
  }

  /** HUD button: Fortify fires at once; the others wait for a click. */
  startAim(power: NestPower): void {
    if (this.blocked(power)) return;
    if (power === 'fortify') return this.fortify();
    if (!this.canUse(power)) return void this.power(power, 0);
    this.aim = this.aim === power ? null : power;
  }

  private isNearMine(x: number, y: number, r: number): boolean {
    const w = this.world;
    for (let i = 0; i < w.n; i++) {
      if (w.alive[i] && w.owner[i] === this.human && (w.x[i] - x) ** 2 + (w.y[i] - y) ** 2 < r * r) return true;
    }
    return false;
  }

  upgrade(): void {
    if (this.blocked('upgrade')) return;
    const ids = [...this.selection.nests].filter((id) => {
      const n = this.world.nests[id];
      return n.owner === this.human && (n.level < MAX_LEVEL || n.control < 1);
    });
    if (!ids.length) return this.s.toast('Select one of your nests to upgrade', '#9aa4c7');
    for (const id of ids) this.session.issue({ t: 'upgrade', p: this.human, nest: id });
  }

  /** Remaining dots for the first selected nest that can be fed (repair first, then level). */
  upgradeInfo(): { nest: Nest; cost: number; repair: boolean } | null {
    for (const id of this.selection.nests) {
      const n = this.world.nests[id];
      if (n && n.owner === this.human && (n.level < MAX_LEVEL || n.control < 1)) return { nest: n, cost: feedNeed(n), repair: n.control < 1 };
    }
    return null;
  }

  /**
   * Unit mix the counter wheel should explain: an enemy group under the
   * cursor if there is one, else your selection.
   */
  focusMix(pickRadius: number): { enemy: boolean; counts: number[] } | null {
    const w = this.world;
    const cur = this.cursor;
    if (cur) {
      const counts = [0, 0, 0, 0];
      let n = 0;
      const r2 = (pickRadius * 2) ** 2;
      for (let i = 0; i < w.n; i++) {
        if (!w.alive[i] || w.owner[i] === NEUTRAL || !w.hostile(w.owner[i], this.human)) continue;
        if ((w.x[i] - cur[0]) ** 2 + (w.y[i] - cur[1]) ** 2 > r2) continue;
        counts[w.kind[i]]++;
        n++;
      }
      if (n >= 3) return { enemy: true, counts };
    }
    if (!this.selection.units.size) return null;
    const counts = [0, 0, 0, 0];
    for (const u of this.selection.units) {
      const s = w.uidToSlot.get(u);
      if (s !== undefined) counts[w.kind[s]]++;
    }
    return { enemy: false, counts };
  }

  homePoint(): [number, number] {
    const w = this.world;
    const mine = w.nests.filter((n) => n.owner === this.human);
    if (mine.length) return [mine[0].x, mine[0].y];
    let x = 0, y = 0, c = 0;
    for (let i = 0; i < w.n; i++) {
      if (w.alive[i] && w.owner[i] === this.human) {
        x += w.x[i];
        y += w.y[i];
        c++;
      }
    }
    return c ? [x / c, y / c] : [w.width / 2, w.height / 2];
  }

  selectionCenter(): [number, number] | null {
    const w = this.world;
    let x = 0, y = 0, c = 0;
    for (const u of this.selection.units) {
      const s = w.uidToSlot.get(u);
      if (s === undefined) continue;
      x += w.x[s];
      y += w.y[s];
      c++;
    }
    for (const id of this.selection.nests) {
      x += w.nests[id].x;
      y += w.nests[id].y;
      c++;
    }
    return c ? [x / c, y / c] : null;
  }
}

export function hex(f: number): string {
  const c = FACTION_RGB[f] ?? FACTION_RGB[NEUTRAL];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
