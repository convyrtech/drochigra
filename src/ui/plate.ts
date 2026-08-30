import Phaser from 'phaser';
import { ART, hasArt } from '../game/artTextures.js';
import { VIEW } from '../game/layout.js';

/**
 * The steel a button is faced with, and the plate an upgrade row is written on.
 *
 * Both are the same idea: the drawn rectangle stays exactly where it is and goes
 * on saying what it said — blue when the price can be paid, dark when it cannot,
 * cyan-edged when the checkpoint is picked — and the sprite is laid over or
 * under it. So a missing PNG costs the screen nothing at all: `null` comes back,
 * nothing is added to the display list, and the rectangle is the whole button
 * again. That is the fallback, and it is structural rather than a colour trick:
 * there is no second code path to keep in step.
 *
 * `button-face` is **tiled**, never stretched. The game draws it at nine sizes,
 * from a 90-pixel checkpoint chip to the 672-pixel «НАЧАТЬ СМЕНУ»; one picture
 * stretched over all nine is a different material on every screen, while a tile
 * is one texture pixel per design pixel wherever it is laid.
 */

/** Anything these helpers add to a screen. Pinned and depth-sorted by the caller. */
export type PlatePart = Phaser.GameObjects.TileSprite | Phaser.GameObjects.Image;

/**
 * Faces a button with steel, or does nothing when the sprite is not there.
 *
 * Call it **after** the button's own rectangle and **before** its label: the
 * face is translucent, so the colour of the rectangle reads through it and the
 * text stays on top of both.
 */
export function faceButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
): Phaser.GameObjects.TileSprite | null {
  if (!hasArt(scene, ART.buttonFace)) {
    return null;
  }
  return scene.add
    .tileSprite(x, y, width, height, ART.buttonFace)
    .setOrigin(0, 0)
    .setTint(VIEW.plate.faceTint)
    .setAlpha(VIEW.plate.faceAlpha);
}

/** The same, for a rectangle that is already drawn where it belongs. */
export function faceButtonRect(
  scene: Phaser.Scene,
  rect: Phaser.GameObjects.Rectangle,
): Phaser.GameObjects.TileSprite | null {
  return faceButton(scene, rect.x, rect.y, rect.width, rect.height);
}

/**
 * One sprite drawn at one size, or `null`. Every picture on these screens goes
 * through here so that «no PNG, no object» is written once.
 */
export function artImage(
  scene: Phaser.Scene,
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Phaser.GameObjects.Image | null {
  if (!hasArt(scene, id)) {
    return null;
  }
  return scene.add.image(x, y, id).setOrigin(0, 0).setDisplaySize(width, height);
}

/** The same, anchored on its own centre — for a badge, a heap or a stamp. */
export function artImageCentred(
  scene: Phaser.Scene,
  id: string,
  centreX: number,
  centreY: number,
  width: number,
  height: number,
): Phaser.GameObjects.Image | null {
  if (!hasArt(scene, id)) {
    return null;
  }
  return scene.add.image(centreX, centreY, id).setOrigin(0.5, 0.5).setDisplaySize(width, height);
}
