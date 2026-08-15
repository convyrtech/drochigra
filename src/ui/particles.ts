import Phaser from 'phaser';
import { COLORS, VIEW } from '../game/layout.js';

/**
 * A pooled burst of rock chips when a cell opens (issue #8 performance).
 *
 * Pure view: it paints only, never reads or writes the simulation. The old code
 * created and destroyed six rectangles per dig, which churned the display list
 * under rapid digging and risked frame-time spikes. Instead the pool is created
 * once per scene (`VIEW.particles.poolSize` rectangles) and reused; a burst
 * runs a tween on whichever chips are free, and a finished chip is returned to
 * the pool to fly again. When every chip is already busy the burst is skipped —
 * the pool is a hard cap, so an uncovered dig never has to pay for new objects.
 *
 * Not in content/balance.json on purpose: this is layout / performance tuning,
 * not a game number (AGENTS.md).
 */

interface Chip {
  readonly rect: Phaser.GameObjects.Rectangle;
  busy: boolean;
  tween: Phaser.Tweens.Tween | null;
}

export interface ChipPool {
  /**
   * Send a short spray of chips out of a point in world coordinates (the cell
   * that just opened). `size` is the cell size used to scale the chips.
   */
  readonly burst: (x: number, y: number, size: number) => void;
}

export function createChipPool(scene: Phaser.Scene, depth: number): ChipPool {
  const { poolSize, burstCount } = VIEW.particles;
  const chips: Chip[] = [];
  for (let i = 0; i < poolSize; i += 1) {
    const rect = scene.add.rectangle(0, 0, 1, 1, COLORS.scrap).setVisible(false).setDepth(depth);
    chips.push({ rect, busy: false, tween: null });
  }

  return {
    burst(x, y, size): void {
      for (let i = 0; i < burstCount; i += 1) {
        const chip = chips.find((candidate) => !candidate.busy);
        if (!chip) {
          // Every chip is mid-flight: skip the rest of this burst rather than
          // allocate. A future dig will have chips free again.
          return;
        }
        chip.busy = true;
        chip.tween?.stop();
        const rect = chip.rect;
        rect
          .setPosition(x + (Math.random() - 0.5) * size * 0.5, y + (Math.random() - 0.5) * size * 0.5)
          .setSize(
            size * (0.08 + Math.random() * 0.08),
            size * (0.08 + Math.random() * 0.08),
          )
          .setFillStyle(Math.random() < 0.3 ? COLORS.scrap : COLORS.progress)
          .setRotation(0)
          .setAlpha(1)
          .setVisible(true);
        const angle = Math.random() * Math.PI * 2;
        const dist = size * (0.3 + Math.random() * 0.6);
        const spin = Math.random() * 180 - 90;
        chip.tween = scene.tweens.add({
          targets: rect,
          x: rect.x + Math.cos(angle) * dist,
          y: rect.y + Math.sin(angle) * dist,
          alpha: 0,
          angle: spin,
          duration: 280 + Math.random() * 140,
          ease: Phaser.Math.Easing.Quadratic.Out,
          onComplete: () => {
            chip.busy = false;
            chip.tween = null;
            rect.setVisible(false);
          },
        });
      }
    },
  };
}
