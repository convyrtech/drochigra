import Phaser from 'phaser';
import { hasArt } from '../game/artTextures.js';
import { VIEW } from '../game/layout.js';
import { SFX } from '../game/sfx.js';
import type { Balance } from '../sim/balance.js';
import type { HangarHarvest } from '../sim/progress.js';
import { hangarPage } from './formLayout.js';
import { drawFormPage } from './formPage.js';
import { makeTapTarget } from './tapTarget.js';

/**
 * The screen that greets a returning player: what the hangar made while the game
 * was closed, how long it worked for, and one button that takes it (PLAN_V1 §7).
 * Shown only when there is something to take — an empty hangar says nothing and
 * the base opens straight away.
 *
 * It is the third page of the same file as the report and the closed plan: same
 * blank, same masthead, same badge, same ruled rows, same rubber stamp. It used
 * to be a bare dark oblong with a number on it — the one screen of the game that
 * the art never reached.
 *
 * Taking it has to feel like getting paid, so the number flies up and the panel
 * shakes before the base appears.
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
  const box = VIEW.hangar;

  const page = hangarPage({
    width,
    height,
    hasArt: (id) => hasArt(scene, id),
    balance,
    harvest,
  });
  const drawn = drawFormPage(scene, page, { width, height, depth });
  const amount = drawn.text('amount');

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
  makeTapTarget(drawn.button, () => {
    if (taken) {
      return;
    }
    taken = true;
    drawn.button.disableInteractive();
    breathe.stop();
    amount.setScale(1);
    // Taking the pile is a gesture: unlock the context and ring it in.
    SFX.unlock();
    SFX.hangarCollect();

    // The sheet takes the hit and the number flies out of it: the payment is
    // something that happens, not a screen that quietly disappears.
    scene.tweens.add({
      targets: drawn.panelParts.filter((part) => part !== amount),
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
          for (const part of drawn.parts) {
            part.destroy();
          }
          onCollect();
        });
      },
    });
  });
}
