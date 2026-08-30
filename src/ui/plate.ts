import Phaser from 'phaser';
import { hasArt } from '../game/artTextures.js';

/**
 * One sprite drawn at one size, or nothing at all.
 *
 * Every picture on the screens between the shifts goes through here so that «no
 * PNG, no object» is written once. The drawn rectangle underneath stays exactly
 * where it is and goes on saying what it said — blue when a button can be
 * pressed, dark when it cannot, cyan-edged when a checkpoint is picked — and the
 * sprite is laid over or under it. So a missing PNG costs the screen nothing:
 * `null` comes back, nothing is added to the display list, and the rectangle is
 * the whole thing again. That is the fallback, and it is structural rather than
 * a colour trick: there is no second code path to keep in step.
 *
 * There used to be a `faceButton` here as well, tiling a steel sprite over every
 * button of the game. Both it and the sprite are gone: the tile was not seamless
 * — rivets on two edges of four and a light diagonal band across it — so it drew
 * a grid every 64 pixels and a chequerboard of quarters over every button in the
 * game. The buttons read better bare.
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
