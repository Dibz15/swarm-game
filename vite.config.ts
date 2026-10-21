import { defineConfig } from 'vite';

// base './' so the built dist/ works from any static host or subfolder.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
