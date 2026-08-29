import Phaser from 'phaser';
import type { Balance } from '../sim/balance.js';
import { NO_ART, type ArtIndex } from './artTextures.js';
import { COLORS, VIEW } from './layout.js';
import { MainScene } from './MainScene.js';

/**
 * Portrait canvas, scaled to fit any screen and centred.
 *
 * `art` is the list of sprites that exist (`content/art/index.json`). It is
 * empty until the first ones are generated, and the scene draws its rectangles
 * instead — so the game runs unchanged with no art at all.
 */
export function createGame(parent: string, balance: Balance, art: ArtIndex = NO_ART): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: COLORS.shaft,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: VIEW.width,
      height: VIEW.height,
    },
    scene: [new MainScene(balance, art)],
  });
}
