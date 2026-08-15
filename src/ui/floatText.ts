import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';

/**
 * A floating reward number: «+14» in scrap colour or «+1✦» in crystal colour,
 * spawned at a cell, rising and fading in a few hundred milliseconds, then gone.
 *
 * Purely cosmetic — nothing here reads or writes the simulation. Each call makes
 * one short-lived text that destroys itself, so the scene never grows.
 */

/** How high the number rises and how long it lingers, in pixels/ms of VIEW. */
const RISE = 40;
const DURATION = 600;

/**
 * Show a number flying up out of a point in world coordinates (the cell that was
 * just dug). `depth` is the layer it sits on, above the cells.
 */
export function showFloatText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  color: number,
  depth: number,
): void {
  const label = scene.add
    .text(x, y, text, {
      fontFamily: FONT_FAMILY,
      fontSize: VIEW.font.small,
      color: cssColor(color),
      stroke: cssColor(COLORS.shaft),
      strokeThickness: 4,
    })
    .setOrigin(0.5, 0.5)
    .setDepth(depth);

  scene.tweens.add({
    targets: label,
    y: y - RISE,
    alpha: 0,
    duration: DURATION,
    ease: Phaser.Math.Easing.Cubic.Out,
    onComplete: () => {
      label.destroy();
    },
  });
}
