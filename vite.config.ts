import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/** Commit the build came from; recordings store it because replays need the same sim. */
function build(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

// base './' so the built dist/ works from any static host or subfolder.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  define: { __BUILD__: JSON.stringify(build()) },
});
