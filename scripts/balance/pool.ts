// A pool of battle workers for the balance harness (#68). The worker is
// bundled with esbuild, so probes can keep running under vite-node while their
// battles run in plain Node threads. Results are cached on disk (cache.ts).
//   WORKERS=8      threads (default 8, the sweep budget's core count)
//   BUDGET_MIN=60  wall-clock minutes before the pool stops; finished battles stay cached
//   EARLY=1        end battles on the early-decision rule, where early-check.ts passed it
//   EARLY_SHARE=0.85 EARLY_SECS=60   that rule (each rule has its own verdict)
//   NOCACHE=1      play everything again (results are still written)
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DEFAULT_RULE, EARLY_CLASSES, classOf, type BattleClass, type Job, type PoolJob, type Result, type Rule } from './battle';
import { CACHE_DIR, Cache, fingerprint, sha } from './cache';

/** How a rule did on a set of played-out battles. */
export interface Tally {
  battles: number;
  /** battles the rule called before the end, and how many of those calls were right */
  called: number;
  agreed: number;
  /** ticks played, and ticks the right calls would have cut */
  ticks: number;
  saved: number;
}
/** early-check.ts's verdict on one rule, stored beside the results it was measured on */
export interface EarlyVerdict {
  rule: Rule;
  byClass: Partial<Record<BattleClass, Tally>>;
}
export const earlyFile = (r: Rule) => `early-${r.share}-${r.secs}.json`;
/** A rule is used for a class only at this agreement or better... */
export const EARLY_AGREE = 0.97;
/** ...over at least this many battles of the eligible classes together... */
export const EARLY_MIN = 200;
/** ...and with at least this many calls in that class, so the agreement means something. */
export const EARLY_MIN_CALLS = 30;

export const ruleFromEnv = (): Rule => ({ share: Number(process.env.EARLY_SHARE ?? DEFAULT_RULE.share), secs: Number(process.env.EARLY_SECS ?? DEFAULT_RULE.secs) });

export type { PoolJob } from './battle';

export class BudgetError extends Error {
  constructor(minutes: number) {
    super(`balance pool: budget of ${minutes} min spent; finished battles are cached, so re-running picks up from here`);
  }
}

export interface PoolOptions {
  workers?: number;
  budgetMin?: number;
  /** ask for early decisions (still only where the check passed) */
  early?: boolean;
  cache?: boolean;
}

interface Pending {
  job: Job;
  key: string;
  resolve: (r: Result) => void;
  reject: (e: Error) => void;
}

export class Pool {
  readonly stats = { played: 0, cached: 0, decided: 0, cpuMs: 0 };
  /** classes the early rule is used for (empty: off) */
  readonly early: ReadonlySet<BattleClass>;
  readonly rule: Rule = ruleFromEnv();
  private readonly idle: Worker[] = [];
  private readonly all: Worker[] = [];
  private readonly queue: Pending[] = [];
  private readonly busy = new Map<Worker, Pending & { t: number }>();
  private readonly t0 = performance.now();
  private readonly timer: NodeJS.Timeout;
  private failed: Error | null = null;

  private constructor(
    private readonly file: string,
    readonly cache: Cache,
    private readonly size: number,
    readonly budgetMin: number,
    early: Set<BattleClass>,
    private readonly useCache: boolean,
  ) {
    this.early = early;
    this.timer = setTimeout(() => this.abort(new BudgetError(budgetMin)), budgetMin * 60_000);
    this.timer.unref();
  }

  static async open(opts: PoolOptions = {}): Promise<Pool> {
    const out = await build({
      entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      logLevel: 'warning',
    });
    const bundle = out.outputFiles[0].text;
    const fp = fingerprint(bundle);
    mkdirSync(CACHE_DIR, { recursive: true });
    const file = join(CACHE_DIR, `worker-${fp}.mjs`);
    writeFileSync(file, bundle);
    const cache = new Cache(fp);
    const early = (opts.early ?? process.env.EARLY === '1') ? earlyClasses(cache, ruleFromEnv()) : new Set<BattleClass>();
    const size = opts.workers ?? Number(process.env.WORKERS ?? 8);
    const budget = opts.budgetMin ?? Number(process.env.BUDGET_MIN ?? 60);
    return new Pool(file, cache, size, budget, early, opts.cache ?? process.env.NOCACHE !== '1');
  }

