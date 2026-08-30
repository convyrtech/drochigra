import Phaser from 'phaser';
import { ART } from '../game/artTextures.js';
import {
  COLORS,
  cssColor,
  FONT_FAMILY,
  PAPER_INK,
  SCREEN_INK,
  VIEW,
} from '../game/layout.js';
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
import { artImage, artImageCentred, faceButtonRect } from './plate.js';
import { makeTapTarget } from './tapTarget.js';

/**
 * The bottom of the Abyss is dug: row `shift.grid_depth` is reached, the city is
 * found, the five-year plan is closed and the next one starts (PLAN_V1 §5).
 *
 * Shown after the shift report — first the paperwork, then the triumph — and it
 * is the only way into the next plan, so it says honestly what the next plan
 * changes: the waves get tougher, the ore gets richer, everything bought stays
 * and the depth starts from zero.
 *
 * Same station paper as the report (src/ui/shiftReport.ts) — literally the same
 * sprite at the same size, under the same printed masthead, with the same badge
 * and the same rubber stamp — so the two screens read as two pages of one file.
 * The ink follows the ground the same way it does there: `PAPER_INK` on the
 * blank, the old light colours on the dark panel when there is no blank.
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
  const sheet = artImage(scene, ART.paper, panelX, panelY, box.panelWidth, box.panelHeight);
  const panel =
    sheet ??
    scene.add
      .rectangle(panelX, panelY, box.panelWidth, box.panelHeight, COLORS.panel)
      .setOrigin(0, 0)
      .setStrokeStyle(3, COLORS.buttonEdge);
  const ink = sheet ? PAPER_INK : SCREEN_INK;

  // The printed masthead the title is set in: on the blank it is the only place
  // light text can stand, and on the dark panel it is simply a band.
  const headerBand = scene.add
    .rectangle(panelX, panelY, box.panelWidth, box.headerHeight, COLORS.dome)
    .setOrigin(0, 0);
  const headerEdge = scene.add
    .rectangle(panelX, panelY + box.headerHeight, box.panelWidth, box.ruleHeight, COLORS.buttonEdge)
    .setOrigin(0, 0);
  const emblem = artImage(
    scene,
    ART.emblem,
    panelX + box.pad,
    panelY + box.emblemY,
    box.emblemSize,
    box.emblemSize,
  );

  // Beside the badge, like the report's masthead, and one size down from the
  // headline it was: at `font.huge` and centred it sat on top of the badge.
  const title = left(
    scene,
    panelX + box.pad + (emblem ? box.emblemSize + box.emblemGap : 0),
    panelY + box.titleTop,
    'ГОРОД НАЙДЕН',
    font.large,
    COLORS.crystal,
  );
  const stamp = centered(
    scene,
    width / 2,
    panelY + box.stampTop,
    `ПЯТИЛЕТКА ${profile.fiveYearPlan} ЗАКРЫТА · ДНО БЕЗДНЫ ВСКРЫТО`,
    font.small,
    ink.dim,
  );

  const depthRow = centered(
    scene,
    width / 2,
    panelY + box.depthTop,
    String(balance.shift.grid_depth),
    font.huge,
    ink.good,
  );
  const depthUnit = centered(
    scene,
    width / 2,
    panelY + box.depthUnitTop,
    `РЯД · ${lastLayerName(balance)} ПРОЙДЕН НАСКВОЗЬ`,
    font.tiny,
    ink.dim,
  );

  const rows: readonly (readonly [string, string, number])[] = [
    ...resourceIds(balance).map(
      (id) =>
        [
          `Итог · ${resourceName(balance, id).toLowerCase()} в кассе`,
          String(walletAmount(profile, id)),
          // The rare currency is the bright one, the way the report colours it.
          balance.resources[id]?.premium === true ? ink.crystal : ink.scrap,
        ] as const,
    ),
    ['Итог · рекорд смены', String(profile.bestShiftScrap), ink.text],
    ['Итог · куплено уровней', String(totalLevels(balance, profile)), ink.text],
  ];

  const rowParts: (Phaser.GameObjects.Rectangle | Phaser.GameObjects.Text)[] = [];
  rows.forEach(([label, value, color], index) => {
    const rowY = panelY + box.rowsTop + box.rowHeight * index;
    rowParts.push(
      left(scene, panelX + box.pad, rowY, label, font.small, ink.dim),
      right(scene, panelX + box.panelWidth - box.pad, rowY, value, font.medium, color),
      scene.add
        .rectangle(
          panelX + box.pad,
          rowY + box.rowHeight - box.ruleHeight,
          box.panelWidth - box.pad * 2,
          box.ruleHeight,
          ink.rule,
        )
        .setOrigin(0, 0),
    );
  });

  // What the next plan does, in the order the player will feel it. The numbers
  // are the prestige multipliers of balance.json, written out as they are.
  const promises: readonly (readonly [string, number])[] = [
    [`Волны крепче: здоровье ×${balance.prestige.wave_hp_mult_per_tier}`, ink.warn],
    [`Руда богаче: лом с клетки ×${balance.prestige.yield_mult_per_tier}`, ink.scrap],
    ['Прокачка и касса остаются при тебе', ink.text],
    ['Ствол засыпан: глубина снова с нуля', ink.dim],
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

  // The stamp goes where nothing is written: right of the promises, above the
  // button that starts the next plan.
  const stampArt = artImageCentred(
    scene,
    ART.stamp,
    panelX + box.panelWidth - box.stampRightPad - box.stampSize / 2,
    panelY + box.panelHeight - box.stampBottom,
    box.stampSize,
    box.stampSize,
  );
  stampArt?.setRotation(0.12);

  const buttonX = (width - box.buttonWidth) / 2;
  const buttonY = panelY + box.panelHeight - box.buttonBottom - box.buttonHeight;
  const button = scene.add
    .rectangle(buttonX, buttonY, box.buttonWidth, box.buttonHeight, COLORS.button)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge);
  const buttonFace = faceButtonRect(scene, button);
  const buttonText = centered(
    scene,
    buttonX + box.buttonWidth / 2,
    buttonY + box.buttonHeight / 2,
    `НАЧАТЬ ПЯТИЛЕТКУ ${profile.fiveYearPlan + 1}`,
    font.medium,
    COLORS.text,
  ).setOrigin(0.5, 0.5);

  type PinnedPart =
    | Phaser.GameObjects.Rectangle
    | Phaser.GameObjects.Text
    | Phaser.GameObjects.Image
    | Phaser.GameObjects.TileSprite;
  const parts: PinnedPart[] = [
    shade,
    panel,
    headerBand,
    headerEdge,
    ...(emblem ? [emblem] : []),
    title,
    stamp,
    depthRow,
    depthUnit,
    ...rowParts,
    ...promiseParts,
    ...(stampArt ? [stampArt] : []),
    button,
    ...(buttonFace ? [buttonFace] : []),
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
  makeTapTarget(button, () => {
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
