// Shared loading for recording scripts: accepts exported files ({recordings: [...]}) or single recordings.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Recording } from '../src/game/recording';

export function loadRecordings(paths: string[]): Recording[] {
  if (!paths.length) {
    console.error('usage: npx vite-node scripts/<script>.ts swarm-recordings-*.json [...]');
    process.exit(2);
  }
  const out: Recording[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    for (const r of (data.recordings ?? [data]) as Recording[]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function currentBuild(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export const label = (r: Recording) => r.scenario ?? 'custom';
