import Phaser from 'phaser';
import { artUrl, type ArtIndex } from './artIds.js';

/**
 * The three things a Phaser scene does with the art: ask for it, sharpen it,
 * and check whether a particular sprite is there at all. The catalogue itself
 * and the index of what was generated live in `artIds.ts`, which knows nothing
 * about Phaser.
 *
 * Re-exported here so a drawing site needs one import, not two.
 */
export { ART, NO_ART, artUrl, loadArtIndex } from './artIds.js';
export type { ArtIndex } from './artIds.js';

/** Queues every sprite of the index. Call from a scene's `preload`. */
export function queueArt(scene: Phaser.Scene, index: ArtIndex): void {
  for (const id of index) {
    if (!scene.textures.exists(id)) {
      scene.load.image(id, artUrl(id));
    }
  }
}

/**
 * Nearest-neighbour filtering for the loaded sprites. Pixel art blurs into mush
 * under the default linear filter: one 64-pixel tile is drawn across a whole
 * 65-pixel cell and then the whole canvas is scaled again to fit the phone.
 *
 * It is set per texture rather than through Phaser's `pixelArt: true`, which
 * would also turn off antialiasing for the text — and the text is not pixel art.
 */
export function sharpenArt(scene: Phaser.Scene, index: ArtIndex): void {
  for (const id of index) {
    if (scene.textures.exists(id)) {
      scene.textures.get(id).setFilter(Phaser.Textures.FilterMode.NEAREST);
    }
  }
}

/** Is this sprite loaded and usable? The one question every drawing site asks. */
export function hasArt(scene: Phaser.Scene, id: string): boolean {
  return scene.textures.exists(id);
}
