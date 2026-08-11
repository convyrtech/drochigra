import { defineConfig } from 'vitest/config';

// base: './' keeps every asset path relative, so the same build works from a
// GitHub Pages subfolder and from an itch.io zip upload.
//
// publicDir points at content/ so the owner edits content/balance.json in the
// repo root and the game picks it up on the next page reload. On build the file
// is copied to dist/balance.json as a plain, still editable file.
export default defineConfig({
  base: './',
  publicDir: 'content',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    environment: 'node',
  },
});
