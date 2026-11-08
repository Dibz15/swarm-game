import { describe, expect, it } from 'vitest';
import { fetchTurn } from '../src/net/ice';
import { Budget, CHECK_MS, GRAPHQL_URL, monthRange, STALE_MS } from '../workers/turn/src/budget';
import { cleanServers, handle as handleWith, TTL_SECONDS, type Env } from '../workers/turn/src/index';

const ORIGIN = 'https://fourthcontact.github.io';
const ACCOUNT = 'a'.repeat(32);
const env = (over: Partial<Env> = {}): Env => ({
  TURN_KEY_ID: 'key123',
  TURN_KEY_API_TOKEN: 'tok456',
  ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
  BUDGET_GB: '800',
  CF_ACCOUNT_ID: ACCOUNT,
  CF_ANALYTICS_TOKEN: 'ana789',
  ...over,
});
/** each call with a fresh budget, so nothing is remembered between tests */
const handle = (r: Request, e: Env, f: typeof fetch) => handleWith(r, e, f, new Budget());
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

/** the analytics' answer: this month's egress, as Cloudflare groups it */
const usage = (...bytes: number[]) => ({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: bytes.map((b) => ({ sum: { egressBytes: b } })) }] } }, errors: null });

/** Cloudflare: the TURN API (`calls`), and the analytics (`asked`), 10 GB used unless told otherwise */
function upstream(status = 201, body: unknown = UPSTREAM, analytics: () => Response | Promise<Response> = () => new Response(JSON.stringify(usage(10e9)))) {
  const calls: { url: string; init: RequestInit }[] = [];
  const asked: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    if (url === GRAPHQL_URL) {
      asked.push({ url, init });
      return analytics();
    }
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls, asked };
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
    // (the budget guard is off here: it would refuse first, analytics unreachable too)
    expect((await handle(req('/ice?room=abc123def4'), env({ BUDGET_GB: 'off' }), down)).status).toBe(502);
    expect((await handle(req('/ice?room=abc123def4'), env({ TURN_KEY_ID: '' }), upstream().f)).status).toBe(503);
  });

  it('takes Cloudflare’s answer as a list or as a single server', () => {
    expect(cleanServers({ iceServers: { urls: ['turn:a:3478', 'turn:a:53'], username: 'u', credential: 'c' } })).toEqual([{ urls: ['turn:a:3478'], username: 'u', credential: 'c' }]);
    expect(cleanServers(null)).toEqual([]);
    expect(cleanServers({ iceServers: [{ urls: 'stun:a:53' }] })).toEqual([]);
  });
});

describe('the relay budget (#163)', () => {
  const at = (iso: string) => Date.parse(iso);

  it('counts the whole account’s TURN egress since the 1st of the month, UTC', async () => {
    expect(monthRange(at('2026-11-08T23:59:00Z'))).toEqual({ from: '2026-11-01', to: '2026-11-08' });
    expect(monthRange(at('2026-12-01T00:00:01Z'))).toEqual({ from: '2026-12-01', to: '2026-12-01' });
    const { f, asked } = upstream(201, UPSTREAM, () => new Response(JSON.stringify(usage(300e9, 450e9))));
    const v = await new Budget(() => at('2026-11-08T12:00:00Z')).check(env(), f);
    expect(v).toEqual({ ok: true, usedGB: 750 });
    const init = asked[0].init;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ana789');
    const q = JSON.parse(init.body as string).query as string;
    expect(q).toContain(`accountTag: "${ACCOUNT}"`);
    expect(q).toContain('callsTurnUsageAdaptiveGroups(filter: { date_geq: "2026-11-01", date_leq: "2026-11-08" }');
    expect(q).toContain('egressBytes');
  });

  it('stops minting once the month passes the budget, and says when to come back', async () => {
    const { f, calls } = upstream(201, UPSTREAM, () => new Response(JSON.stringify(usage(801e9))));
    const res = await handle(req('/ice?room=abc123def4'), env(), f);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(((await res.json()) as { error: string }).error).toMatch(/budget/);
    expect(calls.length).toBe(0);
    // an empty month (no groups yet) is zero, and fine
    const empty = upstream(201, UPSTREAM, () => new Response(JSON.stringify(usage())));
    expect((await handle(req('/ice?room=abc123def4'), env(), empty.f)).status).toBe(200);
  });

  it('a missing or mistyped guard refuses, rather than quietly guarding nothing; "off" turns it off', async () => {
    for (const over of [{ BUDGET_GB: undefined }, { BUDGET_GB: 'lots' }, { BUDGET_GB: '0' }, { CF_ACCOUNT_ID: '' }, { CF_ACCOUNT_ID: 'not-an-id' }, { CF_ANALYTICS_TOKEN: '' }]) {
      const { f, calls, asked } = upstream();
      expect((await handle(req('/ice?room=abc123def4'), env(over), f)).status).toBe(503);
      expect(calls.length + asked.length).toBe(0);
    }
    const { f, asked } = upstream();
    expect((await handle(req('/ice?room=abc123def4'), env({ BUDGET_GB: 'off', CF_ACCOUNT_ID: undefined, CF_ANALYTICS_TOKEN: undefined }), f)).status).toBe(200);
    expect(asked.length).toBe(0);
  });

  it('asks the analytics at most every few minutes, and again in a new month', async () => {
    let now = at('2026-11-30T23:50:00Z');
    let used = 100e9;
    const { f, asked } = upstream(201, UPSTREAM, () => new Response(JSON.stringify(usage(used))));
    const b = new Budget(() => now);
    await b.check(env(), f);
    used = 900e9;
    now += CHECK_MS - 1;
    expect(await b.check(env(), f)).toEqual({ ok: true, usedGB: 100 });
    expect(asked.length).toBe(1);
    now += 1;
    expect((await b.check(env(), f)).ok).toBe(false);
    expect(asked.length).toBe(2);
    // December: November's 900 GB doesn't count, even before the cache would expire
    used = 0;
    now = at('2026-12-01T00:00:30Z');
    expect(await b.check(env(), f)).toEqual({ ok: true, usedGB: 0 });
    // many requests at once share one analytics call
    now += CHECK_MS;
    await Promise.all([b.check(env(), f), b.check(env(), f), b.check(env(), f)]);
    expect(asked.length).toBe(4);
  });

  it('when the analytics fail, trusts a recent answer for a while, then refuses', async () => {
    let now = at('2026-11-08T12:00:00Z');
    let fail: 'http' | 'errors' | 'throw' | null = null;
    const analytics = (): Response | Promise<Response> => {
      if (fail === 'http') return new Response('{}', { status: 500 });
      if (fail === 'errors') return new Response(JSON.stringify({ data: null, errors: [{ message: 'not authorized' }] }));
      if (fail === 'throw') throw new Error('offline');
      return new Response(JSON.stringify(usage(50e9)));
    };
    const { f } = upstream(201, UPSTREAM, analytics);
    const b = new Budget(() => now);
    expect((await b.check(env(), f)).ok).toBe(true);
    for (const how of ['http', 'errors', 'throw'] as const) {
      fail = how;
      now += CHECK_MS;
      expect(await b.check(env(), f)).toEqual({ ok: true, usedGB: 50 });
    }
    now = at('2026-11-08T12:00:00Z') + STALE_MS + 1;
    expect(await b.check(env(), f)).toEqual({ ok: false, reason: 'unknown', usedGB: null });
    // never heard from at all: refuse
    expect((await new Budget(() => now).check(env(), f)).ok).toBe(false);
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