  /** The code fingerprint the cache is keyed on. */
  get fp(): string {
    return this.cache.fp;
  }

  get minutes(): number {
    return (performance.now() - this.t0) / 60_000;
  }

  battle(asked: PoolJob): Promise<Result> {
    if (this.failed) return Promise.reject(this.failed);
    const { early, ...rest } = asked;
    const job: Job = early && this.early.has(classOf(asked.setup)) ? { ...rest, early: this.rule } : rest;
    const key = sha(JSON.stringify(job));
    const hit = this.useCache ? this.cache.get<Result>(key) : undefined;
    if (hit) {
      this.stats.cached++;
      if (hit.decided) this.stats.decided++;
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ job, key, resolve, reject });
      this.pump();
    });
  }

  /** Stop the workers; call once every battle is in. */
  async close(): Promise<void> {
    clearTimeout(this.timer);
    await Promise.all(this.all.map((w) => w.terminate()));
  }

  /** "N played (M decided early), K from cache, x min on W threads" */
  summary(): string {
    const s = this.stats;
    const time = (min: number) => (min < 1 ? `${(min * 60).toFixed(0)} s` : `${min.toFixed(1)} min`);
    return `${s.played} battles played, ${s.cached} from cache${s.decided ? `, ${s.decided} decided early` : ''}; ${time(this.minutes)} on ${this.size} threads (${time(s.cpuMs / 60_000)} of battles), cache ${this.fp}`;
  }

  private pump(): void {
    while (this.queue.length && (this.idle.length || this.all.length < this.size)) {
      const w = this.idle.pop() ?? this.spawn();
      const p = this.queue.shift()!;
      this.busy.set(w, { ...p, t: performance.now() });
      w.postMessage({ id: 0, job: p.job });
    }
  }

  private spawn(): Worker {
    const w = new Worker(this.file);
    w.on('message', (m: { result?: Result; error?: string }) => {
      const p = this.busy.get(w);
      if (!p) return; // aborted
      this.busy.delete(w);
      if (m.error !== undefined) p.reject(new Error(`battle failed: ${m.error}`));
      else {
        const r = m.result!;
        this.stats.played++;
        this.stats.cpuMs += performance.now() - p.t;
        if (r.decided) this.stats.decided++;
        this.cache.put(p.key, r);
        p.resolve(r);
      }
      this.idle.push(w);
      this.pump();
    });
    w.on('error', (e) => this.abort(e));
    this.all.push(w);
    return w;
  }

  private abort(e: Error): void {
    if (this.failed) return;
    this.failed = e;
    for (const p of [...this.queue, ...this.busy.values()]) p.reject(e);
    this.queue.length = 0;
    this.busy.clear();
    for (const w of this.all) void w.terminate();
  }
}

/** Whether a verdict lets its rule be used for a class. */
export function passes(v: EarlyVerdict, cls: BattleClass): boolean {
  const eligible = EARLY_CLASSES.reduce((n, c) => n + (v.byClass[c]?.battles ?? 0), 0);
  const t = v.byClass[cls];
  return EARLY_CLASSES.includes(cls) && eligible >= EARLY_MIN && !!t && t.called >= EARLY_MIN_CALLS && t.agreed >= EARLY_AGREE * t.called;
}

/** The battle classes the rule may be used for, from its stored verdict; none if it's missing or failed. */
export function earlyClasses(cache: Cache, rule: Rule): Set<BattleClass> {
  const v = cache.read<EarlyVerdict>(earlyFile(rule));
  const ok = new Set(EARLY_CLASSES.filter((c) => v && passes(v, c)));
  if (!v) console.warn(`balance pool: EARLY=1 ignored, no early check of ${rule.share} for ${rule.secs} s on this code (npx vite-node scripts/balance/early-check.ts)`);
  else if (!ok.size) console.warn(`balance pool: EARLY=1 ignored, ${rule.share} for ${rule.secs} s failed the early check on this code`);
  return ok;
}
