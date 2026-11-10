import type { LobbyState } from './lobby';
import { seal } from './seal';
import type { MatchResume } from './match';

/**
 * A multiplayer match saved when this player lost touch with everyone
 * (#191): the room to open again, our seat token to get our seat back by,
 * the room as we last saw it (every row's seal), and the match itself.
 * Kept in this browser only (IndexedDB, `recordStore.ts`).
 */
export interface MatchSave extends MatchResume {
  /** the room's id and secret: its link */
  room: string;
  secret: string;
  /** when it was saved (Date.now) */
  savedAt: number;
  /** our seat token in that room */
  token: string;
  lobby: LobbyState;
}

/** How many saved matches a browser keeps (#191): the oldest goes first. */
export const MAX_SAVED_MATCHES = 4;

/**
 * Adding `next` to the saves we have: the rooms to drop so at most
 * MAX_SAVED_MATCHES remain, oldest first. A room saved again replaces its
 * old save and drops nothing else for it.
 */
export function keepNewest(have: readonly Pick<MatchSave, 'room' | 'savedAt'>[], next: Pick<MatchSave, 'room' | 'savedAt'>, max = MAX_SAVED_MATCHES): { drop: string[] } {
  const others = have.filter((m) => m.room !== next.room).sort((a, b) => b.savedAt - a.savedAt);
  return { drop: others.slice(Math.max(0, max - 1)).map((m) => m.room) };
}

/**
 * A save we can pick up (#191): mid-match, and one of its seats was sealed
 * with our token, so the room run from it knows us. A save made where
 * storage failed (a token that never matched) can't be.
 */
export function canResume(save: Pick<MatchSave, 'token' | 'lobby' | 'seat'>, roomKey: string): boolean {
  const s = seal(save.token, roomKey);
  const row = save.lobby.rows[save.seat];
  return save.lobby.phase === 'playing' && !!s && row?.k === 'human' && row.seal === s;
}
