import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';
import { SFX } from '../game/sfx.js';
import type { Balance } from '../sim/balance.js';
import { resourceName, scrapId, type HangarHarvest } from '../sim/progress.js';
import { makeTapTarget } from './tapTarget.js';

/**
 * The screen that greets a returning player: what the hangar made while the game
 * was closed, how long it worked for, and one button that takes it (PLAN_V1 §7).
 * Shown only when there is something to take — an empty hangar says nothing and
 * the base opens straight away.
 *
 * Taking it has to feel like getting paid, so the number flies up and the panel
 * shakes before the base appears. Sound is task #7 and is not touched here.
 *
 * Every part is pinned with scrollFactor 0 and put on one depth, like the report.
 */
export interface HangarScreenOptions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly balance: Balance;
  readonly harvest: HangarHarvest;
  /** Called once the collection animation is over: the scrap is already banked. */
  readonly onCollect: () => void;
}

export function createHangarScreen(scene: Phaser.Scene, options: HangarScreenOptions): void {
  const { width, height, depth, balance, harvest, onCollect } = options;
  const { hangar: box, font } = VIEW;

  const shade = scene.add.rectangle(0, 0, width, height, COLORS.shaft, 0.9).setOrigin(0, 0);

  const panelX = (width - box.panelWidth) / 2;
  const panelY = (height - box.panelHeight) / 2;
  const panel = scene.add
    .rectangle(panelX, panelY, box.panelWidth, box.panelHeight, COLORS.panel)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.domeEdge);

  const title = centered(scene, width / 2, panelY + box.titleTop, 'АНГАР РАБОТАЛ БЕЗ ТЕБЯ', font.large, COLORS.text);
  const stamp = centered(
    scene,
    width / 2,
    panelY + box.stampTop,
    `СМЕНА В ОТСУТСТВИЕ · ${formatHours(harvest.hours)}`,
    font.small,
    COLORS.textDim,
  );

  const scrapLabel = resourceName(balance, scrapId(balance)).toUpperCase();
  const amount = centered(
    scene,
    width / 2,
    panelY + box.amountTop,
    `+${harvest.scrap}`,
    font.huge,
    COLORS.scrap,
  );
  const amountUnit = centered(
    scene,
    width / 2,
    panelY + box.amountTop + box.lineHeight * 2,
    scrapLabel,
    font.medium,
    COLORS.scrap,
  );

  const lines: readonly (readonly [string, number])[] = [
    [`Заполнение ангара: ${Math.round(harvest.fillShare * 100)}%`, COLORS.textDim],
    [`Потолок простоя: ${formatHours(balance.offline.cap_hours)}`, COLORS.textDim],
    ['Ангар не копает глубже — только лом', COLORS.textDim],
  ];
  const lineObjects = lines.map(([text, color], index) =>
    centered(scene, width / 2, panelY + box.linesTop + box.lineHeight * index, text, font.small, color),
  );

  const buttonX = (width - box.buttonWidth) / 2;
  const buttonY = panelY + box.panelHeight - box.buttonBottom - box.buttonHeight;
  const button = scene.add
    .rectangle(buttonX, buttonY, box.buttonWidth, box.buttonHeight, COLORS.button)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge);
  const buttonText = centered(
    scene,
    buttonX + box.buttonWidth / 2,
    buttonY + box.buttonHeight / 2,
    'ЗАБРАТЬ',
    font.large,
    COLORS.text,
  ).setOrigin(0.5, 0.5);

  const parts: (Phaser.GameObjects.Rectangle | Phaser.GameObjects.Text)[] = [
    shade,
    panel,
    title,
    stamp,
    amount,
    amountUnit,
    ...lineObjects,
    button,
    buttonText,
  ];
  for (const part of parts) {
    part.setScrollFactor(0).setDepth(depth);
  }

  // The pile breathes until it is taken, so the eye goes to the number first.
  const breathe = scene.tweens.add({
    targets: amount,
    scale: box.idlePulseScale,
    duration: box.idlePulseMs,
    yoyo: true,
    repeat: -1,
    ease: Phaser.Math.Easing.Sine.InOut,
  });

  let taken = false;
  makeTapTarget(button, () => {
    if (taken) {
      return;
    }
    taken = true;
    button.disableInteractive();
    breathe.stop();
    amount.setScale(1);
    // Taking the pile is a gesture: unlock the context and ring it in.
    SFX.unlock();
    SFX.hangarCollect();

    // The panel takes the hit and the number flies out of it: the payment is
    // something that happens, not a screen that quietly disappears.
    scene.tweens.add({
      targets: [panel, title, stamp, amountUnit, ...lineObjects, button, buttonText],
      x: `+=${box.shakeOffset}`,
      duration: box.shakeMs,
      yoyo: true,
      repeat: 2,
      ease: Phaser.Math.Easing.Sine.InOut,
    });
    scene.tweens.add({
      targets: amount,
      y: amount.y - box.collectRise,
      alpha: 0,
      scale: box.idlePulseScale,
      duration: box.collectRiseMs,
      ease: Phaser.Math.Easing.Cubic.Out,
      onComplete: () => {
        scene.time.delayedCall(box.collectHoldMs, () => {
          for (const part of parts) {
            part.destroy();
          }
          onCollect();
        });
      },
    });
  });
}

/** «4 ч 30 мин» — hours the way a form would write them, minutes never lost. */
function formatHours(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (wholeHours <= 0) {
    return `${minutes} мин`;
  }
  if (minutes === 0) {
    return `${wholeHours} ч`;
  }
  return `${wholeHours} ч ${minutes} мин`;
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
