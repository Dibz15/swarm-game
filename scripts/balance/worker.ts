// A pool worker (pool.ts): plays the battles it's sent, one at a time.
import { parentPort } from 'node:worker_threads';
import '../env';
import { playBattle, type Job } from './battle';

parentPort!.on('message', ({ id, job }: { id: number; job: Job }) => {
  try {
    parentPort!.postMessage({ id, result: playBattle(job) });
  } catch (e) {
    parentPort!.postMessage({ id, error: e instanceof Error ? e.stack : String(e) });
  }
});
