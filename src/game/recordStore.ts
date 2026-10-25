import type { Recording } from './recording';

/** Recordings live in this browser's IndexedDB only; nothing is uploaded. */
const DB = 'swarm';
const STORE = 'recordings';
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
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
  });
  return dbp;
}

function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = f(d.transaction(STORE, mode).objectStore(STORE));
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

/** Hand every recording to the browser as one JSON download. */
export async function downloadRecordings(): Promise<number> {
  const all = await allRecordings();
  all.sort((a, b) => a.date.localeCompare(b.date));
  const blob = new Blob([JSON.stringify({ swarmRecordings: 1, recordings: all })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `swarm-recordings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return all.length;
}
