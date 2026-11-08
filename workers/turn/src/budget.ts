/**
 * The relay's monthly budget (#163). Cloudflare TURN bills what it sends
 * down to relayed players, past a free 1,000 GB a month, and offers no
 * spending cap. Credentials minted here can be used by anyone holding them,
 * for anything, so the Worker stops minting new ones once the account's TURN
 * egress this month passes `BUDGET_GB`: players then fall back to direct
 * connections only. Credentials already handed out keep working until they
 * expire (TTL_SECONDS), so leave a margin below the free tier.
 *
 * Usage comes from Cloudflare's GraphQL analytics (TURN shows up there within
 * about 30 s). It's asked at most every CHECK_MS per Worker instance, only
 * when someone wants credentials, so it needs no cron and no storage.
 */

export interface BudgetEnv {
  /** GB of TURN egress a month (calendar month, UTC) before minting stops; "off" disables the guard */
  BUDGET_GB?: string;
  /** the Cloudflare account that owns the TURN key */
  CF_ACCOUNT_ID?: string;
  /** an API token with the "Account Analytics" read permission (a Worker secret) */
  CF_ANALYTICS_TOKEN?: string;
}

export type BudgetVerdict =
  | { ok: true; usedGB: number | null }
  /** over budget, or it can't tell (not configured, analytics down with nothing recent known) */
  | { ok: false; reason: 'over' | 'unknown' | 'not configured'; usedGB: number | null };

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
/** ask the analytics again after this long */
export const CHECK_MS = 5 * 60_000;
/** when the analytics can't be reached, trust the last answer for this long */
export const STALE_MS = 60 * 60_000;
const QUERY_TIMEOUT_MS = 1500;
const GB = 1e9;
const ACCOUNT = /^[0-9a-f]{32}$/;

/** The first day of `now`'s month and `now`'s day, UTC, as YYYY-MM-DD. */
export function monthRange(now: number): { from: string; to: string } {
  const d = new Date(now);
  const to = d.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}

/** This month's TURN egress for the whole account, in bytes; throws when it can't tell. */
export async function monthEgress(account: string, token: string, now: number, fetchImpl: typeof fetch): Promise<number> {
  const { from, to } = monthRange(now);
  // values inlined (account id checked as hex, dates built here): no variable types to get wrong
  const query = `query { viewer { accounts(filter: { accountTag: "${account}" }) { callsTurnUsageAdaptiveGroups(filter: { date_geq: "${from}", date_leq: "${to}" }, limit: 1) { sum { egressBytes } } } } }`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUERY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`analytics: HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { viewer?: { accounts?: { callsTurnUsageAdaptiveGroups?: { sum?: { egressBytes?: number } }[] }[] } };
      errors?: unknown[] | null;
    };
    if (body.errors?.length) throw new Error('analytics: query refused');
    const accounts = body.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error('analytics: no such account');
    const groups = accounts[0].callsTurnUsageAdaptiveGroups;
    if (!Array.isArray(groups)) throw new Error('analytics: no TURN usage');
    // no traffic yet this month: no groups at all
    let bytes = 0;
    for (const g of groups) {
      const b = g.sum?.egressBytes;
      if (typeof b !== 'number' || !(b >= 0)) throw new Error('analytics: bad egressBytes');
      bytes += b;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

/** One per Worker instance: it remembers the last answer so most requests skip the analytics call. */
export class Budget {
  private last: { bytes: number; at: number; month: string } | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly clock: () => number = Date.now) {}

  async check(env: BudgetEnv, fetchImpl: typeof fetch): Promise<BudgetVerdict> {
    const raw = (env.BUDGET_GB ?? '').trim().toLowerCase();
    if (raw === 'off') return { ok: true, usedGB: null };
    const limit = Number(raw);
    // a guard that's missing or mistyped mustn't silently become no guard
    if (!raw || !(limit > 0) || !env.CF_ACCOUNT_ID || !ACCOUNT.test(env.CF_ACCOUNT_ID) || !env.CF_ANALYTICS_TOKEN) return { ok: false, reason: 'not configured', usedGB: null };

    const now = this.clock();
    const month = monthRange(now).from;
    // a new month starts from nothing, whatever the last one used
    if (this.last && this.last.month !== month) this.last = null;
    if (!this.last || now - this.last.at >= CHECK_MS) {
      this.inflight ??= monthEgress(env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN, now, fetchImpl)
        .then((bytes) => {
          this.last = { bytes, at: now, month };
        })
        .catch(() => {
          /* keep the last answer while it's fresh enough */
        })
        .finally(() => {
          this.inflight = null;
        });
      await this.inflight;
    }
    const last = this.last;
    if (!last || this.clock() - last.at > STALE_MS) return { ok: false, reason: 'unknown', usedGB: null };
    const usedGB = last.bytes / GB;
    return usedGB >= limit ? { ok: false, reason: 'over', usedGB } : { ok: true, usedGB };
  }
}
