#!/usr/bin/env node
/**
 * Stand-in sprites for ВОСТОК-9 — **not the art**.
 *
 * Why this exists. The renderer takes a texture where there is one and keeps the
 * old rectangle where there is not (`src/game/artTextures.ts`). Both halves of
 * that have to be looked at with eyes, and by a second agent — AGENTS.md says
 * the author does not judge his own result. On an empty PixelLab key there is no
 * way to look at the textured half at all. So this script paints crude
 * palette-correct shapes at exactly the sizes the manifest asks for: right file
 * names, right sizes, right transparency, GDD §16 colours, nothing else.
 *
 * They are marked as placeholders in content/art/index.json, and
 * `scripts/art/generate.mjs` treats a marked file as missing — a stand-in can
 * never stand between the owner and a real generation.
 *
 * Usage:
 *   node scripts/art/placeholders.mjs          fill in everything not yet drawn
 *   node scripts/art/placeholders.mjs --force  redraw the stand-ins too
 *   node scripts/art/placeholders.mjs --clean  delete every stand-in again
 *
 * Real generated art is never touched, with or without --force.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, parseHex, readIndex, writeIndex } from './generate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ART_DIR = join(ROOT, 'content', 'art');
const MANIFEST_PATH = join(HERE, 'manifest.json');

/** Deterministic noise, so the same stand-in comes out of every run. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Which crude shape stands in for an asset, from its id. */
function shapeOf(id) {
  if (id.startsWith('rock-') || id === 'tunnel' || id === 'surface') {
    return 'tile';
  }
  if (id === 'sky') {
    return 'sky';
  }
  if (id === 'dome') {
    return 'dome';
  }
  return 'blob';
}

/**
 * One stand-in. Returns RGBA bytes; `tile` and `sky` come out fully opaque, the
 * rest transparent outside the silhouette, exactly like the real sprites will.
 */
function paint(asset, colors) {
  const { width, height } = asset.size;
  const shape = shapeOf(asset.id);
  const px = Buffer.alloc(width * height * 4);
  const random = rng(asset.seed);
  const palette = colors.map(parseHex);
  const put = (x, y, [r, g, b], a = 255) => {
    const at = (y * width + x) * 4;
    px[at] = r;
    px[at + 1] = g;
    px[at + 2] = b;
    px[at + 3] = a;
  };

  if (shape === 'sky') {
    for (let y = 0; y < height; y += 1) {
      const band = palette[Math.min(palette.length - 1, Math.floor((y / height) * palette.length))];
      for (let x = 0; x < width; x += 1) {
        put(x, y, band);
      }
    }
    return px;
  }

  if (shape === 'tile') {
    // Blocky value noise over the palette, plus a darker frame so the grid of
    // cells still reads as a grid.
    const block = 4;
    const cells = Math.ceil(width / block) * Math.ceil(height / block);
    const field = Array.from({ length: cells }, () => Math.floor(random() * (palette.length - 1)));
    const perRow = Math.ceil(width / block);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
        const index = field[Math.floor(y / block) * perRow + Math.floor(x / block)];
        put(x, y, edge ? palette[palette.length - 1] : palette[index]);
      }
    }
    return px;
  }

  // A silhouette on transparent ground: half an ellipse for the dome, a whole
  // one for everything else, with a bright core so the sprite is not a slab.
  const cx = (width - 1) / 2;
  const cy = shape === 'dome' ? height - 1 : (height - 1) / 2;
  const rx = width / 2 - 1;
  const ry = shape === 'dome' ? height - 2 : height / 2 - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dist = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (dist > 1) {
        continue;
      }
      const shade = dist > 0.82 ? palette[palette.length - 1] : palette[dist < 0.22 ? 0 : 1];
      put(x, y, shade);
    }
  }
  // One accent pixel cluster, so left and right of a flipped sprite differ.
  const accent = palette[Math.min(3, palette.length - 1)];
  for (let y = Math.floor(cy - ry * 0.35); y <= Math.ceil(cy - ry * 0.1); y += 1) {
    for (let x = Math.floor(cx + rx * 0.15); x <= Math.ceil(cx + rx * 0.45); x += 1) {
      if (x >= 0 && y >= 0 && x < width && y < height) {
        put(x, y, accent);
      }
    }
  }
  return px;
}

function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const clean = argv.includes('--clean');
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  mkdirSync(ART_DIR, { recursive: true });
  const marked = new Set(readIndex().placeholders);

  if (clean) {
    for (const id of marked) {
      rmSync(join(ART_DIR, `${id}.png`), { force: true });
    }
    writeIndex(manifest, []);
    console.log(`Удалено заглушек: ${marked.size}. content/art/ снова чистая.`);
    return;
  }

  const written = [];
  for (const asset of manifest.assets) {
    const file = join(ART_DIR, `${asset.id}.png`);
    if (existsSync(file) && !marked.has(asset.id)) {
      console.log(`· ${asset.id}: настоящий арт, не трогаю`);
      continue;
    }
    if (existsSync(file) && !force) {
      written.push(asset.id);
      continue;
    }
    const colors = manifest.palettes[asset.palette];
    writeFileSync(file, encodePng(asset.size.width, asset.size.height, paint(asset, colors), 4));
    written.push(asset.id);
  }

  writeIndex(manifest, written);
  console.log(`Заглушек в content/art/: ${written.length} — ${written.join(', ')}`);
  console.log('Это НЕ арт. Удалить: node scripts/art/placeholders.mjs --clean');
}

main();
