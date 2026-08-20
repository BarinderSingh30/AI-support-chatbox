import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', name: 'GroundworkWidget', fileName: () => 'loader.js', formats: ['iife'] },
    // A support widget's own footprint on the client's page must stay small —
    // this is the one file that loads synchronously on their site.
    minify: 'esbuild',
  },
  test: { environment: 'jsdom' },
});
