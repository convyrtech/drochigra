import Phaser from 'phaser';
import { ART, hasArt } from '../game/artTextures.js';
import { COLORS, cssColor, FONT_FAMILY, hudButtonHitZone, VIEW } from '../game/layout.js';
import {
  domeHpShare,
  isDomeWarning,
  isSalvoReady,
  salvoCooldownShare,
} from '../sim/defense.js';
import { cargoCapacity, isCargoBlocked, type ShiftState } from '../sim/shift.js';
import { fitInside } from './formPage.js';
import {
  cargoBarLine,
  depthBox,
  depthLine,
  domeBarLine,
  halfWidth,
  insideBox,
  nextWaveBox,
  nextWaveLine,
  statsBox,
  statsFallbackLine,
  statusBox,
  statusText,
  timerBox,
  timerLine,
  waveBox,
  waveLine,
  type Box,
} from './hudText.js';

/**
 * Dome zone panel: the shift timer, the wave countdown, the dome health, the
 * cargo, and the two buttons the whole shift is played with — hand the cargo
 * over and fire the salvo. Fixed on screen while the shaft scrolls behind it.
 * All texts are Russian (AGENTS.md), all numbers come from the shift state.
 *
 * What each line says, and the width of screen it may say it in, live in
 * `src/ui/hudText.ts` — no Phaser in them, so `tests/textFit.test.ts` can hold
 * every line of this panel against its box, in every state the shift has.
 */
export interface Hud {
  /**
   * `faceVisible` is the view's answer to «is the deepest dug row on screen?».
   * The panel only reads it: when the face is off screen the status line stops
   * telling the player to tap a cell — there is none to tap — and points at the
   * «К ЗАБОЮ» button instead.
   */
  readonly update: (state: ShiftState, faceVisible: boolean) => void;
  /**
   * A tap landed at this point of the screen (design pixels): press the button
   * under it, if any, and say whether the panel took the tap.
   *
   * Issue #11: the two buttons have no Phaser input of their own, exactly like
   * «К ЗАБОЮ» (`src/ui/faceButton.ts`). MainScene asks them from `onTap`, which
   * only ever runs for a finger that stayed still and is handed the point the
   * finger went **down** at, so a swipe that begins on «ЗАЛП» scrolls the shaft
   * instead of spending the salvo (PLAN_V1 §3).
   */
  readonly tap: (x: number, y: number) => boolean;
}

export interface HudOptions {
  readonly width: number;
  readonly domeHeight: number;
  readonly depth: number;
  readonly onBank: () => void;
  readonly onSalvo: () => void;
}

/** Anything the panel pins to the screen and puts on its own depth. */
type PinnedPart =
  | Phaser.GameObjects.Rectangle
  | Phaser.GameObjects.Text
  | Phaser.GameObjects.Image;

