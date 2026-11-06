/**
 * Nest shapes inline in text (#115): the same outline each type wears on the
 * map (Hive hex, Forge block, Spire needle, Den arrowhead, Bastion octagon),
 * so a player can match a name to what they see.
 */

const ring = (n: number, r: number, a0: number): string =>
  Array.from({ length: n }, (_, k) => {
    const a = a0 + (k * Math.PI * 2) / n;
    return `${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`;
  }).join(' ');

const SHAPES = [
  ring(6, 8, Math.PI / 6), // Hive
  '-6.5,-6.5 6.5,-6.5 6.5,6.5 -6.5,6.5', // Forge
  '0,-9 3.2,0 0,9 -3.2,0', // Spire
  '0,-8 7,7 0,3 -7,7', // Den
  ring(8, 8, Math.PI / 8), // Bastion
];

/** A small inline SVG of a nest type's shape, in the text's colour. */
export function nestIcon(type: number): string {
  return `<svg class="nest-ico" viewBox="-10 -10 20 20" aria-hidden="true"><polygon points="${SHAPES[type] ?? SHAPES[0]}"/></svg>`;
}
