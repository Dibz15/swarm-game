// Deterministic trig. Math.sin/cos are not guaranteed bit-identical across
// browsers, which would desync lockstep multiplayer, so the sim uses a table
// built from a Taylor series (only +, *, / which are IEEE-exact).

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;

const N = 4096;
const SIN = new Float64Array(N);

function taylorSin(x: number): number {
  if (x > PI / 2) x = PI - x;
  else if (x < -PI / 2) x = -PI - x;
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let k = 1; k < 12; k++) {
    term *= -x2 / (2 * k * (2 * k + 1));
    sum += term;
  }
  return sum;
}

for (let i = 0; i < N; i++) {
  let a = (i / N) * TAU;
  if (a > PI) a -= TAU;
  SIN[i] = taylorSin(a);
}

function idx(a: number): number {
  let t = a / TAU;
  t -= Math.floor(t);
  return Math.floor(t * N) & (N - 1);
}

export function dsin(a: number): number {
  return SIN[idx(a)];
}

export function dcos(a: number): number {
  return SIN[idx(a + PI / 2)];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Deterministic exp/log/pow, same idea: Math.exp/log/pow (and hypot) are
// implementation-defined and differ in the last bit between engines (#26).

const LN2 = 0.6931471805599453;
/** ln 2 split so n * LN2_HI is exact (fdlibm's Cody-Waite constants) */
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;

/** Natural log for x > 0: split off powers of two, then a fast atanh series. */
export function dlog(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  if (x === Infinity) return x;
  let e = 0;
  while (x >= 2) {
    x /= 2;
    e++;
  }
  while (x < 1) {
    x *= 2;
    e--;
  }
  // ln(x) = 2 atanh(z), z = (x-1)/(x+1) <= 1/3
  const z = (x - 1) / (x + 1);
  const z2 = z * z;
  let term = z;
  let sum = z;
  for (let k = 3; k < 60; k += 2) {
    term *= z2;
    sum += term / k;
  }
  return 2 * sum + e * LN2;
}

/** e^x: reduce by ln 2 to |r| <= ln2/2, Taylor series, then scale by 2^n exactly. */
export function dexp(x: number): number {
  if (x !== x) return x;
  if (x > 709.7) return Infinity;
  if (x < -745) return 0;
  const n = Math.round(x / LN2);
  const r = x - n * LN2_HI - n * LN2_LO;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 24; k++) {
    term *= r / k;
    sum += term;
  }
  let s = 1;
  for (let i = 0; i < Math.abs(n); i++) s *= 2;
  return n >= 0 ? sum * s : sum / s;
}

/** a^b for a > 0. */
export function dpow(a: number, b: number): number {
  if (b === 0) return 1;
  if (a === 1) return 1;
  return dexp(b * dlog(a));
}
