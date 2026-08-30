import Phaser from 'phaser';
import { hasArt } from '../game/artTextures.js';
import { VIEW } from '../game/layout.js';
import { SFX } from '../game/sfx.js';
import type { Balance } from '../sim/balance.js';
import type { Profile } from '../sim/progress.js';
import { victoryPage } from './formLayout.js';
import { drawFormPage } from './formPage.js';
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
 * The page itself is built by `src/ui/formLayout.ts`; what this file adds is the
 * only thing the report has not got: it moves.
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
  const box = VIEW.victory;

  const page = victoryPage({
    width,
    height,
    hasArt: (id) => hasArt(scene, id),
    balance,
    profile,
  });
  const drawn = drawFormPage(scene, page, { width, height, depth });
  const depthRow = drawn.text('depth');

  // The triumph rings: a rising fanfare and a long pulse on devices that vibrate.
  SFX.unlock();
  SFX.victory();
  SFX.vibrate(400);

  // The paper comes in from below, the way the report does not: this screen is
  // the reward, so it moves.
  const moving = drawn.panelParts;
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
  makeTapTarget(drawn.button, () => {
    if (started) {
      return;
    }
    started = true;
    drawn.button.disableInteractive();
    breathe.stop();
    depthRow.setScale(1);
    scene.tweens.add({
      targets: drawn.parts,
      alpha: 0,
      duration: box.startFadeMs,
      ease: Phaser.Math.Easing.Sine.In,
      onComplete: () => {
        for (const part of drawn.parts) {
          part.destroy();
        }
        onNextPlan();
      },
    });
  });
}