export function createHud(scene: Phaser.Scene, options: HudOptions): Hud {
  const { width, domeHeight, depth, onBank, onSalvo } = options;
  const { hud, font } = VIEW;
  // The bars share one row, and so do the buttons: two halves of the width each.
  const barWidth = halfWidth(width, hud.barGap);
  const buttonWidth = halfWidth(width, hud.buttonGap);

  // The polar night behind the station, or the flat navy field it replaces.
  const sky = hasArt(scene, ART.sky);
  const panel = sky
    ? scene.add.image(0, 0, ART.sky).setOrigin(0, 0).setDisplaySize(width, domeHeight)
    : scene.add.rectangle(0, 0, width, domeHeight, COLORS.dome).setOrigin(0, 0);
  // Text over a picture needs something to sit on; text over the flat field
  // already has it.
  const scrims = sky
    ? [
        scene.add
          .rectangle(0, 0, width, hud.skyScrimTopHeight, COLORS.dome, hud.skyScrimAlpha)
          .setOrigin(0, 0),
        scene.add
          .rectangle(
            0,
            hud.skyScrimBottomTop,
            width,
            domeHeight - hud.skyScrimBottomTop,
            COLORS.dome,
            hud.skyScrimAlpha,
          )
          .setOrigin(0, 0),
      ]
    : [];
  const edge = scene.add.rectangle(0, domeHeight - 2, width, 2, COLORS.domeEdge).setOrigin(0, 0);

  // Scrap and crystals: two icons and two numbers where there are icons for
  // both, and the spelt-out line where there are not. Both or neither — one
  // icon next to one Russian word would read as a bug.
  const icons =
    hasArt(scene, ART.scrap) && hasArt(scene, ART.crystal)
      ? {
          scrap: scene.add
            .image(hud.margin, hud.statsY + hud.statIconSize / 2, ART.scrap)
            .setOrigin(0, 0.5)
            .setDisplaySize(hud.statIconSize, hud.statIconSize),
          crystal: scene.add
            .image(0, hud.statsY + hud.statIconSize / 2, ART.crystal)
            .setOrigin(0, 0.5)
            .setDisplaySize(hud.statIconSize, hud.statIconSize),
        }
      : null;
  const statsLeft = smallText(scene, hud.margin, hud.statsY, COLORS.scrap, 0);
  const crystalCount = icons ? smallText(scene, 0, hud.statsY, COLORS.crystal, 0) : null;
  const statsRight = smallText(scene, width - hud.margin, hud.statsY, COLORS.textDim, 1);

  const timer = remember(
    scene.add
      .text(width / 2, hud.timerY, '', {
        fontFamily: FONT_FAMILY,
        fontSize: font.large,
        color: cssColor(COLORS.text),
      })
      .setOrigin(0.5, 0),
  );

  // The two wave labels are centred on the timer rather than pinned to a line of
  // their own: at `sideY` they sat ten pixels lower than it and read as a
  // mistake. The timer's height is the only thing that can say where its middle
  // is, so they are placed after it and take it from the object itself.
  const sideMiddle = hud.timerY + timer.height / 2;
  const wave = sideText(scene, hud.margin, sideMiddle, 0);
  const nextWave = sideText(scene, width - hud.margin, sideMiddle, 1);

  const domeBar = createBar(scene, hud.margin, hud.barTop, barWidth, COLORS.buttonEdge);
  const cargoBar = createBar(
    scene,
    hud.margin + barWidth + hud.barGap,
    hud.barTop,
    barWidth,
    COLORS.scrap,
  );

  const status = remember(
    scene.add
      .text(width / 2, hud.statusY, '', {
        fontFamily: FONT_FAMILY,
        fontSize: font.small,
        color: cssColor(COLORS.textDim),
      })
      .setOrigin(0.5, 0),
  );

  // Issue #8: the drawn buttons are `hud.buttonHeight` tall because the dome
  // zone has nothing left to give — the timer, the corridor, the shell, the two
  // bars and the status line are all above them. The zone a finger is tested
  // against is MIN_TOUCH tall instead, pushed up so its bottom is the bottom of
  // the panel: a tap under the dome edge belongs to the shaft, not to «ЗАЛП».
  const { top: hitTop, height: hitHeight } = hudButtonHitZone(domeHeight);

  const bank = createButton(scene, {
    x: hud.margin,
    buttonWidth,
    hitTop,
    hitHeight,
    text: 'СДАТЬ',
    onTap: onBank,
  });
  const salvo = createButton(scene, {
    x: hud.margin + buttonWidth + hud.buttonGap,
    buttonWidth,
    hitTop,
    hitHeight,
    text: 'ЗАЛП',
    onTap: onSalvo,
  });

  const parts: PinnedPart[] = [
    panel,
    ...scrims,
    edge,
    ...(icons ? [icons.scrap, icons.crystal] : []),
    statsLeft,
    ...(crystalCount ? [crystalCount] : []),
    statsRight,
    timer,
    wave,
    nextWave,
    ...domeBar.parts,
    ...cargoBar.parts,
    status,
    ...bank.parts,
    ...salvo.parts,
  ];
  for (const part of parts) {
    part.setScrollFactor(0).setDepth(depth);
  }

  return {
    update(state: ShiftState, faceVisible: boolean): void {
      const defense = state.defense;
      setText(timer, timerLine(state), timerBox(width));

      // The purse and the depth share one row and both grow, so the room each
      // gets is cut where the other one starts, every frame.
      const depthText = depthLine(state);
      const statsText = icons ? `${state.banked}` : statsFallbackLine(state);
      const statsSpan = statsBox(width, depthText);
      const depthSpan = depthBox(width, statsText);
      if (icons && crystalCount) {
        // The numbers grow and shrink, so the crystal icon is placed after the
        // scrap number every frame rather than at a guessed offset.
        setText(statsLeft, statsText, statsSpan);
        setText(crystalCount, `${state.crystals}`, statsSpan);
        const numberX = hud.margin + hud.statIconSize + hud.statIconGap;
        statsLeft.setX(numberX);
        const crystalX = numberX + statsLeft.width + hud.statIconGap * 3;
        icons.crystal.setX(crystalX);
        crystalCount.setX(crystalX + hud.statIconSize + hud.statIconGap);
      } else {
        setText(statsLeft, statsText, statsSpan);
      }
      setText(statsRight, depthText, depthSpan);

      setText(wave, waveLine(state), waveBox(width));
      setText(nextWave, nextWaveLine(state), nextWaveBox(width));

      const warning = isDomeWarning(state.balance, defense);
      domeBar.set(
        domeHpShare(defense),
        domeBarLine(state),
        warning ? COLORS.warning : COLORS.buttonEdge,
      );

      const capacity = cargoCapacity(state);
      const full = state.cargo >= capacity;
      cargoBar.set(
        capacity > 0 ? Math.min(1, state.cargo / capacity) : 0,
        cargoBarLine(state),
        full ? COLORS.warning : COLORS.scrap,
      );

      // The salvo button fills back up as the cooldown runs out.
      const ready = isSalvoReady(defense);
      salvo.setFill(1 - salvoCooldownShare(state.balance, defense), ready);
      salvo.setLabel(ready ? 'ЗАЛП' : `ЗАЛП ${Math.ceil(defense.salvoCooldownSec)}`);

      setText(status, statusText(state, faceVisible), statusBox(width));
      const alarm = warning || isCargoBlocked(state) || state.endReason === 'breach';
      status.setColor(cssColor(alarm ? COLORS.warning : COLORS.textDim));
    },

    tap(x: number, y: number): boolean {
      for (const button of [bank, salvo]) {
        if (button.contains(x, y)) {
          button.press();
          return true;
        }
      }
      return false;
    },
  };
}

