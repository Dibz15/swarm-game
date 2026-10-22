# SWARM

A fast, colorful dot-swarm RTS for the browser. You command one neon color of tiny square dots and fight rival colors for control of the map's **nests** (spawners). Dots fight automatically when they get close to an enemy. Your job is to decide where they go and when.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # determinism, spatial, capture, upgrade, bot-FFA smoke test
npm run build      # static site in dist/ — host anywhere (GitHub Pages, Netlify, S3…)
```

CI: `.github/workflows/ci.yml` runs typecheck, tests and build on every push and PR. Pushes to `main` also publish `dist/` to GitHub Pages (Settings → Pages → Source must be "GitHub Actions").

Balance tools (headless bot matches):

```bash
npx vite-node scripts/balance.ts 4 medium 10   # players, size, games: length, lead changes, stragglers
npx vite-node scripts/map-mix.ts               # nest-type mix across generated maps
npx vite-node scripts/bastion-probe.ts         # stress test: every neutral nest is a Bastion
npx vite-node scripts/personality-probe.ts 4 medium 120   # win rate per bot personality
npx vite-node scripts/ffa-probe.ts             # who attacks whom, knockout timing
npx vite-node scripts/collapse-probe.ts        # how the first-out player loses
npx vite-node scripts/kill-matrix.ts           # winner vs loser kill shares
npx vite-node scripts/trace.ts 5 large 1005    # 30s timeline of one match
npx vite-node scripts/terrain-probe.ts heavy 40 7 3   # terrain amounts, connectivity, gen time (+ ASCII map)
EVENTS=normal npx vite-node scripts/event-probe.ts 4 medium 20   # events per game, who profits, drop/winner correlation
npx vite-node scripts/upgrade-probe.ts turtler medium 40   # mirror match: eager upgrader vs never-upgrader
```

Every probe takes `TERRAIN=none|light|standard|heavy` and `EVENTS=off|calm|normal|wild` (defaults `none` / `off`), e.g. `TERRAIN=standard npx vite-node scripts/balance.ts 4 medium 40`. For sim timing without vite-node overhead:

```bash
npx esbuild scripts/bench.ts --bundle --platform=node --format=esm --outfile=$TMPDIR/bench.mjs
TERRAIN=heavy node $TMPDIR/bench.mjs 5000
```

Dev URL flags:
- `?debug` shows the fps / sim-ms overlay. Press `` ` `` to toggle it.
- `?bench=5000` runs a stress battle with about 5,000 units.
- `?eventdemo` starts a small match where the wild swarm, a supply drop and the Colossus all arrive in the first seconds.

## How it plays

- **Nests** spawn units in a rock-paper-scissors loop: **Spears pierce Shields, Shields stop Swarmers, Swarmers overrun Spears.**
  - **Hive → Swarmers:** pack bonus, more damage with friendly Swarmers nearby.
  - **Forge → Shields:** draw enemy fire.
  - **Spire → Spears:** long range, shots splash onto nearby enemies.
  - **Den → Raiders:** fast, fragile, capture nests 3× faster.
  - **Bastion:** spawns slowly, beam turret, shields allies in range.
- **Nest powers:** holding a nest type unlocks its power. **Fortify** (Forge, R): selected dots take half damage but move slower. **Barrage** (Spire, F): telegraphed strike at the cursor. **Blink** (Den, G): teleport the selection toward the cursor. **Lockdown** (Bastion, T): an enemy nest can't spawn or recover for 8s.
- **Terrain** (skirmish setup: None / Light / Standard / Heavy):
  - **Rock** blocks movement and line of fire. Units path around it, and gaps between rocks become chokepoints. Blink jumps over it.
  - **Nebula** slows everything inside: ambush ground.
  - **Rift** burns anything standing in it: a risky shortcut that Raiders cross fastest.
  - **Crystal** charges energy for the only team standing on it.
- **Map events** (skirmish setup: Off / Calm / Normal / Wild, seeded like the map):
  - **Wild swarm:** a neutral red-gray swarm that hunts the biggest army nearby. It can contest nests but never capture them. Lure it into a rival.
  - **Supply drop:** lands at fair spots, usually near the weakest player. Hold it alone for energy plus a free nest upgrade; the biggest army only gets the energy.
  - **Colossus:** a slow giant walking across the map. Spears hurt it most. The killing blow earns full energy and a free upgrade.
  - **Regrowth:** neutral nests rebuild their guards, and unowned nests left alone for 45 s go wild again.
- **Capture** a nest by standing on it with no enemies present. Neutral nests have gray guards. A contested nest stops spawning.
- **Upgrade** a nest by feeding it your dots (U): 12 dots for level 2, 24 more for level 3. Each level is shown as an extra orbit ring and a bigger body.
  - **Level 2:** ×1.5 spawns, a light turret, control recovers twice as fast.
  - **Level 3:** ×2 spawns, veteran units (+35% HP, drawn brighter), and the nest's power is 35% stronger (longer Fortify and Lockdown, wider Barrage, longer Blink).
  - Nests keep their level when captured, so upgraded nests are prizes.
  - Feeding a damaged nest repairs its control first (the button reads **Repair**).
- **Energy** builds up over time and from kills and captures. **Surge** (Q) costs 30: the selected dots get faster, stronger and tougher for 6 seconds. **Nova** (E) costs 60: it sacrifices about 20% of the selected dots and sends out a shockwave.
- **Anti-snowball:** big armies spawn more slowly, each extra nest adds less production (nests^0.9), dots near their own nests take less damage, factions that are behind charge energy faster, starting nests are defended capitals, and bots gang up on a runaway leader.
- **Selecting by type:** 1–4 keep Swarmers / Shields / Spears / Raiders from your group (or grab that type on screen), and Shift+1–4 drops a type. Double-click a unit to grab all of its type on screen. The type chips and counter wheel icons work the same way, and Tab cycles. Control groups are Ctrl+5–9 / 5–9.
- **Escalation:** from minute 5, those comeback rules fade out over 3 minutes so every match reaches an endgame.
- **Win** by eliminating every rival, or by holding 70% of the nests (60% on large maps) for 30 seconds.
- **Bots** have four difficulties (Easy to Brutal; only Brutal gets a production bonus) and four personalities. Every bot expands for the first 90 seconds, then:
  - **Rusher** attacks nearby players, commits hard, and Surges as soon as a fight starts.
  - **Turtler** upgrades nests, builds Bastions and keeps a big home guard.
  - **Expander** prioritizes neutral nests.
  - **Opportunist** circles fights between other players to grab contested nests, and picks on the weakest player in big free-for-alls.

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
  mapgen.ts     MapParams → MapSpec: rotationally symmetric nests + terrain from a seed (portrait variant for phones)
  terrain.ts    walls/fields as capsules; tile flags, exact collision, line of sight, cached flow fields
  events.ts     living-map director: wild swarms, supply drops, the Colossus, garrison regrowth
  mathx.ts      table-based deterministic sin/cos
  hash.ts       state checksum
src/game/     LocalSession (fixed-timestep driver + command log), GameView (match + feedback)
src/render/   WebGL2: instanced units, beams, SDF nest shapes, terrain baked to a distance texture; particles; camera
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
