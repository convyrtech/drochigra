import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';
import type { ShiftReport } from '../sim/shift.js';

/**
 * End of shift screen: what the shift produced and one button to start a new
 * one. Deliberately plain — there is no saving between shifts yet.
 *
 * Every part is pinned to the screen with scrollFactor 0, the same way the HUD
 * is: that keeps the button's hit area under the button while the shaft is
 * scrolled away from the origin.
 */
export interface ShiftReportOptions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly maxDepthRow: number;
  readonly onNewShift: () => void;
}

export function createShiftReport(
  scene: Phaser.Scene,
  report: ShiftReport,
  options: ShiftReportOptions,
): void {
  const { width, height, depth, maxDepthRow, onNewShift } = options;
  const { report: box, font } = VIEW;

  const shade = scene.add.rectangle(0, 0, width, height, COLORS.shaft, 0.86).setOrigin(0, 0);

  const panelX = (width - box.panelWidth) / 2;
  const panelY = (height - box.panelHeight) / 2;
  const panel = scene.add
    .rectangle(panelX, panelY, box.panelWidth, box.panelHeight, COLORS.panel)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.domeEdge);

  const title = scene.add
    .text(width / 2, panelY + box.titleTop, 'СМЕНА ОКОНЧЕНА', {
      fontFamily: FONT_FAMILY,
      fontSize: font.large,
      color: cssColor(COLORS.text),
    })
    .setOrigin(0.5, 0);

  const lines: readonly (readonly [string, number])[] = [
    [`Добыто лома: ${report.mined}`, COLORS.scrap],
    [`Сдано лома: ${report.banked}`, COLORS.scrap],
    [`Глубина: ${report.deepestRow} из ${maxDepthRow}`, COLORS.text],
    [`Кристаллы: ${report.crystals}`, COLORS.crystal],
  ];
  const lineObjects = lines.map(([text, color], index) =>
    scene.add
      .text(width / 2, panelY + box.linesTop + box.lineHeight * index, text, {
        fontFamily: FONT_FAMILY,
        fontSize: font.medium,
        color: cssColor(color),
      })
      .setOrigin(0.5, 0),
  );

  const buttonX = (width - box.buttonWidth) / 2;
  const buttonY = panelY + box.panelHeight - box.buttonBottom - box.buttonHeight;
  const button = scene.add
    .rectangle(buttonX, buttonY, box.buttonWidth, box.buttonHeight, COLORS.button)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge)
    .setInteractive({ useHandCursor: true });
  button.on(Phaser.Input.Events.POINTER_DOWN, onNewShift);

  const buttonText = scene.add
    .text(buttonX + box.buttonWidth / 2, buttonY + box.buttonHeight / 2, 'Новая смена', {
      fontFamily: FONT_FAMILY,
      fontSize: font.medium,
      color: cssColor(COLORS.text),
    })
    .setOrigin(0.5);

  for (const part of [shade, panel, title, ...lineObjects, button, buttonText]) {
    part.setScrollFactor(0).setDepth(depth);
  }
}
