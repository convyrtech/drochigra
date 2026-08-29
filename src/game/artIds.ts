/**
 * The catalogue of the game's pixel art: which sprites exist as ids, and which
 * of them were actually generated.
 *
 * Deliberately free of Phaser, so the ids can be checked against
 * `scripts/art/manifest.json` by a plain unit test — that seam is the one thing
 * nothing else guards. Everything that needs a scene lives in `artTextures.ts`.
 *
 * Sprites are generated offline by `scripts/art/generate.mjs` into
 * `content/art/`, which is Vite's publicDir — so a finished PNG is served as
 * `./art/<id>.png` and copied into `dist/` without anything else changing. The
 * key that generates them never gets near the bundle: it has no `VITE_` prefix,
 * so Vite refuses to hand it to the client, and the game only ever loads the
 * finished files.
 *
 * **A missing sprite is a normal state, not a failure.** The art is bought a
 * generation at a time and the budget runs out; the game has to look right in
 * the middle of that, so every drawing site asks `hasArt` and keeps its old
 * rectangle when the answer is no. Nothing here throws, and nothing here is
 * required for the game to run.
 *
 * The list of what exists travels with the art in `content/art/index.json`
 * rather than being probed at runtime: a request for a file that is not there
 * is a 404, a 404 is a console error in the browser, and the e2e smoke test
 * counts console errors. So the game only asks for what the index names.
 */

/** Ids of every sprite the game knows how to use. Same names as the manifest. */
export const ART = {
  /** Rock face, one per layer of `balance.layers`, in the same order. */
  rockByLayer: ['rock-l1', 'rock-l2', 'rock-l3'],
  /** An opened cell. */
  tunnel: 'tunnel',
  /** The entrance row — the lift deck on the surface. */
  surface: 'surface',
  drill: 'drill',
  /** The station shell, anchored bottom-centre on the dome base line. */
  dome: 'dome',
  turret: 'turret',
  /** Keys of `balance.enemies` to their sprites. */
  enemyByType: {
    aberration: 'enemy-aberration',
    drowned: 'enemy-drowned',
    moth: 'enemy-moth',
  } as Record<string, string>,
  crystal: 'crystal',
  scrap: 'scrap',
  /** Backdrop of the dome zone: the polar night behind the station. */
  sky: 'sky',
} as const;

/** Sprite ids that are actually on disk, in the order the index lists them. */
export type ArtIndex = readonly string[];

/** Nothing generated yet: every drawing site falls back to its rectangle. */
export const NO_ART: ArtIndex = [];

export function artUrl(id: string): string {
  return `${import.meta.env.BASE_URL}art/${id}.png`;
}

/**
 * Reads `content/art/index.json`, served as `./art/index.json`.
 *
 * Never throws and never rejects: a missing index, a broken index or an offline
 * fetch all mean the same thing — no art this run, draw the rectangles.
 */
export async function loadArtIndex(): Promise<ArtIndex> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}art/index.json`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return NO_ART;
    }
    const raw: unknown = await response.json();
    if (typeof raw !== 'object' || raw === null) {
      return NO_ART;
    }
    const assets = (raw as { assets?: unknown }).assets;
    if (!Array.isArray(assets)) {
      return NO_ART;
    }
    return assets.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return NO_ART;
  }
}
