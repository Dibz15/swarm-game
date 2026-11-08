import { describe, expect, it } from 'vitest';
import { fetchTurn } from '../src/net/ice';
import { cleanServers, handle, TTL_SECONDS, type Env } from '../workers/turn/src/index';

const ORIGIN = 'https://dibz15.github.io';
const env = (over: Partial<Env> = {}): Env => ({ TURN_KEY_ID: 'key123', TURN_KEY_API_TOKEN: 'tok456', ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`, ...over });
const req = (path: string, o: { origin?: string | null; method?: string; ip?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
  if (o.ip) headers['CF-Connecting-IP'] = o.ip;
  return new Request(`https://turn.example.workers.dev${path}`, { method: o.method ?? 'GET', headers });
};

/** Cloudflare's answer, as its docs show it: STUN, then TURN over several transports, port 53 included */
const UPSTREAM = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'u',
      credential: 'c',
    },
  ],
};

function upstream(status = 201, body: unknown = UPSTREAM) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const limiter = (allow: boolean) => ({ limit: async () => ({ success: allow }) });

describe('TURN credentials Worker (#163)', () => {
  it('mints short-lived relay credentials for the game’s own pages', async () => {
    const { f, calls } = upstream();
    const res = await handle(req('/ice?room=abc123def4'), env(), f);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { iceServers: { urls: string[]; username?: string }[]; ttl: number };
    expect(body.ttl).toBe(TTL_SECONDS);
    // port 53 dropped: browsers block it
    expect(body.iceServers.flatMap((s) => s.urls).some((u) => u.includes(':53'))).toBe(false);
    expect(body.iceServers.find((s) => s.username)?.urls).toEqual(['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp']);
    // the secret goes to Cloudflare, never back to the browser
    expect(calls[0].url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok456');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ ttl: TTL_SECONDS });
    expect(JSON.stringify(body)).not.toContain('tok456');
  });

  it('answers only its own origins, and only GET /ice with a room id', async () => {
    const { f, calls } = upstream();
    expect((await handle(req('/ice?room=abc123def4', { origin: 'https://evil.example' }), env(), f)).status).toBe(403);
    expect((await handle(req('/ice?room=abc123def4', { origin: null }), env(), f)).status).toBe(403);
    const pre = await handle(req('/ice', { method: 'OPTIONS', origin: 'http://localhost:5173' }), env(), f);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect((await handle(req('/other?room=abc123def4'), env(), f)).status).toBe(404);
    expect((await handle(req('/ice?room=NOT_OK!'), env(), f)).status).toBe(400);
    expect((await handle(req('/ice'), env(), f)).status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it('slows down a flood, per IP and per room', async () => {
    const { f, calls } = upstream();
    const byIp = await handle(req('/ice?room=abc123def4', { ip: '1.2.3.4' }), env({ LIMIT_IP: limiter(false), LIMIT_ROOM: limiter(true) }), f);
    expect(byIp.status).toBe(429);
    expect(byIp.headers.get('Retry-After')).toBe('60');
    expect((await handle(req('/ice?room=abc123def4'), env({ LIMIT_IP: limiter(true), LIMIT_ROOM: limiter(false) }), f)).status).toBe(429);
    expect((await handle(req('/ice?room=abc123def4'), env({ LIMIT_IP: limiter(true), LIMIT_ROOM: limiter(true) }), f)).status).toBe(200);
    expect(calls.length).toBe(1);
  });

  it('says so when Cloudflare refuses, can’t be reached, or it isn’t set up', async () => {
    expect((await handle(req('/ice?room=abc123def4'), env(), upstream(401, { error: 'bad token' }).f)).status).toBe(502);
    expect((await handle(req('/ice?room=abc123def4'), env(), upstream(201, { iceServers: [{ urls: 'stun:x:3478' }] }).f)).status).toBe(502);
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await handle(req('/ice?room=abc123def4'), env(), down)).status).toBe(502);
    expect((await handle(req('/ice?room=abc123def4'), env({ TURN_KEY_ID: '' }), upstream().f)).status).toBe(503);
  });

  it('takes Cloudflare’s answer as a list or as a single server', () => {
    expect(cleanServers({ iceServers: { urls: ['turn:a:3478', 'turn:a:53'], username: 'u', credential: 'c' } })).toEqual([{ urls: ['turn:a:3478'], username: 'u', credential: 'c' }]);
    expect(cleanServers(null)).toEqual([]);
    expect(cleanServers({ iceServers: [{ urls: 'stun:a:53' }] })).toEqual([]);
  });
});

describe('the client’s side (#163)', () => {
  const ok = (async () => new Response(JSON.stringify({ iceServers: [{ urls: ['stun:s:3478'] }, { urls: ['turn:t:3478'], username: 'u', credential: 'c' }] }))) as unknown as typeof fetch;

  it('gets the relay servers, and only those', async () => {
    expect(await fetchTurn('abc123def4', { url: 'https://w.example/', fetchImpl: ok })).toEqual([{ urls: ['turn:t:3478'], username: 'u', credential: 'c' }]);
  });

  it('falls back to direct connections: no Worker, a refusal, an error, or no answer in time', async () => {
    expect(await fetchTurn('abc123def4', { url: '', fetchImpl: ok })).toBeNull();
    const refused = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    expect(await fetchTurn('abc123def4', { url: 'https://w.example', fetchImpl: refused })).toBeNull();
    const broken = (async () => new Response('not json')) as unknown as typeof fetch;
    expect(await fetchTurn('abc123def4', { url: 'https://w.example', fetchImpl: broken })).toBeNull();
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await fetchTurn('abc123def4', { url: 'https://w.example', fetchImpl: hang, timeoutMs: 50 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
