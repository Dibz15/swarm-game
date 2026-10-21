# SWARM

A fast, colorful dot-swarm RTS for the browser. You command one neon color of tiny square dots and fight rival colors for control of the map's **nests** (spawners). Dots fight automatically when they get close to an enemy. Your job is to decide where they go and when.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # determinism, spatial, capture, upgrade, bot-FFA smoke test
npm run build      # static site in dist/ — host anywhere (GitHub Pages, Netlify, S3…)
```

Dev URL flags:
- `?debug` shows the fps / sim-ms overlay. Press `` ` `` to toggle it.
- `?bench=5000` runs a stress battle with about 5,000 units.

## How it plays

- **Nests** spawn dots. **Hive** spawns standard dots, **Forge** spawns tanks, **Spire** spawns long-range lancers, **Swift** spawns fast dots, and **Bastion** spawns nothing but fires a beam turret.
- **Capture** a nest by standing on it with no enemies present. Neutral nests have gray guards. A contested nest stops spawning.
- **Upgrade** a nest by feeding it your dots (U). Levels 1–3 spawn faster.
- **Energy** builds up over time and from kills and captures. **Surge** (Q) costs 35: the selected dots get faster and stronger for 4 seconds. **Nova** (E) costs 60: it sacrifices about 20% of the selected dots and sends out a shockwave.
- **Win** by eliminating every rival, or by holding 70% of the nests for 30 seconds.
- **Bots** have four personalities (Rusher, Turtler, Expander, Opportunist) and four difficulties (Easy to Brutal). Only Brutal gets a production bonus.

## Architecture

```
src/sim/      deterministic simulation — no DOM, no Math.random, no clock
  world.ts      structure-of-arrays typed arrays (up to 8192 units), nests, factions
  step.ts       step(world, commands) at a fixed 30 Hz
  spatial.ts    uniform grid rebuilt each tick with a counting sort
  combat.ts     nearest-enemy targeting (staggered retargeting), damage, kills
  movement.ts   steering + capped separation, feeding nests
  nests.ts      capture/control, spawning, Bastion turrets
  commands.ts   the only way to change the world: move / rally / upgrade / surge / nova
  ai/bot.ts     bot players — run inside the sim and issue the same Commands as humans
  mapgen.ts     rotationally symmetric maps from a seed (portrait variant for phones)
  mathx.ts      table-based deterministic sin/cos
  hash.ts       state checksum
src/game/     LocalSession (fixed-timestep driver + command log), GameView (match + feedback)
src/render/   WebGL2: instanced units, beams, SDF nest shapes; particles; camera
src/input/    mouse / touch / keyboard → actions; client-only selection
src/ui/       DOM HUD, menus, end screen
src/audio/    procedural WebAudio sound effects
```

**Why deterministic:** the same seed and command log always produce the same match, and `tests/sim.test.ts` checks this. That gives us:
- **Lockstep multiplayer** later: peers exchange only Commands and compare `worldHash` every N ticks.
- **Replays**: `LocalSession.log` already records every command.
- **Headless bot-vs-bot tests**.

## Roadmap

1. ~~Core engine + playable skirmish vs bots~~
2. Balance pass after playtesting
3. Campaign: about 10 levels in JSON, a level-select screen, progress in localStorage
4. Multiplayer: a `LockstepSession` over WebRTC data channels or a small WebSocket relay, with bots filling empty slots
5. Replay viewer and map editor
