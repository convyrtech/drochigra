import Phaser from 'phaser';
import type { Balance } from '../sim/balance.js';
import { COLORS } from '../game/layout.js';

/**
 * Title and balance-loaded confirmation inside the dome zone.
 * Temporary for the frame step: proves content/balance.json is actually read.
 */
export function createDomeStatus(
  scene: Phaser.Scene,
  balance: Balance,
  centerX: number,
  centerY: number,
): void {
  scene.add
    .text(centerX, centerY, 'ВОСТОК-9', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '64px',
      color: Phaser.Display.Color.IntegerToColor(COLORS.text).rgba,
    })
    .setOrigin(0.5);

  const layers = balance.layers.length;
  const rows = balance.shift.grid_depth;
  scene.add
    .text(centerX, centerY + 70, `Баланс загружен: ${rows} рядов, слоёв ${layers}`, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '28px',
      color: Phaser.Display.Color.IntegerToColor(COLORS.textDim).rgba,
    })
    .setOrigin(0.5);
}
