# SWARM

A fast, colorful dot-swarm RTS for the browser. You command one neon color of tiny square dots and fight rival colors for control of the map's **nests** (spawners). Dots fight automatically when they get close to an enemy. Your job is to decide where they go and when.

Play the latest build at https://dibz15.github.io/swarm-game/.

## Development

### Requirements
- **Node 22** (`.nvmrc`; CI uses 22) and **npm 10**.
- Any modern browser with WebGL2.
- No other services: the game is a static site, and bots, maps and tests all run locally.

### Setup
```bash
npm ci             # exact versions from package-lock.json
```

### Everyday commands
| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload at http://localhost:5173 |
| `npm run dev -- --host` | Same, also reachable from a phone on the same network (use the printed LAN address) |
| `npm test` | All tests once (`vitest run`): determinism, sim, mapgen, caves, bots, tutorial and more |
| `npx vitest` | Tests in watch mode |
| `npx vitest run tests/chokes.test.ts` | One test file |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | Typecheck, then tests: what CI runs before building |
| `npm run build` | Typecheck and build the static site into `dist/` (host anywhere) |
| `npm run preview` | Serve the built `dist/` at http://localhost:4173 |

Dev URL flags:
- `?debug` shows the fps / sim-ms overlay (press `` ` `` to toggle it) and exposes the app as `window.swarm` for console poking.
- `?bench=5000` runs a stress battle with about 5,000 units.
- `?eventdemo` starts a small match where the wild swarm, a supply drop and the Colossus all arrive in the first seconds.
- `?theme=<id>` forces one music theme everywhere, to audition it (ids in `src/audio/themes.ts`, e.g. `f-lydian`). Settings > Sound > Theme does the same without the URL, and with `?debug` you can call `swarm.sfx.setTheme(id)`.

### Working offline
Everything for day-to-day work runs without a network:
- **Dev server, build, tests and every script** in `scripts/` use only `node_modules`. `npx vite-node …` resolves the local binary and downloads nothing.
- **The UI font** (Chakra Petch) is vendored in `src/assets/fonts/`. The game makes no network requests.
- **Headless bot games and probes** (below) are the offline stand-in for PR-preview playtests.

Before you lose the network:
1. Run `npm ci` once, so `node_modules` matches the lockfile. This also fills the npm cache.
2. Check that a reinstall would work from the cache alone: `rm -rf node_modules && npm ci --offline`. If `node_modules` gets broken mid-flight, the same command fixes it.
3. Run `git fetch` and `git pull` so `main` is current.

While offline, keep the usual one-branch-per-issue flow and commit locally. These steps wait for the network:
- `git push`
- opening PRs (`gh`)
- CI
- PR previews and the live site
- installing any new package

If you need a new dependency on the plane, there's no way to get it: note it and add it when you land.

### Deploys and CI
`.github/workflows/ci.yml` runs typecheck, tests and build on every push and PR. Pushes to `main` publish `dist/` to the `gh-pages` branch. Every PR from this repo gets a playable preview at `…/pr-preview/pr-<n>/`, linked in a PR comment and removed when the PR closes. Settings → Pages → Source must be "Deploy from a branch: `gh-pages` / root".

## Tools: headless bot matches and probes
The sim runs in Node, so balance questions are answered by running many bot-vs-bot games. Each script's header comment documents its arguments.

**Shared options** (from `scripts/env.ts`):
- **Map:** every probe takes `TERRAIN=none|light|standard|heavy`, `CAVES=off|belt|full`, `LAYOUT=classic|open|core|clusters|lanes` and `EVENTS=off|calm|normal|wild`. The defaults are `none`, `off`, picked by seed, and `off`.
  - Example: `CAVES=full npx vite-node scripts/personality-probe.ts 4 medium 40 2`.
- **Tuning overrides** (JSON):
  - `BOT='{"level":2,"surgeAt":6}'` changes one difficulty's knobs.
  - `PERS='{"turtler":{"reserve":0.2}}'` changes a personality's knobs.
  - `CROWD='{"k":2}'` changes the FFA pile-on rule.
  - `CHOKE='{"flank":false}'` changes chokepoint play.
  - `SUPPLY='{"upkeep":0.4}'` changes supply.
  - `PROXY='{"react":2}'` changes the human proxy.

**Balance and bots:**
```bash
npx vite-node scripts/balance.ts 4 medium 10            # players, size, games: length, lead changes, stragglers
npx vite-node scripts/personality-probe.ts 4 medium 120 # win rate per bot personality (last arg: difficulty)
npx vite-node scripts/choke-probe.ts 400 2 2            # A/B: chokepoint play on vs off (games, difficulty, players)
npx vite-node scripts/duel-probe.ts 12 2                # 1v1: each personality vs the human proxy (scripts/proxy.ts)
npx vite-node scripts/dogpile-probe.ts 16 2             # FFA: share of bot attacks aimed at the proxy over time
npx vite-node scripts/ffa-probe.ts                      # who attacks whom, knockout timing
npx vite-node scripts/collapse-probe.ts                 # how the first-out player loses
npx vite-node scripts/kill-matrix.ts                    # winner vs loser kill shares
npx vite-node scripts/upgrade-probe.ts turtler medium 40   # mirror match: eager upgrader vs never-upgrader
npx vite-node scripts/supply-probe.ts 20                # army size vs nests held per minute
npx vite-node scripts/hoard-probe.ts 20                 # idle hoarder vs bots under supply cap variants
npx vite-node scripts/takeoff-probe.ts 24               # runaway leaders: top/2nd army ratio, comebacks
npx vite-node scripts/power-value-probe.ts              # what each power is worth in a fight
npx vite-node scripts/power-usage-probe.ts              # how often bots cast each power
EVENTS=normal npx vite-node scripts/event-probe.ts 4 medium 20   # events per game, who profits
npx vite-node scripts/trace.ts 5 large 1005             # 30 s timeline of one match
```

**Maps:**
```bash
npx vite-node scripts/terrain-probe.ts heavy 40 7 3     # terrain amounts, connectivity, gen time (+ ASCII map)
npx vite-node scripts/map-variety.ts                    # layout stats and start fairness
npx vite-node scripts/map-sheet.ts out.svg medium 4     # SVG contact sheet, one row per layout
CAVES=full npx vite-node scripts/choke-sheet.ts out.svg # SVG of each nest's tunnel mouths and staging points
npx vite-node scripts/map-mix.ts                        # nest-type mix across generated maps
npx vite-node scripts/bastion-probe.ts                  # stress test: every neutral nest is a Bastion
```

Also in `scripts/`: `matchup-probe.ts` (unit-kind rock-paper-scissors), `idle-probe.ts`, `late-start-probe.ts` and `recordings.ts`.

`scripts/proxy.ts` is a scripted stand-in for a human, built from recorded games (#29): it expands at once, moves one big blob and spends energy freely.

For sim timing without vite-node overhead:
```bash
npx esbuild scripts/bench.ts --bundle --platform=node --format=esm --outfile=$TMPDIR/bench.mjs
TERRAIN=heavy node $TMPDIR/bench.mjs 5000
```

### Recording your own games (#29)
1. Turn on Settings → Recording → "Record my games".
   - Each match is stored in the browser (IndexedDB) with its setup, command log and a client trace: camera, selections, input source, nest alerts, pauses, and per-faction stats every 5 s.
   - Skirmish setup then offers fixed **Recording session** scenarios on fixed seeds.
2. Settings → Download exports everything as one JSON file. Nothing is uploaded.
3. Analyze the export:
   ```bash
   npx vite-node scripts/replay.ts swarm-recordings-*.json         # re-run headlessly, check the final hash
   npx vite-node scripts/human-profile.ts swarm-recordings-*.json  # human vs bot tempo, expansion, attention, per scenario
   ```

Replays only reproduce on the commit that recorded them (stored as `build`); the trace and stats work on any build. Keep exports in `recordings/` (gitignored).

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
- **Layout** (skirmish setup: Open / Cave belt / Caves): caves start from solid rock and carve chambers around every nest and crystal, joined by winding tunnels with a few alternative routes. **Cave belt** rings the center with rock crossed by tunnels; **Caves** makes the whole map a cave system, with tunnels in from the map edge where wild swarms emerge. Terrain features still go on top.
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
- **Supply:** your army can't grow past 20 + 16 per nest held (8 for each nest past six) + 3 per upgrade level above 1 (the HUD shows army / cap). Production slows as you near the cap (upkeep) and stops at it, so expanding is how you grow and runaway leaders cool off; escalation removes the upkeep and raises the per-nest part late in the match.
- **Anti-snowball:** each extra nest adds less production (nests^0.9), dots near their own nests take less damage, factions that are behind charge energy faster, starting nests are defended capitals, and bots gang up on a runaway leader.
- **Selecting by type:** 1–4 keep Swarmers / Shields / Spears / Raiders from your group (or grab that type on screen), and Shift+1–4 drops a type. Double-click a unit to grab all of its type on screen. The type chips and counter wheel icons work the same way, and Tab cycles. Control groups are Ctrl+5–9 / 5–9.
- **Escalation:** from minute 5, those comeback rules fade out over 3 minutes so every match reaches an endgame.
- **Win** by eliminating every rival, or by holding 70% of the nests (60% on large maps) for 30 seconds.
- **Tutorial** (main menu → Campaign): five short missions on hand-authored maps (moving and capturing, rally points and nest types, a first fight with Surge, upgrades with Barrage and Nova, then terrain, crystals and domination), about 10 minutes in all. It ends with a 1v1 against a Normal bot, after which the menu suggests a next step. Missions live in `src/game/tutorial.ts`; `tests/tutorial.test.ts` plays each one headlessly.
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
  ai/chokes.ts  tunnel-mouth map bots read: where chambers narrow, where to stage an attack
  mapgen.ts     MapParams → MapSpec: rotationally symmetric nests + terrain from a seed; the seed also picks the shape, density, form (ring, river, spiral, regions, islands, warrens...) and fill (scattered or noise rock); the camera turns the map to fit the screen; `?maps` previews them
  terrain.ts    walls/fields as capsules + cave rock as a distance grid; tile flags, collision, line of sight, cached flow fields
  events.ts     living-map director: wild swarms, supply drops, the Colossus, garrison regrowth
  mathx.ts      table-based deterministic sin/cos
  hash.ts       state checksum
src/game/     LocalSession (fixed-timestep driver + command log), GameView (match + feedback)
src/render/   WebGL2: instanced units, beams, SDF nest shapes, terrain baked to a distance texture; particles; camera
src/input/    mouse / touch / keyboard → actions; client-only selection
src/ui/       DOM HUD, menus, settings, end screen; mobile mode (body.mobile: touch layout + wording)
src/audio/    procedural WebAudio sound effects
src/assets/   vendored font (Chakra Petch, OFL)
scripts/      headless probes and map tools (run with vite-node)
tests/        vitest suites, all headless
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

## License

[MIT](LICENSE) © 2026 Dibz15
