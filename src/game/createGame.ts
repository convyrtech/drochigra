import Phaser from 'phaser';
import type { Balance } from '../sim/balance.js';
import { COLORS, VIEW } from './layout.js';
import { MainScene } from './MainScene.js';

/** Portrait canvas, scaled to fit any screen and centred. */
export function createGame(parent: string, balance: Balance): Phaser.Game {
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
    scene: [new MainScene(balance)],
  });
}
