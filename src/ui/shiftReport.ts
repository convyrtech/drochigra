import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';
import type { ShiftOutcome } from '../sim/progress.js';
import type { ShiftReport } from '../sim/shift.js';

/**
 * End of shift screen: what the shift produced, what it did to the profile, and
 * one button back to the base (src/ui/baseScreen.ts), where the earnings are
 * spent. Everything shown here is already saved — the plan, the premium and the
 * new checkpoints come from the ShiftOutcome the base wrote to the profile.
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
  /** What the shift added to the profile. Already applied and saved. */
  readonly outcome: ShiftOutcome;
  readonly onBack: () => void;
}

export function createShiftReport(
  scene: Phaser.Scene,
  report: ShiftReport,
  options: ShiftReportOptions,
): void {
  const { width, height, depth, maxDepthRow, outcome, onBack } = options;
  const { report: box, font } = VIEW;

  const shade = scene.add.rectangle(0, 0, width, height, COLORS.shaft, 0.86).setOrigin(0, 0);

  const panelX = (width - box.panelWidth) / 2;
  const panelY = (height - box.panelHeight) / 2;
  const panel = scene.add
    .rectangle(panelX, panelY, box.panelWidth, box.panelHeight, COLORS.panel)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.domeEdge);

  const breach = report.endReason === 'breach';
  const title = scene.add
    .text(width / 2, panelY + box.titleTop, breach ? 'СМЕНА СОРВАНА' : 'СМЕНА ОКОНЧЕНА', {
      fontFamily: FONT_FAMILY,
      fontSize: font.large,
      color: cssColor(breach ? COLORS.warning : COLORS.text),
    })
    .setOrigin(0.5, 0);

  // The plan is a share of the best shift so far (PLAN_V1 §4), so the percent is
  // what the player reads to see whether the premium was earned.
  const quotaPercent = Math.round((outcome.quota > 0 ? report.banked / outcome.quota : 1) * 100);
  const planMet = report.banked >= outcome.quota;

  const lines: readonly (readonly [string, number])[] = [
    [`Добыто лома: ${report.mined}`, COLORS.scrap],
    [`Сдано лома: ${report.banked}`, COLORS.scrap],
    // A breach is the only way the cargo is ever lost, so this line only shows up then.
    ...(breach
      ? ([[`Потеряно в карго: ${report.mined - report.banked}`, COLORS.warning]] as const)
      : []),
    [
      `План ${outcome.quota} — выполнен на ${quotaPercent}%`,
      planMet ? COLORS.buttonEdge : COLORS.textDim,
    ],
    ...(outcome.bonusScrap > 0
      ? ([[`Премия за план: +${outcome.bonusScrap}`, COLORS.scrap]] as const)
      : []),
    [`Зачислено лома: ${outcome.scrapEarned}`, COLORS.scrap],
    ...(outcome.record ? ([['Новый рекорд смены', COLORS.buttonEdge]] as const) : []),
    [`Глубина: ${report.deepestRow} из ${maxDepthRow}`, COLORS.text],
    ...(outcome.newCheckpoints > 0
      ? ([
          [
            `Новых чекпоинтов: ${outcome.newCheckpoints} (+${outcome.checkpointCrystals} кристаллов)`,
            COLORS.crystal,
          ],
        ] as const)
      : []),
    [`Кристаллы: ${outcome.crystalsEarned}`, COLORS.crystal],
    [`Волн пришло: ${report.waves}`, COLORS.textDim],
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
  button.on(Phaser.Input.Events.POINTER_DOWN, onBack);

  const buttonText = scene.add
    .text(buttonX + box.buttonWidth / 2, buttonY + box.buttonHeight / 2, 'НА БАЗУ', {
      fontFamily: FONT_FAMILY,
      fontSize: font.medium,
      color: cssColor(COLORS.text),
    })
    .setOrigin(0.5);

  for (const part of [shade, panel, title, ...lineObjects, button, buttonText]) {
    part.setScrollFactor(0).setDepth(depth);
  }
}
