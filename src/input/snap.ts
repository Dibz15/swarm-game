/**
 * Touch taps snap to nests (#115): zoomed out, a nest is a few pixels across
 * and a finger misses it. A tap within `pad` (world units; the caller turns a
 * fixed screen distance into it, so it holds at any zoom) of a nest's rim
 * counts as on that nest; further out, open ground stays open ground.
 */

/** the slack a nest's own hit test already allows (GameView.nestAt) */
const RIM = 1.25;

export function snapNest<N extends { x: number; y: number; r: number }>(nests: readonly N[], x: number, y: number, pad: number): N | null {
  let best: N | null = null;
  let bd = Infinity;
  for (const n of nests) {
    const d = Math.hypot(n.x - x, n.y - y) - n.r * RIM;
    if (d <= pad && d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}
