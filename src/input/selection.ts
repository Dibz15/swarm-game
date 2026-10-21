import type { World } from '../sim/world';

/** Client-only selection state. The sim never sees it; commands carry uids. */
export class Selection {
  units = new Set<number>();
  nests = new Set<number>();
  private groups = new Map<number, { units: number[]; nests: number[] }>();

  get empty(): boolean {
    return this.units.size === 0 && this.nests.size === 0;
  }

  clear(): void {
    this.units.clear();
    this.nests.clear();
  }

  set(units: Iterable<number>, nests: Iterable<number>, additive: boolean): void {
    if (!additive) this.clear();
    for (const u of units) this.units.add(u);
    for (const n of nests) this.nests.add(n);
  }

  /** Drop dead units and nests we no longer own. */
  prune(w: World, human: number): void {
    for (const u of this.units) if (!w.uidToSlot.has(u)) this.units.delete(u);
    for (const n of this.nests) if (w.nests[n]?.owner !== human) this.nests.delete(n);
  }

  mask(w: World, out: Uint8Array): Uint8Array {
    out.fill(0, 0, w.n);
    for (const u of this.units) {
      const s = w.uidToSlot.get(u);
      if (s !== undefined) out[s] = 1;
    }
    return out;
  }

  saveGroup(k: number): void {
    this.groups.set(k, { units: [...this.units], nests: [...this.nests] });
  }

  recallGroup(k: number): boolean {
    const g = this.groups.get(k);
    if (!g) return false;
    this.set(g.units, g.nests, false);
    return true;
  }
}
