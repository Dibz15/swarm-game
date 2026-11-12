/** Small DOM helpers shared by the UI screens. */

/** One element built from an HTML string. */
export function el(html: string): HTMLDivElement {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLDivElement;
}

/** Text made safe to put in HTML (player-typed seeds and names). */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
