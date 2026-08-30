import { VIEW } from '../game/layout.js';
import { textWidth } from '../game/textMetrics.js';
import { isDomeWarning, nextWaveInSec } from '../sim/defense.js';
import { cargoCapacity, type ShiftState } from '../sim/shift.js';

/**
 * Every word the dome panel writes, and the width of screen each one has to fit
 * inside — with no Phaser anywhere, so `tests/textFit.test.ts` can hold the two
 * against each other.
 *
 * The panel is the busiest strip of the game: a centred timer with a label on
 * either side of it, two captioned bars, a status line and two buttons, all in
 * 410 pixels of height and 720 of width. Two of those lines were already
 * touching — the timer grows both ways from the middle of the screen, so
 * «СМЕНА 10:00» and the countdown on its right were one long word away from
 * printing over each other — and nothing would have said so.
 */

/** The clear span a line may occupy, `[left, right]` in design pixels. */
export type Box = readonly [number, number];

/** mm:ss, rounded up so the last second is visible. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

export function timerLine(state: ShiftState): string {
  return `СМЕНА ${formatTime(state.timeLeftSec)}`;
}

export function waveLine(state: ShiftState): string {
  return state.defense.wavesSent > 0 ? `ВОЛНА ${state.defense.wavesSent}` : 'ЗАТИШЬЕ';
}

/**
 * The countdown to the next wave. «ЧЕРЕЗ 0:35» and not «ДО ВОЛНЫ 0:35»: the
 * label to the left of the timer already says which wave is meant, and the
 * longer form did not fit the strip of screen the centred timer leaves.
 */
export function nextWaveLine(state: ShiftState): string {
  return state.phase === 'running'
    ? `ЧЕРЕЗ ${formatTime(nextWaveInSec(state.balance, state.defense))}`
    : '';
}

export function domeBarLine(state: ShiftState): string {
  return `КУПОЛ: ${Math.ceil(state.defense.hp)} / ${state.defense.hpMax}`;
}

export function cargoBarLine(state: ShiftState): string {
  return `КАРГО: ${state.cargo} / ${cargoCapacity(state)}`;
}

/**
 * The stats line when there are no icons for it. Short words on purpose: with
 * «СДАНО:» and «КРИСТАЛЛЫ:» spelt out it was half a phone screen wide and ran
 * into the depth on the right of the same row.
 */
export function statsFallbackLine(state: ShiftState): string {
  return `ЛОМ: ${state.banked} · КР: ${state.crystals}`;
}

export function depthLine(state: ShiftState): string {
  return `ГЛУБИНА: ${state.deepestRow} / ${state.balance.shift.grid_depth}`;
}

export function statusText(state: ShiftState, faceVisible: boolean): string {
  if (state.phase === 'finished') {
    return state.endReason === 'breach' ? 'КУПОЛ ПРОБИТ — АВАРИЙНЫЙ ПОДЪЁМ' : 'СМЕНА ОКОНЧЕНА';
  }
  if (state.phase === 'ending') {
    return 'ВРЕМЯ ВЫШЛО — ПОДЪЁМ С ДОБЫЧЕЙ';
  }
  if (isDomeWarning(state.balance, state.defense)) {
    return 'КУПОЛ НА ПРЕДЕЛЕ — БЕЙ ЗАЛПОМ';
  }
  switch (state.drill.mode) {
    case 'idle':
      // Nothing to tap up here: the work is further down, and the button is the
      // way back to it.
      return faceVisible ? 'ТКНИ КЛЕТКУ РЯДОМ С ПРОКОПАННОЙ' : 'ЗАБОЙ НИЖЕ — ЖМИ «К ЗАБОЮ»';
    case 'moving':
      // Driving between two cells of the same dig order is part of digging:
      // saying so keeps the line from flickering every fraction of a second.
      return state.drill.target?.kind === 'surface' ? 'БУР ЕДЕТ К ЛИФТУ' : 'БУР КОПАЕТ';
    case 'digging':
      return 'БУР КОПАЕТ';
    case 'blocked':
      return 'КАРГО ПОЛНО — БУР СТОИТ, СДАЙ ДОБЫЧУ';
    case 'banking':
      return 'СДАЮ ДОБЫЧУ';
  }
}

// ---------------------------------------------------------------------------
// The boxes those lines live in. One source for the panel and for the test.
// ---------------------------------------------------------------------------

/** Half the strip a wave label gets: what the reserved timer box leaves over. */
function sideWidth(width: number): number {
  return (width - VIEW.hud.timerWidth) / 2;
}

/** The wave number, at the left margin. */
export function waveBox(width: number): Box {
  return [VIEW.hud.margin, sideWidth(width)];
}

/** The countdown, at the right margin. */
export function nextWaveBox(width: number): Box {
  return [width - sideWidth(width), width - VIEW.hud.margin];
}

/** The timer itself, centred on the reserved box. */
export function timerBox(width: number): Box {
  return [(width - VIEW.hud.timerWidth) / 2, (width + VIEW.hud.timerWidth) / 2];
}

/**
 * Banked scrap and crystals, at the left of the stats row.
 *
 * The row is cut where the depth on its right begins, not down the middle of
 * the screen: the depth is the shorter of the two and the purse is the one that
 * grows, so half a screen each would have thrown away the room the purse needs.
 */
export function statsBox(width: number, right: string): Box {
  return [
    VIEW.hud.margin,
    width - VIEW.hud.margin - textWidth(right, VIEW.font.small) - VIEW.hud.labelPad * 2,
  ];
}

/** The depth, at the right of the same row. */
export function depthBox(width: number, left: string): Box {
  return [
    VIEW.hud.margin + textWidth(left, VIEW.font.small) + VIEW.hud.labelPad * 2,
    width - VIEW.hud.margin,
  ];
}

/** Width of one of the two bars, and of one of the two buttons. */
export function halfWidth(width: number, gap: number): number {
  return (width - VIEW.hud.margin * 2 - gap) / 2;
}

/** A caption written inside a bar or a button that starts at `x`. */
export function insideBox(x: number, boxWidth: number): Box {
  return [x + VIEW.hud.labelPad, x + boxWidth - VIEW.hud.labelPad];
}

/** The status line: the whole width of the panel, less its margins. */
export function statusBox(width: number): Box {
  return [VIEW.hud.margin, width - VIEW.hud.margin];
}
