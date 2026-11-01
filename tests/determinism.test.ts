import { describe, expect, it } from 'vitest';
import { datan2, dexp, dlog, dpow } from '../src/sim/mathx';

/** Math functions whose results may differ in the last bit between JS engines. */
const INEXACT = /Math\.(hypot|pow|exp|expm1|log|log1p|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|cbrt)\b/;
/** `**` is only trusted for squaring (engines special-case integer exponents) */
const POW_OP = /\*\*\s*(?!2\b)[\w(]/;

const SOURCES = import.meta.glob<string>('../src/sim/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('determinism (#26)', () => {
  it('the sim uses no engine-dependent Math outside mathx.ts', () => {
    const bad: string[] = [];
    expect(Object.keys(SOURCES).length).toBeGreaterThan(10);
    for (const [f, src] of Object.entries(SOURCES)) {
      if (f.endsWith('mathx.ts')) continue;
      src
        .split('\n')
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '').replace(/^\s*\/?\*.*$/, '');
          if (INEXACT.test(code) || POW_OP.test(code)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it('dlog / dexp / dpow match Math to ~1e-14', () => {
    for (const x of [1e-9, 0.001, 0.37, 1, 1.5, 2, 3, 7.25, 1000, 123456.789]) {
      expect(Math.abs(dlog(x) - Math.log(x))).toBeLessThan(1e-13 * Math.max(1, Math.abs(Math.log(x))));
    }
    for (const x of [-30, -5, -0.3, 0, 0.5, 1, 4.2, 20, 300]) {
      expect(Math.abs(dexp(x) / Math.exp(x) - 1)).toBeLessThan(1e-14);
    }
    for (let k = 1; k <= 40; k++) {
      for (const e of [-0.5, -0.35, -0.2, -0.05, 0, 0.3]) {
        expect(Math.abs(dpow(k, e) / Math.pow(k, e) - 1)).toBeLessThan(1e-13);
      }
    }
  });

  it('datan2 matches Math.atan2 to ~1e-13 in every quadrant (#114)', () => {
    for (let k = 0; k < 360; k++) {
      const a = (k / 360) * 2 * Math.PI - Math.PI + 0.001;
      for (const r of [0.01, 1, 250]) {
        const x = r * Math.cos(a), y = r * Math.sin(a);
        expect(Math.abs(datan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-13);
      }
    }
    expect(datan2(0, 0)).toBe(0);
    expect(datan2(0, -1)).toBeCloseTo(Math.PI, 13);
  });
});