interface Bar {
  readonly parts: PinnedPart[];
  readonly set: (share: number, text: string, color: number) => void;
}

/** A bar with its own caption written inside it, so one row shows both. */
function createBar(scene: Phaser.Scene, x: number, y: number, barWidth: number, color: number): Bar {
  const height = VIEW.hud.barHeight;
  const back = scene.add
    .rectangle(x, y, barWidth, height, COLORS.shaft)
    .setOrigin(0, 0)
    .setStrokeStyle(2, COLORS.domeEdge);
  const fill = scene.add.rectangle(x, y, barWidth, height, color).setOrigin(0, 0);
  const label = remember(
    scene.add
      .text(x + barWidth / 2, y + height / 2, '', {
        fontFamily: FONT_FAMILY,
        fontSize: VIEW.font.small,
        color: cssColor(COLORS.text),
      })
      .setOrigin(0.5),
  )
    // The caption crosses the edge of the fill, so it needs a dark outline to
    // stay readable both on the bright bar and on the empty part behind it.
    .setStroke(cssColor(COLORS.shaft), 4);
  const box = insideBox(x, barWidth);

  return {
    parts: [back, fill, label],
    set(share: number, text: string, fillColor: number): void {
      fill.width = barWidth * Math.min(1, Math.max(0, share));
      fill.fillColor = fillColor;
      setText(label, text, box);
    },
  };
}

