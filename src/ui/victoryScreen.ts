import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';
import { SFX } from '../game/sfx.js';
import type { Balance } from '../sim/balance.js';
import {
  resourceIds,
  resourceName,
  upgradeIds,
  upgradeLevel,
  walletAmount,
  type Profile,
} from '../sim/progress.js';

/**
 * The bottom of the Abyss is dug: row `shift.grid_depth` is reached, the city is
 * found, the five-year plan is closed and the next one starts (PLAN_V1 §5).
 *
 * Shown after the shift report — first the paperwork, then the triumph — and it
 * is the only way into the next plan, so it says honestly what the next plan
 * changes: the waves get tougher, the ore gets richer, everything bought stays
 * and the depth starts from zero.
 *
 * Same station paper as the report (src/ui/shiftReport.ts): a header, the figure
 * the whole thing is about, the closed plan in ruled rows, and one wide button.
 * Every part is pinned with scrollFactor 0 and put on one depth.
 */
export interface VictoryScreenOptions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly balance: Balance;
  /** The profile as the closed plan leaves it, before `startNextPlan`. */
  readonly profile: Profile;
  /** Called once the animation is over: the caller starts the next plan. */
  readonly onNextPlan: () => void;
}

export function createVictoryScreen(scene: Phaser.Scene, options: VictoryScreenOptions): void {
  const { width, height, depth, balance, profile, onNextPlan } = options;
  const { victory: box, font } = VIEW;

  const shade = scene.add.rectangle(0, 0, width, height, COLORS.shaft, 0.9).setOrigin(0, 0);

  const panelX = (width - box.panelWidth) / 2;
  const panelY = (height - box.panelHeight) / 2;
  const panel = scene.add
    .rectangle(panelX, panelY, box.panelWidth, box.panelHeight, COLORS.panel)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge);

  const title = centered(scene, width / 2, panelY + box.titleTop, 'ГОРОД НАЙДЕН', font.huge, COLORS.crystal);
  const stamp = centered(
    scene,
    width / 2,
    panelY + box.stampTop,
    `ПЯТИЛЕТКА ${profile.fiveYearPlan} ЗАКРЫТА · ДНО БЕЗДНЫ ВСКРЫТО`,
    font.small,
    COLORS.textDim,
  );

  const depthRow = centered(
    scene,
    width / 2,
    panelY + box.depthTop,
    String(balance.shift.grid_depth),
    font.huge,
    COLORS.buttonEdge,
  );
  const depthUnit = centered(
    scene,
    width / 2,
    panelY + box.depthUnitTop,
    `РЯД · ${lastLayerName(balance)} ПРОЙДЕН НАСКВОЗЬ`,
    font.tiny,
    COLORS.textDim,
  );

  const rows: readonly (readonly [string, string, number])[] = [
    ...resourceIds(balance).map(
      (id) =>
        [
          `Итог · ${resourceName(balance, id).toLowerCase()} в кассе`,
          String(walletAmount(profile, id)),
          // The rare currency is the bright one, the way the report colours it.
          balance.resources[id]?.premium === true ? COLORS.crystal : COLORS.scrap,
        ] as const,
    ),
    ['Итог · рекорд смены', String(profile.bestShiftScrap), COLORS.text],
    ['Итог · куплено уровней', String(totalLevels(balance, profile)), COLORS.text],
  ];

  const rowParts: (Phaser.GameObjects.Rectangle | Phaser.GameObjects.Text)[] = [];
  rows.forEach(([label, value, color], index) => {
    const rowY = panelY + box.rowsTop + box.rowHeight * index;
    rowParts.push(
      left(scene, panelX + box.pad, rowY, label, font.small, COLORS.textDim),
      right(scene, panelX + box.panelWidth - box.pad, rowY, value, font.medium, color),
      scene.add
        .rectangle(
          panelX + box.pad,
          rowY + box.rowHeight - box.ruleHeight,
          box.panelWidth - box.pad * 2,
          box.ruleHeight,
          COLORS.dugEdge,
        )
        .setOrigin(0, 0),
    );
  });

  // What the next plan does, in the order the player will feel it. The numbers
  // are the prestige multipliers of balance.json, written out as they are.
  const promises: readonly (readonly [string, number])[] = [
    [`Волны крепче: здоровье ×${balance.prestige.wave_hp_mult_per_tier}`, COLORS.warning],
    [`Руда богаче: лом с клетки ×${balance.prestige.yield_mult_per_tier}`, COLORS.scrap],
    ['Прокачка и касса остаются при тебе', COLORS.text],
    ['Ствол засыпан: глубина снова с нуля', COLORS.textDim],
  ];
  const promiseParts = promises.map(([text, color], index) =>
    left(
      scene,
      panelX + box.pad,
      panelY + box.promisesTop + box.promiseHeight * index,
      text,
      font.small,
      color,
    ),
  );

  const buttonX = (width - box.buttonWidth) / 2;
  const buttonY = panelY + box.panelHeight - box.buttonBottom - box.buttonHeight;
  const button = scene.add
    .rectangle(buttonX, buttonY, box.buttonWidth, box.buttonHeight, COLORS.button)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge)
    .setInteractive({ useHandCursor: true });
  const buttonText = centered(
    scene,
    buttonX + box.buttonWidth / 2,
    buttonY + box.buttonHeight / 2,
    `НАЧАТЬ ПЯТИЛЕТКУ ${profile.fiveYearPlan + 1}`,
    font.medium,
    COLORS.text,
  ).setOrigin(0.5, 0.5);

  const parts: (Phaser.GameObjects.Rectangle | Phaser.GameObjects.Text)[] = [
    shade,
    panel,
    title,
    stamp,
    depthRow,
    depthUnit,
    ...rowParts,
    ...promiseParts,
    button,
    buttonText,
  ];
  for (const part of parts) {
    part.setScrollFactor(0).setDepth(depth);
  }

  // The triumph rings: a rising fanfare and a long pulse on devices that vibrate.
  SFX.unlock();
  SFX.victory();
  SFX.vibrate(400);

  // The paper comes in from below, the way the report does not: this screen is
  // the reward, so it moves.
  const moving = parts.filter((part) => part !== shade);
  for (const part of moving) {
    part.y += box.enterRise;
    part.setAlpha(0);
  }
  scene.tweens.add({
    targets: moving,
    y: `-=${box.enterRise}`,
    alpha: 1,
    duration: box.enterMs,
    ease: Phaser.Math.Easing.Cubic.Out,
  });

  // The row number breathes until the plan is closed, so the eye goes to it.
  const breathe = scene.tweens.add({
    targets: depthRow,
    scale: box.idlePulseScale,
    duration: box.idlePulseMs,
    yoyo: true,
    repeat: -1,
    delay: box.enterMs,
    ease: Phaser.Math.Easing.Sine.InOut,
  });

  let started = false;
  button.on(Phaser.Input.Events.POINTER_DOWN, () => {
    if (started) {
      return;
    }
    started = true;
    button.disableInteractive();
    breathe.stop();
    depthRow.setScale(1);
    scene.tweens.add({
      targets: parts,
      alpha: 0,
      duration: box.startFadeMs,
      ease: Phaser.Math.Easing.Sine.In,
      onComplete: () => {
        for (const part of parts) {
          part.destroy();
        }
        onNextPlan();
      },
    });
  });
}

/** Levels bought across every branch: one figure for the whole upgrade sheet. */
function totalLevels(balance: Balance, profile: Profile): number {
  return upgradeIds(balance).reduce((sum, id) => sum + upgradeLevel(profile, id), 0);
}

/** Name of the deepest layer of balance.layers: the one the bottom belongs to. */
function lastLayerName(balance: Balance): string {
  const layer = balance.layers[balance.layers.length - 1];
  return (layer?.name ?? '').toUpperCase();
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

function left(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  fontSize: string,
  color: number,
): Phaser.GameObjects.Text {
  return scene.add
    .text(x, y, text, { fontFamily: FONT_FAMILY, fontSize, color: cssColor(color) })
    .setOrigin(0, 0);
}

function right(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  fontSize: string,
  color: number,
): Phaser.GameObjects.Text {
  return scene.add
    .text(x, y, text, { fontFamily: FONT_FAMILY, fontSize, color: cssColor(color) })
    .setOrigin(1, 0);
}
