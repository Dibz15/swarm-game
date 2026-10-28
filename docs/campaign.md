# Procedural campaign: design

Status: design agreed, not built yet. Tracking issue: #18 (part of #16). The build phases are listed at the end, one issue and PR each.

## The pitch
Each run is a new map of territories that a living blight, **the Bloom**, is steadily consuming. You fight your way across it with a few persistent **broods**, past rival **warlords** who hold their own domains, toward the **Bloom's heart**. You can't fight everywhere. Every territory you skip is eaten, and everything the Bloom eats makes the final battle harder.

Inspiration: *Bad North*. Its runs are about 2–3 hours of 2–3 minute island fights; the map closes behind you, there are checkpoint islands, gold from saved houses buys upgrades, and commanders are found and lost. Slay the Spire and FTL inspired the reward picks and route choices. SWARM's own additions:
- **The Bloom:** a PvE blight that consumes the map and hurts everyone.
- **Warlord domains:** you route through them or around them.
- **Broods as strains:** their upgrades change every unit of that kind in a battle.
- **Mixed battle types.**

**Target length:** 8–10 battles of 4–7 minutes each, about 45–60 minutes, with a mid-run checkpoint and save/resume.

## Run map
One seed generates everything: map, battles and reward offers. The run is deterministic and shareable.

- **Organic layout:**
  - About 18–24 territory nodes scattered with Poisson-disk sampling over a wide, irregular region.
  - Each node links to its natural neighbours (a relative-neighbourhood graph), so routes branch and rejoin, and you can move sideways as well as forward. It is not a grid.
  - You start near one edge; the Bloom's heart (★) lies across the map.
- **A turn:**
  1. Move to an adjacent node and fight its battle.
  2. The Bloom advances.
