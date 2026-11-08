/**
 * SWARM's TURN credentials Worker (#163).
 *
 * Some pairs of players can't reach each other directly (strict NATs,
 * mobile carrier CGNAT); a TURN relay carries their traffic instead, still
 * end-to-end encrypted. This Worker only hands out short-lived credentials
 * for Cloudflare's TURN service:
 *   GET /ice?room=<room id>  →  { iceServers: RTCIceServer[] }
 *
 * - The TURN key's id and API token are Worker secrets, never in the repo
 *   or the client.
 * - Only the game's own origins may call it (CORS), and calls are
 *   rate-limited per IP and per room.
 * - It logs nothing of its own.
 *
 * It is the seed of the relay sequencer later (#167).
 */

interface RateLimit {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  TURN_KEY_ID: string;
  TURN_KEY_API_TOKEN: string;
  /** comma-separated origins allowed to ask */
  ALLOWED_ORIGINS?: string;
  LIMIT_IP?: RateLimit;
  LIMIT_ROOM?: RateLimit;
}

/** Credentials outlive any match (Cloudflare allows up to 48 h). */
export const TTL_SECONDS = 4 * 60 * 60;
const ROOM = /^[a-z0-9]{6,32}$/;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function cors(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

/**
 * Cloudflare's answer, as servers a browser takes: one list of servers,
 * without the port-53 URLs (browsers block that port and log errors).
 */
export function cleanServers(body: unknown): IceServer[] {
  const raw = (body as { iceServers?: IceServer | IceServer[] })?.iceServers;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: IceServer[] = [];
  for (const s of list) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u));
    if (urls.length) out.push({ urls, ...(s.username ? { username: s.username, credential: s.credential } : {}) });
  }
  return out;
}

export async function handle(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return json({ error: 'origin not allowed' }, 403);
  const h = cors(origin);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (req.method !== 'GET' || url.pathname !== '/ice') return json({ error: 'not found' }, 404, h);

  const room = url.searchParams.get('room') ?? '';
  if (!ROOM.test(room)) return json({ error: 'bad room' }, 400, h);
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const [byIp, byRoom] = await Promise.all([env.LIMIT_IP?.limit({ key: ip }), env.LIMIT_ROOM?.limit({ key: room })]);
  if (byIp?.success === false || byRoom?.success === false) return json({ error: 'slow down' }, 429, { ...h, 'Retry-After': '60' });

  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ error: 'not configured' }, 503, h);
  let res: Response;
  try {
    res = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    });
  } catch {
    return json({ error: 'upstream unreachable' }, 502, h);
  }
  if (!res.ok) return json({ error: 'upstream refused' }, 502, h);
  const iceServers = cleanServers(await res.json().catch(() => null));
  if (!iceServers.some((s) => s.username)) return json({ error: 'upstream gave no relay' }, 502, h);
  return json({ iceServers, ttl: TTL_SECONDS }, 200, h);
}

export default {
  fetch: (req: Request, env: Env): Promise<Response> => handle(req, env),
};
