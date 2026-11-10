import { keepNewest, MAX_SAVED_MATCHES, type MatchSave } from '../net/matchSave';
import type { Recording } from './recording';

/** Recordings live in this browser's IndexedDB only; nothing is uploaded. */
const DB = 'swarm';
const STORE = 'recordings';
/** multiplayer matches saved when everyone lost touch (#191), by room */
const MATCHES = 'matches';
const FLAG = 'swarm.record';

export function recordingEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

export function setRecordingEnabled(on: boolean): void {
  try {
    localStorage.setItem(FLAG, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(MATCHES)) d.createObjectStore(MATCHES, { keyPath: 'room' });
    };
    req.onsuccess = () => {
      const d = req.result;
      // a newer build in another tab wants to upgrade: let it, and open again next time
      d.onversionchange = () => {
        d.close();
        dbp = null;
      };
      resolve(d);
    };
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
    // an older build in another tab holds it open: don't wait forever
    req.onblocked = () => {
      dbp = null;
      reject(new Error('storage: blocked by another tab'));
    };
  });
  return dbp;
}

function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = f(d.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Insert or overwrite (a match saved on tab-hide is saved again when it ends). */
export function saveRecording(r: Recording): Promise<unknown> {
  return run('readwrite', (s) => s.put(r)).catch((e) => console.warn('recording not saved', e));
}

export function allRecordings(): Promise<Recording[]> {
  return run('readonly', (s) => s.getAll() as IDBRequest<Recording[]>);
}

export function countRecordings(): Promise<number> {
  return run('readonly', (s) => s.count()).catch(() => 0);
}

export function clearRecordings(): Promise<unknown> {
  return run('readwrite', (s) => s.clear());
}

/** Hand a value to the browser as a JSON file to save. */
export function downloadJson(name: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Hand every recording to the browser as one JSON download. */
export async function downloadRecordings(): Promise<number> {
  const all = await allRecordings();
  all.sort((a, b) => a.date.localeCompare(b.date));
  downloadJson(`swarm-recordings-${new Date().toISOString().slice(0, 10)}.json`, { swarmRecordings: 1, recordings: all });
  return all.length;
}

// ---- saved multiplayer matches (#191) ------------------------------------------

/**
 * Save a match to pick up later (#191): replaces this room's save, and keeps
 * only the newest MAX_SAVED_MATCHES, first in, first out. Never throws: a
 * save that fails leaves play as it was.
 */
export async function saveMatch(m: MatchSave): Promise<boolean> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(MATCHES, 'readwrite');
      const st = tx.objectStore(MATCHES);
      const all = st.getAll() as IDBRequest<MatchSave[]>;
      all.onsuccess = () => {
        const { drop } = keepNewest(all.result, m);
        for (const room of drop) st.delete(room);
        st.put(m);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      // a full disk aborts it, with no error event
      tx.onabort = () => reject(tx.error ?? new Error('storage: save aborted'));
    });
    return true;
  } catch (e) {
    console.warn('match not saved', e);
    return false;
  }
}

/** This room's saved match, if any; null if storage doesn't answer within `capMs` (a stuck database never holds up a join). */
export function loadMatch(room: string, capMs = 1500): Promise<MatchSave | null> {
  const load = run('readonly', (s) => s.get(room) as IDBRequest<MatchSave | undefined>, MATCHES)
    .then((m) => m ?? null)
    .catch(() => null);
  return Promise.race([load, new Promise<null>((r) => setTimeout(() => r(null), capMs))]);
}

/** Every saved match, newest first. */
export function allMatches(): Promise<MatchSave[]> {
  return run('readonly', (s) => s.getAll() as IDBRequest<MatchSave[]>, MATCHES)
    .then((all) => all.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_SAVED_MATCHES))
    .catch(() => []);
}

export function deleteMatch(room: string): Promise<void> {
  return run('readwrite', (s) => s.delete(room), MATCHES)
    .then(() => undefined)
    .catch(() => undefined);
}
