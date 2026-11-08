/**
 * TURN relay credentials (#163). Some pairs of players can't connect
 * directly (strict NATs, mobile carrier CGNAT); a TURN relay carries their
 * traffic, still end-to-end encrypted. Our tiny Cloudflare Worker
 * (workers/turn) mints short-lived credentials; without it, or if it can't
 * be reached, play falls back to direct connections only (STUN).
 *
 * "Relay only" sends everything through the relay, so other players never
 * see your IP address.
 */

/** The Worker's URL, set at build time (`VITE_TURN_URL`); empty: no relay. */
export const TURN_URL: string = (import.meta.env.VITE_TURN_URL as string | undefined) ?? '';

export interface TurnServer {
  urls: string | string[];
  username: string;
  credential: string;
}

/**
 * The relay servers for a room, or null (no Worker configured, it timed out,
 * or it refused). Never throws.
 */
export async function fetchTurn(room: string, o: { url?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<TurnServer[] | null> {
  const base = o.url ?? TURN_URL;
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 3000);
  try {
    const res = await (o.fetchImpl ?? fetch)(`${base.replace(/\/$/, '')}/ice?room=${encodeURIComponent(room)}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { iceServers?: { urls: string | string[]; username?: string; credential?: string }[] };
    const turn = (body.iceServers ?? []).filter((s): s is TurnServer => typeof s.username === 'string' && typeof s.credential === 'string' && !!s.urls);
    return turn.length ? turn : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const KEY = 'swarm.relayOnly';

/** "Hide my IP": connect only through the relay. */
export function relayOnly(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setRelayOnly(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