interface Button {
  readonly parts: PinnedPart[];
  readonly setLabel: (text: string) => void;
  readonly setFill: (share: number, ready: boolean) => void;
  /** Is this point of the screen inside the button's touch zone? */
  readonly contains: (x: number, y: number) => boolean;
  readonly press: () => void;
}

interface ButtonOptions {
  readonly x: number;
  readonly buttonWidth: number;
  /** The touch zone, which is taller than the drawn plate (issue #8). */
  readonly hitTop: number;
  readonly hitHeight: number;
  readonly text: string;
  readonly onTap: () => void;
}

function createButton(scene: Phaser.Scene, options: ButtonOptions): Button {
  const { x, buttonWidth, hitTop, hitHeight, text, onTap } = options;
  const { hud, font } = VIEW;
  const back = scene.add
    .rectangle(x, hud.buttonTop, buttonWidth, hud.buttonHeight, COLORS.buttonOff)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge);

  const fill = scene.add
    .rectangle(x, hud.buttonTop, buttonWidth, hud.buttonHeight, COLORS.button)
    .setOrigin(0, 0);

  const label = remember(
    scene.add
      .text(x + buttonWidth / 2, hud.buttonTop + hud.buttonHeight / 2, text, {
        fontFamily: FONT_FAMILY,
        fontSize: font.medium,
        color: cssColor(COLORS.text),
      })
      .setOrigin(0.5),
  );
  const box = insideBox(x, buttonWidth);
  fitInside(label, box[1] - box[0]);

  return {
    parts: [back, fill, label],
    setLabel(next: string): void {
      setText(label, next, box);
    },
    setFill(share: number, ready: boolean): void {
      fill.width = buttonWidth * Math.min(1, Math.max(0, share));
      label.setColor(cssColor(ready ? COLORS.text : COLORS.textDim));
    },
    contains(px: number, py: number): boolean {
      return px >= x && px <= x + buttonWidth && py >= hitTop && py <= hitTop + hitHeight;
    },
    press: onTap,
  };
}

function smallText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number,
  originX: number,
): Phaser.GameObjects.Text {
  return remember(
    scene.add
      .text(x, y, '', {
        fontFamily: FONT_FAMILY,
        fontSize: VIEW.font.small,
        color: cssColor(color),
      })
      .setOrigin(originX, 0),
  );
}

/** A wave label beside the timer, vertically centred on it. */
function sideText(
  scene: Phaser.Scene,
  x: number,
  middleY: number,
  originX: number,
): Phaser.GameObjects.Text {
  return remember(
    scene.add
      .text(x, middleY, '', {
        fontFamily: FONT_FAMILY,
        fontSize: VIEW.font.tiny,
        color: cssColor(COLORS.textDim),
      })
      .setOrigin(originX, 0.5),
  );
}

/**
 * Writes a line and keeps it inside its box.
 *
 * The size is reset before every measurement, so a line that once had to shrink
 * for a five-digit figure grows back the moment the figure is four digits again.
 */
function setText(target: Phaser.GameObjects.Text, value: string, box: Box): void {
  if (target.text === value) {
    return;
  }
  target.setText(value);
  target.setFontSize(baseSize(target));
  fitInside(target, box[1] - box[0]);
}

/** Remembers the size a line was created with, before anything can shrink it. */
type SizedText = Phaser.GameObjects.Text & { vostokBaseFontSize?: number };

function remember(target: Phaser.GameObjects.Text): Phaser.GameObjects.Text {
  (target as SizedText).vostokBaseFontSize = Number.parseFloat(String(target.style.fontSize));
  return target;
}

/**
 * The size a line was created with. Phaser only keeps the current one, which may
 * already have been shrunk to fit a long figure, so a shorter figure could never
 * get its size back.
 */
function baseSize(target: Phaser.GameObjects.Text): number {
  return (target as SizedText).vostokBaseFontSize ?? Number.parseFloat(String(target.style.fontSize));
}
