// On-disk results for the balance harness (#68), in .balance-cache/ (gitignored).
// A result is keyed by its job and by a fingerprint of the code that plays it:
// the bundled battle worker itself, so any change to src/sim, src/campaign,
// src/proxy (or anything else the worker pulls in) starts a fresh cache, as do
// the tuning overrides scripts/env.ts reads.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE_DIR = fileURLToPath(new URL('../../.balance-cache', import.meta.url));
/** scripts/env.ts overrides that change constants inside the worker */
const OVERRIDES = ['SUPPLY', 'BOT', 'PERS', 'CROWD', 'CHOKE'];

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function fingerprint(bundle: string): string {
  return sha(bundle + JSON.stringify(OVERRIDES.map((k) => process.env[k] ?? null))).slice(0, 16);
}

export class Cache {
  readonly dir: string;
  constructor(readonly fp: string) {
    this.dir = join(CACHE_DIR, fp);
  }
  private path(key: string) {
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }
  get<T>(key: string): T | undefined {
    const p = this.path(key);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined;
  }
  put(key: string, value: unknown): void {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(value));
  }
  /** a named file beside the results, e.g. the early check's verdict */
  read<T>(name: string): T | undefined {
    const p = join(this.dir, name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined;
  }
  write(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, name), JSON.stringify(value, null, 2));
  }
}
