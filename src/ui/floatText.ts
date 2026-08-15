import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';

/**
 * Floating reward numbers: «+14» in scrap colour or «+1✦» in crystal colour,
 * spawned at a cell, rising and fading in a few hundred milliseconds.
 *
 * Purely cosmetic — nothing here reads or writes the simulation. To keep a busy
 * dig from allocating and destroying a text per cell (issue #8 performance),
 * this is a pool of `VIEW.floatText.poolSize` pre-created texts that are cycled
 * and re-targeted: a new number stops the previous flight of the same slot and
 * takes its place. The number of numbers on screen at once is bounded by the
 * pool, so the display list never grows with rapid digging.
 */

/** How high the number rises and how long it lingers, in pixels/ms of VIEW. */
const RISE = 40;
const DURATION = 600;

interface FloatSlot {
  readonly label: Phaser.GameObjects.Text;
  tween: Phaser.Tweens.Tween | null;
}

export interface FloatTextLayer {
  /**
   * Show a number flying up out of a point in world coordinates (the cell that
   * was just dug). `depth` is the layer it sits on, above the cells.
   */
  readonly show: (x: number, y: number, text: string, color: number, depth: number) => void;
}

export function createFloatTextLayer(scene: Phaser.Scene): FloatTextLayer {
  const slots: FloatSlot[] = [];
  for (let i = 0; i < VIEW.floatText.poolSize; i += 1) {
    const label = scene.add
      .text(0, 0, '', {
        fontFamily: FONT_FAMILY,
        fontSize: VIEW.font.small,
        color: cssColor(COLORS.text),
        stroke: cssColor(COLORS.shaft),
        strokeThickness: 4,
      })
      .setOrigin(0.5, 0.5)
      .setVisible(false);
    slots.push({ label, tween: null });
  }

  // Oldest-first: a burst of digs cycles through the pool so an already-fading
  // number is the first one re-used.
  let cursor = 0;

  return {
    show(x, y, text, color, depth): void {
      // The pool is fully populated and cursor wraps in bounds, so the indexed
      // access is always a live slot.
      const slot = slots[cursor]!;
      cursor = (cursor + 1) % slots.length;
      slot.tween?.stop();
      slot.tween = null;

      const label = slot.label;
      label
        .setText(text)
        .setColor(cssColor(color))
        .setPosition(x, y)
        .setDepth(depth)
        .setAlpha(1)
        .setVisible(true);

      slot.tween = scene.tweens.add({
        targets: label,
        y: y - RISE,
        alpha: 0,
        duration: DURATION,
        ease: Phaser.Math.Easing.Cubic.Out,
        onComplete: () => {
          slot.tween = null;
          label.setVisible(false);
        },
      });
    },
  };
}