- **The Bloom follows you** (#88):
  - It waits in a band off the edge behind your start. Every node you leave starts it growing there, a turn later and a set distance each turn. So it spreads from where you came, whichever direction you went: an up-or-down route is as safe as one heading straight for the heart.
  - It's one body, not a cluster of circles: its parts fuse together, and its whole edge swells toward your trail, less the further away it is.
  - It swallows every node it reaches, so in time it eats the nodes you skipped.
  - Winning keeps you ahead. A lost battle leaves you in place while it closes in.
  - The map shows a dashed outline of where it will reach next turn.
  - Swallowed nodes become Bloom territory and add to its strength.
  - Its speed is set per run: the fastest Bloom the shortest route survives when every hop takes 1 / pace turns, so the easier the run, the more room for lost battles.
- **Checkpoint:** one node per run. If you lose everything after reaching it, you restart from it once.
- **Node previews** show a few icons and one line, not a stats dump:
  - battle type;
  - the enemy (warlord colour and trait, or plain rivals);
  - Bloom pressure;
  - the map (size, caves or open);
  - the reward (biomass, a brood to rescue, a perk).

## Two systems: the Bloom and the warlords
They are deliberately separate, and each has one job.

| | The Bloom | Warlords |
|---|---|---|
| **Pressure** | Time: a clock that pushes you forward | Space: obstacles that shape your route |
| **Who it hurts** | Everyone, PvE: you and the warlords | You |
| **Where it shows** | Bloom pressure in battles near the front, and the finale | Their domain battles along the way |
| **Rule** | What you skip, it eats, and that's what makes the finale harder | Harder battles, richer rewards; fight through, go around, or let the Bloom take them |

**The Bloom in battle.** It reuses the wild-swarm faction (`src/sim/events.ts`). Nodes near the front get Bloom pressure: more and bigger wild swarms, scaled by the Bloom's strength, attacking every faction alike.

**Warlords.**
- **Who:** 2–4 named rival colours per run, each with one **trait**: a small, clear buff such as *Ironhide* (Shields +50% HP), *Swarmlord* (faster spawning, no powers) or *Raider-king* (Raiders capture even faster). Traits are the first slice of the champion modifiers planned for later.
- **Domain:** each warlord holds a cluster of 2–4 nodes around a **stronghold**. Domain battles have that warlord as the main rival, with its trait. They are harder, and they pay more: bigger biomass, rarer reward offers, rescuable broods.
- **Taking the stronghold** breaks the domain: its other nodes become ordinary, and you earn a big reward.
- **The Bloom erodes domains:** each swallowed domain node weakens the warlord, and if the stronghold is swallowed, the warlord is gone. "Let the Bloom deal with that warlord" is a real choice, at the price of a stronger finale.
- **Warlords don't move.** There is no map AI.

## Battles
Each node turns into a `MatchSetup` (`src/sim/setup.ts`) plus an objective. Objectives are checked inside the sim, so battles stay deterministic and testable headless.

- **Conquest:** eliminate the rivals, or hold 80% of the nests for 30 seconds, so two turtling rivals can't stall it.
- **Domination:** hold the share of nests (`domShare`) for the countdown. Shorter and racier.
- **Hold the line (new):**
  - You start dug in on a sector of a few nests.
  - Waves (Bloom swarms plus a rival's pushes, through the events director) come for N minutes.
  - You win if you still hold your capital when the timer runs out.
- **Difficulty** rises with the distance travelled: bot difficulty, rival count, production (`PlayerSetup.prod`) and Bloom pressure.
- **Later:** team battles (2v2 with an ally) and champion modifiers on any rival.

## Broods
Persistent named squads, each of one unit kind: Swarmers, Shields, Spears or Raiders.
- **Choose before a battle:** you pick up to 3 broods to field. They become your starting army, which replaces `START_UNITS` with a per-player starting army in `MatchSetup`.
- **A brood is a strain:** its mutations apply to every unit of its kind you spawn that battle, not just the starting dots.
  - A match spawns hundreds of units from nests, so upgrades that only touched the opening army would fade within a minute or two.
  - Strains also tie into routing: Spears need a Spire on the map, and previews show each map's nest mix.
- **Size from survivors:** after a battle, a brood's size is set by how many of its dots survived, up to a cap. Veterancy rises with wins.
- **Losing a battle** wounds the fielded broods (they sit out one battle). A brood that ends a battle with almost no survivors dies.
- **New broods** come from rescue rewards, often in warlord domains.
- **The run ends** when you have no broods left to field, unless the checkpoint saves you.

## Biomass and the camp
Biomass is earned per battle: nests held at the end, survivors, and speed. You spend it at a short camp screen between turns:
- heal a wounded brood;
- grow a brood's size cap;
- unlock a nest type or a power for the run (you start with Hive, plus Surge);
- reroll a reward offer.

## Rewards
After every won node, **pick 1 of 3** offers.
- **Rarity tiers:** common, uncommon and rare.
- **Where rares come from:** warlord domains and strongholds weight the offers toward rare.

**The full pool is 43 items. v1 ships the 25 numeric ones. The other 18 need new sim behaviour and are left for later.** Both lists live here so nothing is lost.

| Family | **v1 (25)** | **Later (18)**, needs new behaviour |
|---|---|---|
| **Swarmer strain** | *Frenzy* (bigger pack bonus); *Lean* (+speed, −HP); *Thick hide* (+25% HP, −speed) | *Swarm-call* (a dying Swarmer briefly boosts its neighbours) |
| **Shield strain** | *Plated* (+HP); *Bulwark* (draws fire from further away) | *Spikes* (reflect some damage); *Phalanx* (tougher next to other Shields) |
| **Spear strain** | *Barbed* (wider splash); *Longshot* (+range, −dps); *Quickdraw* (faster shots) | *Piercing* (shots pass through a line) |
| **Raider strain** | *Saboteur* (even faster capture); *Fleet* (+speed) | *Skirmish* (retreat when hurt); *Arsonist* (contested nests lose control faster) |
| **Power variants** (one per power at a time) | Barrage *Heavy shell* (bigger damage budget); Nova *Wide* (wider, weaker); Surge *Overdrive* (longer, cheaper); Blink *Long jump* (+range); Fortify *Root* (can't move, much tougher); Lockdown *Long* (longer duration) | Barrage *Cluster* (three small blasts) and *Scorch* (lingering burn); Nova *Implode* (pulls in); Surge *Mend* (heals instead of speed); Blink *Echo* (leaves a decoy); Fortify *Thorns*; Lockdown *Siphon* (drains energy) |
| **Nest and economy perks** | capitals start at level 2; Bastion turret +range; +1 supply per nest; crystals charge 25% faster; +15% energy income; faster capture at every nest | supply drops favour you; level-2 nests spawn veterans |
| **Pacts** (strong, with a drawback) | *Glass swarm* (+30% damage, −20% HP); *Hunger* (double biomass, but the Bloom advances faster); *Lone wolf* (field 1 brood only, but it's huge) | *Blood price* (powers cost units instead of energy); *Scorched earth* (captured nests start half-controlled, you spawn 20% faster); *Feral* (no powers, +25% production) |

- **Builds emerge:** a Spear strain plus Heavy-shell Barrage plays very differently from Lean Swarmers plus Overdrive Surge. With 25 items and 3 offers per pick, a run of 8–10 picks sees most of the v1 pool. The later items are what keep runs varied over many plays.
- **Rarity comes from measurements, not guesses.**
  - A headless reward-impact probe plays the same seeded battles with and without each item, the same A/B method as `scripts/choke-probe.ts`, and reports the win-rate and margin change per item.
  - The most impactful items become rare; the weakest get buffed or made common. Pacts are judged on net impact after their drawback.
  - Until the probe exists, v1 ships provisional tiers, marked as such in the code.
- **In the sim:** a deterministic per-faction modifier table (`FactionMods` in `world.ts`), read where stats are used (`combat.ts`, `movement.ts`, `nests.ts`, and the power code in `commands.ts` and `step.ts`). The v1 items are all numeric multipliers. Champion modifiers on enemies will reuse the same table.

## Finale: the Bloom's heart
- **Map:** a large map overrun by the Bloom: wild-swarm nests, constant swarms, and a Colossus-class heart to destroy.
- **Strength:** scales with the number of nodes the Bloom ate.
- **Warlords:** any still alive whose domain borders the heart join as rivals. They suffer the Bloom too.

## Sound and music
Every new sound is procedural WebAudio in `src/audio/engine.ts`, on the score's scale so nothing clashes, and gathered into one named catalog so each can be tuned by hand. Each build phase adds the sounds for what it ships.

| Where | Sounds |
|---|---|
| **Run map** | node hover and select; the move along a path; the **Bloom advancing** (a low swell at the end of each turn); a **node swallowed** (a wet crunch); entering a **warlord domain** (that warlord's sting); checkpoint reached |
| **Rewards and camp** | cards revealed; a pick, with chimes by rarity; reroll; biomass spent; brood healed; brood grown; pact taken (a darker tone) |
| **Broods** | brood wounded; **brood lost** (a toll); brood rescued (a fanfare) |
| **Battles** | warlord trait announced at the start; Bloom swarm arrival (a variant of the wild-swarm cue); **Hold the line**: wave horn, final-10-second ticks, line held; the **Bloom's heart** pulse and its death |
| **Run results** | run won; run lost; checkpoint restart |
| **Hub** | resume, new run, delete (with a weightier confirm) |

- **Run-map music:** a calmer variant of the score that darkens as the Bloom gets closer. It uses the music themes from #57 if they exist by then.
- **Finale:** gets its own theme.

## Saves and the hub
- **Storage:** run state lives in localStorage and is saved after every step.
- **Several active runs at once:**
  - The hub lists them with seed, depth, broods, last played, and a small map thumbnail.
  - You can **load** (resume), **delete** (with a confirm) or **start a new one**.
- **History:** past runs (won or lost) are listed with their seeds, plus a seed field to replay a run.
- **Robustness:** each run lives under its own versioned storage key, so one bad save can't break the others.

## Testing
- **Run probe:** plays whole runs headlessly, with a bot in the human seat and a simple routing policy. It checks:
  - the difficulty curve and run length;
  - how often runs die;
  - how often warlords get fought, avoided, or eaten by the Bloom;
  - whether any reward is a must-pick.
- **Reward-impact probe:** an A/B for each item, which sets the rarity tiers.
- **Beatable tests:** every battle type gets one, the same pattern as `tests/tutorial.test.ts`.
- **Map tests:** every generated run map is connected, and the heart is reachable before the Bloom closes the route.

## Build phases
Each phase ships something playable and includes its own sounds.

1. **Run skeleton:**
   - run-map generation (`src/campaign/run.ts`, pure and seeded) and the run-map screen;
   - the Bloom front advancing and swallowing nodes;
   - Conquest and Domination nodes scaled by distance;
   - a plain finale battle, with a fixed starting army;
   - save/load/delete for multiple active runs, with the hub in the Campaign menu.
2. **Broods and biomass:**
   - per-player starting army;
   - brood choice before a battle;
   - survivors become size, plus wounds and death;
   - the camp screen;
   - the checkpoint, and the run ending when no broods are left.
3. **Rewards:**
   - the `FactionMods` table;
   - the pick-1-of-3 screen with rarity;
   - the v1 pool of 25 items, with provisional tiers.
4. **The Bloom as PvE:**
   - Bloom pressure via wild swarms;
   - Bloom strength from swallowed nodes;
   - the Bloom's-heart finale.
5. **Warlords:**
   - domains and strongholds;
   - traits;
   - domain battles and rewards;
   - breaking a domain;
   - the Bloom eroding domains;
   - previews.
6. **Hold the line:**
   - the sim objective and timer;
   - waves;
   - a HUD countdown;
   - a beatable test.
7. **Balance:**
   - the run probe;
   - the reward-impact probe, which sets the rarity tiers;
   - tuning the curve, rewards and run length.

**Later:**
- the other 18 rewards;
- champion modifiers on any rival;
- team battles;
- warlord memory (nemesis);
- meta progression between runs.
