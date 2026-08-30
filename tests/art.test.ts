import { afterEach, describe, expect, it, vi } from 'vitest';
import artIndex from '../content/art/index.json' with { type: 'json' };
import balanceJson from '../content/balance.json' with { type: 'json' };
import manifest from '../scripts/art/manifest.json' with { type: 'json' };
import { artUrl, loadArtIndex, NO_ART, ART } from '../src/game/artIds.js';
import {
  corridorLaneY,
  domeCrownY,
  domeZoneHeight,
  enemyBarOffset,
  ENEMY_STYLE,
  ENEMY_STYLE_FALLBACK,
  VIEW,
} from '../src/game/layout.js';
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

/**
 * The PNGs really sitting in content/art/, read as text.
 *
 * Text, and not bytes, because this repository has no `@types/node` and a test
 * may not reach for `node:fs`. Vite's `?raw` decodes the file as UTF-8, so every
 * byte over 0x7F comes back as a replacement character — but every run of plain
 * ASCII survives intact, and the one thing asked of the contents here is
 * whether a nineteen-character ASCII keyword sits in it.
 */
const pngText = import.meta.glob('../content/art/*.png', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The same files, by id. */
const filesOnDisk = new Set(
  Object.keys(pngText).map((path) => path.slice(path.lastIndexOf('/') + 1, -'.png'.length)),
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

/**
 * Every colour `GDD_VOSTOK9.md` §16 names, and nothing else. Written out here on
 * purpose: condition #3 of `docs/GOAL_V1.md` is «pixel art in one palette, the
 * one from §16», and a regular expression over the shape of a hex string does
 * not hold that — swap every colour of the manifest for #FF00FF and a shape
 * check stays green. This list is the condition.
 */
const GDD_16 = new Set([
  // PALETTE.md — the surface and the machines
  '#E8EDF2',
  '#8A94A6',
  '#7A4A32',
  '#C0392B',
  '#F2C14E',
  // L1
  '#BFE3F0',
  '#7FB6C9',
  '#35608C',
  '#0E2A44',
  // L2
  '#0E3B3B',
  '#14666B',
  '#2FB8A6',
  '#B8FFE8',
  // L3
  '#06222E',
  '#0B3A4A',
  '#12617A',
  '#E8A13C',
  // L4
  '#2A1E2E',
  '#5C4054',
  '#D9C7A8',
  '#B84D8C',
  // L5
  '#0A0A0F',
  '#D9A441',
  '#8C6B1F',
  '#FFE9A6',
]);

/** One cell of the shaft, and the size a cell sprite is stretched to. */
const CELL = VIEW.width / balance.shift.grid_width;
const TILE = CELL - VIEW.cellGap;

/**
 * The size, in design pixels, every sprite is really drawn at — read from the
 * same constants the drawing sites read. `scripts/art/manifest.json` has to
 * generate each one at exactly this size, or at a whole fraction of it.
 */
const drawnSize: Record<string, { width: number; height: number }> = {
  'rock-l1': { width: TILE, height: TILE },
  'rock-l2': { width: TILE, height: TILE },
  'rock-l3': { width: TILE, height: TILE },
  tunnel: { width: TILE, height: TILE },
  surface: { width: TILE, height: TILE },
  drill: { width: CELL * VIEW.drillArtSizeShare, height: CELL * VIEW.drillArtSizeShare },
  dome: { width: VIEW.dome.halfWidth * 2, height: VIEW.dome.artHeight },
  turret: { width: VIEW.dome.turretArtSize, height: VIEW.dome.turretArtSize },
  'enemy-aberration': {
    width: ENEMY_STYLE.aberration!.spriteSize,
    height: ENEMY_STYLE.aberration!.spriteSize,
  },
  'enemy-drowned': {
    width: ENEMY_STYLE.drowned!.spriteSize,
    height: ENEMY_STYLE.drowned!.spriteSize,
  },
  'enemy-moth': { width: ENEMY_STYLE.moth!.spriteSize, height: ENEMY_STYLE.moth!.spriteSize },
  crystal: { width: VIEW.hud.statIconSize, height: VIEW.hud.statIconSize },
  scrap: { width: VIEW.hud.statIconSize, height: VIEW.hud.statIconSize },
  sky: { width: VIEW.width, height: domeZoneHeight() },
};

/**
 * The mark `scripts/art/placeholders.mjs` stamps into every stand-in it paints:
 * the keyword of an uncompressed `tEXt` chunk, so it is plain ASCII inside the
 * file. Real art from PixelLab has no such chunk, and the odds of nineteen
 * given bytes turning up inside a deflate stream are not worth a sentence.
 */
const PLACEHOLDER_KEYWORD = 'vostok9-placeholder';

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
    for (const [name, colors] of Object.entries(manifest.palettes)) {
      if (!Array.isArray(colors)) {
        continue;
      }
      for (const color of colors) {
        // The forced palette is the whole of the style discipline: whatever is
        // in this list is what the generator is physically able to paint.
        expect(GDD_16.has(color), `${name}: ${color} is not a colour of GDD §16`).toBe(true);
      }
    }
  });

  it('asks for no colour a prompt cannot get, and no prompt for a colour it has not', () => {
    // Cheap, blunt, and it would have caught the one that was there: `sky` was
    // asking for «faint green aurora curtains» out of a palette with no green
    // in it — a whole generation spent on a picture that could not be painted.
    const green = ['#2FB8A6', '#B8FFE8', '#0E3B3B', '#14666B'];
    for (const asset of manifest.assets) {
      const colors = (manifest.palettes as unknown as Record<string, string[]>)[asset.palette] ?? [];
      if (/green|aurora|emerald/i.test(asset.prompt)) {
        expect(
          colors.some((color) => green.includes(color)),
          `${asset.id}: the prompt asks for green, the palette ${asset.palette} has none`,
        ).toBe(true);
      }
    }
  });

  it('generates every sprite at the size it is drawn at, or a whole fraction of it', () => {
    for (const asset of manifest.assets) {
      const drawn = drawnSize[asset.id];
      expect(drawn, `${asset.id} is generated but its drawn size is unknown`).toBeDefined();
      if (!drawn) {
        continue;
      }
      // Whole numbers on both sides: half a pixel of a sprite cannot be drawn.
      expect(Number.isInteger(drawn.width), `${asset.id}: drawn width ${drawn.width}`).toBe(true);
      expect(Number.isInteger(drawn.height), `${asset.id}: drawn height ${drawn.height}`).toBe(
        true,
      );
      const scale = drawn.width / asset.size.width;
      // NEAREST is exact at whole multiples and only at whole multiples: at
      // ×1.203 it duplicates rows unevenly, at ×0.875 it throws rows away.
      expect(Number.isInteger(scale), `${asset.id}: drawn ×${scale} wide`).toBe(true);
      expect(scale, `${asset.id}: drawn smaller than generated`).toBeGreaterThanOrEqual(1);
      expect(drawn.height / asset.size.height, `${asset.id}: stretched unevenly`).toBe(scale);
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

  it('holds no stand-in: a placeholder must never be committed as art', () => {
    // `placeholders.mjs` paints crude palette blobs so the textured half of the
    // renderer can be looked at on an empty key. They are not art, they are not
    // §16 pixel art, and condition #3 of GOAL_V1 is not closed by them. Clean
    // them before committing: `node scripts/art/placeholders.mjs --clean`.
    expect(artIndex.placeholders, 'stand-ins are still in content/art/').toEqual([]);
  });

  it('and no PNG on disk says it is one either, whatever the index says', () => {
    // The index is derived and can be deleted; the mark travels in the file.
    // This is the check that survives `rm content/art/index.json && npm run art
    // -- --index`, which is exactly how fourteen blobs became «art» once.
    for (const [path, text] of Object.entries(pngText)) {
      expect(
        text.includes(PLACEHOLDER_KEYWORD),
        `${path} is a stand-in from placeholders.mjs, not art`,
      ).toBe(false);
    }
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

/**
 * The dome zone is 410 pixels tall and has to hold, top to bottom: the panel
 * text, three lanes of walking creatures, the station, two bars and two
 * buttons. Sprites are bigger than the shapes they replace, so the sums below
 * are the ones that stopped being obvious the moment art was drawn instead of
 * rectangles — and the ones a screenshot only shows if a wave happens to be out.
 */
describe('the station and the corridor in front of it', () => {
  const dome = VIEW.dome;
  const styles = [...Object.values(ENEMY_STYLE), ENEMY_STYLE_FALLBACK];
  /** The lower of the two roofs — sprite or bare arc — is what must be cleared. */
  const roof = Math.min(domeCrownY(true), domeCrownY(false));

  it('walks every lane above the roof, health bar and all', () => {
    for (let lane = 0; lane < dome.lanes; lane += 1) {
      for (const style of styles) {
        const bottom = corridorLaneY(lane) + enemyBarOffset(style, true) + dome.enemyBarHeight;
        expect(
          bottom,
          `lane ${lane} with a ${style.spriteSize}px creature ends at ${bottom}, roof is ${roof}`,
        ).toBeLessThanOrEqual(roof);
      }
    }
  });

  it('keeps the far lane clear of the panel text above it', () => {
    const tallest = Math.max(...styles.map((style) => style.spriteSize));
    expect(corridorLaneY(0) - tallest / 2).toBeGreaterThanOrEqual(VIEW.hud.skyScrimTopHeight);
  });

  it('puts the block turret on the roof that is drawn, not on the one that is not', () => {
    // `dome` and `turret` are neighbours in the manifest, so «shell bought,
    // turret not» is exactly where a key runs out. Read `apexY` for both and
    // the yellow block is drawn inside the roof of the shell sprite.
    for (const hasShell of [false, true]) {
      const crown = domeCrownY(hasShell);
      expect(crown - dome.turretHeight, 'the block hangs below its own base').toBeLessThan(crown);
      if (hasShell) {
        expect(crown, 'the block sits inside the shell sprite').toBeLessThanOrEqual(
          dome.baseY - dome.artHeight,
        );
      }
    }
  });

  it('seats the turret sprite on the roof and starts its beam inside itself', () => {
    const top = dome.turretArtY - dome.turretArtSize / 2;
    const bottom = dome.turretArtY + dome.turretArtSize / 2;
    for (const hasShell of [false, true]) {
      const crown = domeCrownY(hasShell);
      expect(top, 'the turret is drawn below the roof').toBeLessThan(crown);
      expect(bottom, 'the turret floats above the roof').toBeGreaterThanOrEqual(crown);
    }
    expect(dome.muzzleY, 'the muzzle is above the sprite').toBeGreaterThan(top);
    expect(dome.muzzleY, 'the beam starts inside the station').toBeLessThan(roof);
  });
});

/**
 * The runtime half. `artUrl` and `loadArtIndex` have no Phaser in them, and the
 * second one is the whole of the mechanism behind «the game never asks for a
 * PNG that is not there»: a 404 is a console error and the e2e smoke test
 * counts console errors. Untested, it was free to return anything.
 */
describe('finding the art at runtime', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  /** Answers the next fetch with this body, and remembers how it was called. */
  function answerWith(body: unknown, ok = true): ReturnType<typeof vi.fn> {
    const fake = vi.fn(async () => ({ ok, json: async () => body }));
    globalThis.fetch = fake as unknown as typeof fetch;
    return fake;
  }

  it('builds a URL under the base, so a subfolder build still finds the file', () => {
    // The base is Vite's own (`./` in vite.config.ts, `/` under vitest): the
    // path must be built from it and never hard-coded, or a build served from a
    // GitHub Pages subfolder or an itch.io zip asks the wrong host for /art/.
    expect(artUrl('dome')).toBe(`${import.meta.env.BASE_URL}art/dome.png`);
    expect(artUrl('dome')).toMatch(/(^|\/)art\/dome\.png$/);
    expect(artUrl('dome')).not.toBe(artUrl('turret'));
  });

  it('asks for the index in the same folder as the art, and never off a cache', async () => {
    const fake = answerWith({ assets: [] });
    await loadArtIndex();
    expect(fake).toHaveBeenCalledTimes(1);
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${import.meta.env.BASE_URL}art/index.json`);
    // Tied to `artUrl` on purpose: point one of them somewhere else and the
    // game loads an index that does not describe the files next to it.
    expect(url).toBe(artUrl('index').replace(/\.png$/, '.json'));
    // The index changes every time a generation lands; a cached one names
    // sprites that are not there yet, and every one of those is a 404.
    expect(init.cache).toBe('no-store');
  });

  it('returns exactly what the index lists, in its order', async () => {
    answerWith({ assets: ['sky', 'dome', 'turret'], placeholders: ['sky'] });
    expect(await loadArtIndex()).toEqual(['sky', 'dome', 'turret']);
  });

  it('reads `assets` and nothing else — a placeholder list is not an asset list', async () => {
    answerWith({ assets: [], placeholders: ['dome', 'turret'] });
    expect(await loadArtIndex()).toEqual([]);
  });

  it('drops entries that are not names, so no request is ever made for one', async () => {
    answerWith({ assets: ['dome', '', 42, null, { id: 'sky' }, 'turret'] });
    expect(await loadArtIndex()).toEqual(['dome', 'turret']);
  });

  it('draws rectangles instead of throwing when there is no index at all', async () => {
    answerWith({}, false);
    expect(await loadArtIndex()).toEqual(NO_ART);
  });

  it('draws rectangles when the index is not an object, or has no list in it', async () => {
    answerWith('nope');
    expect(await loadArtIndex()).toEqual(NO_ART);
    answerWith(null);
    expect(await loadArtIndex()).toEqual(NO_ART);
    answerWith({ assets: 'dome' });
    expect(await loadArtIndex()).toEqual(NO_ART);
  });

  it('draws rectangles when the page is offline', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await loadArtIndex()).toEqual(NO_ART);
  });
});
