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
