// Fitting for the run surrogate (#68): logistic regression with a random
// intercept per group, for battles that share a node.

// Gauss-Hermite nodes and weights for a standard normal (10 points).
const GH_X = [0.3429013272, 1.0366108298, 1.7566836493, 2.5327316742, 3.4361591188];
const GH_W = [0.6108626337, 0.2401386111, 0.0338743945, 0.0013436457, 0.0000076404];
const GH = [...GH_X.map((x, i) => ({ z: Math.SQRT2 * x, w: GH_W[i] / Math.sqrt(Math.PI) })), ...GH_X.map((x, i) => ({ z: -Math.SQRT2 * x, w: GH_W[i] / Math.sqrt(Math.PI) }))];

/**
 * Logistic regression with a random intercept per group, u ~ N(0, sd²), by
 * EM over Gauss-Hermite points: the E step weighs each group's points by how
 * well they explain its battles; the M step is a weighted logistic regression
 * where the point z is one more feature, so its weight is the sd. Fixed
 * weights get a ridge. groups[n] < 0 means no group. Returns the weights, the
 * sd and each group's posterior mean effect.
 */
export function mixedLogistic(xs: number[][], ys: number[], groups: number[], ridge = 0.5, rounds = 40): { w: number[]; sd: number; u: number[] } {
  const k = xs[0].length;
  const G = Math.max(-1, ...groups) + 1;
  const rows = Array.from({ length: G }, () => [] as number[]);
  groups.forEach((g, n) => g >= 0 && rows[g].push(n));
  let w = new Array(k).fill(0);
  let sd = G ? 1 : 0;
  let post: number[][] = rows.map(() => GH.map((q) => q.w));
  const loglik = (n: number, z: number) => {
    const p = sigmoid(dot(w, xs[n]) + sd * z);
    return Math.log(Math.max(1e-12, ys[n] ? p : 1 - p));
  };
  for (let round = 0; round < rounds; round++) {
    // E: each group's posterior over the points.
    post = rows.map((ns) => {
      const l = GH.map((q) => Math.log(q.w) + ns.reduce((t, n) => t + loglik(n, q.z), 0));
      const top = Math.max(...l);
      const e = l.map((v) => Math.exp(v - top));
      const sum = e.reduce((t, v) => t + v, 0);
      return e.map((v) => v / sum);
    });
    // M: weighted logistic regression on [x, z], Newton steps.
    let theta = [...w, sd];
    for (let it = 0; it < 25; it++) {
      const g = theta.map((v, i) => (i < k ? ridge * v : 0));
      const h = Array.from({ length: k + 1 }, (_, i) => Array.from({ length: k + 1 }, (_, j) => (i === j ? (i < k ? ridge : 1e-6) : 0)));
      const add = (x: number[], y: number, wt: number) => {
        const p = sigmoid(dot(theta, x));
        const s = wt * p * (1 - p);
        for (let i = 0; i <= k; i++) {
          g[i] += wt * (p - y) * x[i];
          for (let j = 0; j <= k; j++) h[i][j] += s * x[i] * x[j];
        }
      };
      groups.forEach((gr, n) => (gr < 0 ? add([...xs[n], 0], ys[n], 1) : GH.forEach((q, j) => add([...xs[n], q.z], ys[n], post[gr][j]))));
      const step = solve(h, g);
      theta = theta.map((v, i) => v - step[i]);
      if (Math.max(...step.map(Math.abs)) < 1e-7) break;
    }
    w = theta.slice(0, k);
    sd = G ? Math.abs(theta[k]) : 0;
  }
  const u = post.map((pq) => sd * pq.reduce((t, v, j) => t + v * GH[j].z, 0));
  return { w, sd, u };
}

export const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let j = c; j <= n; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}
