import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';
import type { LayerBalance } from '../sim/balance.js';

/**
 * The banner that announces a new layer of the Abyss (PLAN_V1 §5). The rock
 * already changes colour and the layer already sends a new kind of enemy, but
 * neither says out loud that the drill has crossed a border — this does: the
 * number and the name of the layer, with the two numbers that make it different,
 * float up over the shaft and fade out.
 *
 * View only: which layer has already been announced is the scene's business, and
 * the layer itself comes from balance.layers. Nothing here is a game number.
 */
export interface LayerBannerOptions {
  readonly width: number;
  /** Top of the strip, in world pixels of the screen: under the dome zone. */
  readonly top: number;
  readonly depth: number;
  /** Index of the layer in balance.layers: the number on the banner is it plus one. */
  readonly index: number;
  readonly layer: LayerBalance;
}

/** Roman numerals for the layer number. Beyond the list a digit is honest enough. */
const ROMAN: readonly string[] = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

export function showLayerBanner(scene: Phaser.Scene, options: LayerBannerOptions): void {
  const { width, top, depth, index, layer } = options;
  const { layerBanner: box, font } = VIEW;

  const panelX = (width - box.panelWidth) / 2;
  const panel = scene.add
    .rectangle(panelX, top, box.panelWidth, box.panelHeight, COLORS.dome, box.panelAlpha)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.domeEdge);

  const numeral = ROMAN[index] ?? String(index + 1);
  const title = centered(
    scene,
    width / 2,
    top + box.titleTop,
    `СЛОЙ ${numeral} · ${layer.name.toUpperCase()}`,
    font.medium,
    COLORS.text,
  );
  // The two numbers the player feels the moment the drill bites into the layer:
  // how long a cell takes and what it pays. Both come straight from balance.
  const detail = centered(
    scene,
    width / 2,
    top + box.detailTop,
    `ПОРОДА ${layer.hardness_sec} С/КЛЕТКА · ЛОМ ${Math.round(layer.yield)} С КЛЕТКИ`,
    font.tiny,
    COLORS.textDim,
  );

  const parts: (Phaser.GameObjects.Rectangle | Phaser.GameObjects.Text)[] = [panel, title, detail];
  for (const part of parts) {
    part.setScrollFactor(0).setDepth(depth).setAlpha(0);
  }

  // Rises into place, holds long enough to be read, then leaves.
  scene.tweens.add({
    targets: parts,
    y: `-=${box.rise}`,
    alpha: 1,
    duration: box.riseMs,
    ease: Phaser.Math.Easing.Cubic.Out,
    onComplete: () => {
      scene.tweens.add({
        targets: parts,
        alpha: 0,
        delay: box.holdMs,
        duration: box.fadeMs,
        ease: Phaser.Math.Easing.Sine.In,
        onComplete: () => {
          for (const part of parts) {
            part.destroy();
          }
        },
      });
    },
  });
}

function centered(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  fontSize: string,
  color: number,
): Phaser.GameObjects.Text {
  return scene.add
    .text(x, y, text, { fontFamily: FONT_FAMILY, fontSize, color: cssColor(color) })
    .setOrigin(0.5, 0);
}
