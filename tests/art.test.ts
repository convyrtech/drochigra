import { describe, expect, it } from 'vitest';
import artIndex from '../content/art/index.json' with { type: 'json' };
import balanceJson from '../content/balance.json' with { type: 'json' };
import manifest from '../scripts/art/manifest.json' with { type: 'json' };
import { ART } from '../src/game/artIds.js';
import { enemyBarOffset, ENEMY_STYLE, ENEMY_STYLE_FALLBACK, VIEW } from '../src/game/layout.js';
import type { Balance } from '../src/sim/balance.js';

/**
 * The art pipeline has one seam that nothing else checks: the ids in
 * `scripts/art/manifest.json` — what gets generated and paid for — and the ids
 * in `src/game/artTextures.ts` — what the game will draw — are two lists that
 * have to say the same thing. A typo on either side is silent: the generator
 * spends a generation on a file nobody loads, or the game quietly keeps drawing
 * a rectangle over art that exists. These tests are the seam.
 */

const balance = balanceJson as unknown as Balance;

/** The PNGs really sitting in content/art/, by id. */
const filesOnDisk = new Set(
  Object.keys(import.meta.glob('../content/art/*.png')).map((path) =>
    path.slice(path.lastIndexOf('/') + 1, -'.png'.length),
  ),
);

/** Every sprite id the game can draw. */
const usedIds = [
  ...ART.rockByLayer,
  ART.tunnel,
  ART.surface,
  ART.drill,
  ART.dome,
  ART.turret,
  ...Object.values(ART.enemyByType),
  ART.crystal,
  ART.scrap,
  ART.sky,
];

const manifestIds = manifest.assets.map((asset) => asset.id);

describe('the sprite manifest and the game agree on what exists', () => {
  it('names every sprite the game draws', () => {
    for (const id of usedIds) {
      expect(manifestIds, `${id} is drawn but never generated`).toContain(id);
    }
  });

  it('does not pay for a sprite nothing draws', () => {
    for (const id of manifestIds) {
      expect(usedIds, `${id} is generated but never drawn`).toContain(id);
    }
  });

  it('has one rock face per layer of the balance', () => {
    expect(ART.rockByLayer).toHaveLength(balance.layers.length);
  });

  it('has a creature per enemy of the balance', () => {
    for (const type of Object.keys(balance.enemies)) {
      expect(Object.keys(ART.enemyByType), `no sprite for ${type}`).toContain(type);
      expect(ENEMY_STYLE[type], `no draw style for ${type}`).toBeDefined();
    }
  });
});

describe('the manifest itself', () => {
  it('gives every asset a palette that exists', () => {
    const palettes = manifest.palettes as Record<string, unknown>;
    for (const asset of manifest.assets) {
      expect(Array.isArray(palettes[asset.palette]), `${asset.id}: palette ${asset.palette}`).toBe(
        true,
      );
    }
  });

  it('only ever asks for colours of GDD §16', () => {
    const hex = /^#[0-9A-F]{6}$/;
    for (const [name, colors] of Object.entries(manifest.palettes)) {
      if (!Array.isArray(colors)) {
        continue;
      }
      for (const color of colors) {
        expect(hex.test(color), `${name}: ${color} is not an upper case hex colour`).toBe(true);
      }
    }
  });

  it('stays inside the 16..400 pixel range the API takes, and gives every asset its own seed', () => {
    const seeds = new Set<number>();
    for (const asset of manifest.assets) {
      expect(asset.size.width, asset.id).toBeGreaterThanOrEqual(16);
      expect(asset.size.width, asset.id).toBeLessThanOrEqual(400);
      expect(asset.size.height, asset.id).toBeGreaterThanOrEqual(16);
      expect(asset.size.height, asset.id).toBeLessThanOrEqual(400);
      // A repeated seed would quietly make two assets the same picture.
      expect(seeds.has(asset.seed), `${asset.id}: seed ${asset.seed} is already used`).toBe(false);
      seeds.add(asset.seed);
    }
  });
});

describe('content/art/index.json', () => {
  it('is a list, so a game with no art at all still has something to read', () => {
    expect(Array.isArray(artIndex.assets)).toBe(true);
  });

  it('names only files that are really on disk and really in the manifest', () => {
    for (const id of artIndex.assets) {
      expect(manifestIds, `${id} is indexed but not in the manifest`).toContain(id);
      // An indexed file that is not there is a 404 on every page load, and the
      // e2e smoke test fails on console errors. Rerun `generate.mjs --index`.
      expect(filesOnDisk.has(id), `${id} is indexed but the PNG is missing`).toBe(true);
    }
  });

  it('leaves nothing on disk unindexed, or the game would draw a rectangle over it', () => {
    for (const id of filesOnDisk) {
      expect(artIndex.assets, `${id}.png exists but is not indexed`).toContain(id);
    }
  });
});

describe('an enemy health bar', () => {
  it('clears whatever is drawn above it', () => {
    for (const style of [...Object.values(ENEMY_STYLE), ENEMY_STYLE_FALLBACK]) {
      // With a sprite the bar has to clear half the sprite, not half the blob.
      expect(enemyBarOffset(style, true)).toBeGreaterThan(style.spriteSize / 2);
      expect(enemyBarOffset(style, false)).toBe(VIEW.dome.enemyBarOffset);
    }
  });
});
