import { Bot, type BotConfig } from './ai/bot';
import type { World } from './world';

/**
 * Seat control (#156): hand a human seat to a bot and back, mid-match.
 *
 * A dropped player's faction idles, then an Easy bot takes over; the player
 * can reclaim the seat. The faction stays `human` throughout, so stronghold
 * and heart win rules still count it as a player's faction.
 *
 * Both functions change sim state outside `step()`, so every peer must call
 * them between steps, at the same tick boundary (after step T, before step
 * T + 1), or the worlds diverge. Feeding them from logged control entries in
 * the turn stream comes in later issues.
 */

/** The bot's seed: a function of (match seed, tick). The Bot mixes in its faction itself. */
export function seatBotSeed(w: World): number {
  return (w.seed ^ Math.imul(w.tick + 1, 0x85ebca6b)) >>> 0;
}

/**
 * A bot starts driving faction `f` from the next step. `w.bots` stays sorted
 * by faction, since bots act in that order inside `step()`. The faction's
 * `prodMult` is left alone: a seat's bot gets no production bonus.
 * Any bot already driving `f` is replaced. Only a human seat can switch.
 */
export function seatToBot(w: World, f: number, cfg: BotConfig): Bot {
  seatToHuman(w, f);
  const bot = new Bot(f, cfg, seatBotSeed(w));
  let i = 0;
  while (i < w.bots.length && w.bots[i].faction < f) i++;
  w.bots.splice(i, 0, bot);
  return bot;
}

/** Faction `f`'s bot, if any, stops: the seat takes commands from its player again. */
export function seatToHuman(w: World, f: number): void {
  if (!w.factions[f]?.human) throw new Error(`seats: faction ${f} is not a human seat`);
  const i = w.bots.findIndex((b) => b.faction === f);
  if (i >= 0) w.bots.splice(i, 1);
}

/** Whether a bot drives faction `f`. */
export function seatHasBot(w: World, f: number): boolean {
  return w.bots.some((b) => b.faction === f);
}

/**
 * Apply a seat control entry (#164): a bot takes the seat, or the player has
 * it again. Shared by networked sessions and by replays of their logs, so
 * both reproduce the same seat changes at the same ticks. (The entry's type
 * is spelled out here so the sim doesn't depend on the net code.)
 */
export function applySeatCtrl(w: World, c: { seat: number; state: 'human' | 'away' | 'bot'; bot?: Pick<BotConfig, 'difficulty' | 'personality'> }): void {
  if (c.state === 'bot') seatToBot(w, c.seat, { difficulty: c.bot?.difficulty ?? 0, personality: c.bot?.personality ?? 'expander' });
  else if (seatHasBot(w, c.seat)) seatToHuman(w, c.seat);
}
