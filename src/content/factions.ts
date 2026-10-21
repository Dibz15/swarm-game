export const FACTION_HEX = ['#2de2e6', '#ff3cac', '#b4ff39', '#ffb627', '#a07bff', '#ff6b4a', '#8a90a6'] as const;
export const FACTION_NAMES = ['Cyan', 'Magenta', 'Lime', 'Amber', 'Violet', 'Coral', 'Neutral'] as const;

export type RGB = [number, number, number];

function parse(hex: string): RGB {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export const FACTION_RGB: RGB[] = FACTION_HEX.map(parse);

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export const WHITE: RGB = [255, 255, 255];
