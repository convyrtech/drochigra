import { describe, expect, it } from 'vitest';
import balanceJson from '../content/balance.json' with { type: 'json' };
import {
  elevatorBandHeight,
  hudButtonHitZone,
  MIN_TOUCH,
  MIN_TOUCH_CSS,
  TOUCH_REFERENCE_SCREEN_CSS,
  touchHitArea,
  VIEW,
} from '../src/game/layout.js';
import type { Balance } from '../src/sim/balance.js';
import { checkpointRows, upgradeIds } from '../src/sim/progress.js';

/**
 * Issue #8: every interactive zone is at least the minimum touch target, and
 * the minimum is stated in CSS pixels rather than in the design pixels the game
 * is drawn in. These tests are the guard on that: they measure the zones the
 * screens actually build, so a layout number quietly shrinking back under the
 * line fails here instead of on somebody's phone.
 */

const balance = balanceJson as unknown as Balance;

/** The FIT scale the canvas runs at on a screen this wide, in CSS pixels. */
function fitScale(screenCssWidth: number, screenCssHeight: number): number {
  return Math.min(screenCssWidth / VIEW.width, screenCssHeight / VIEW.height);
}

/** A design-pixel length as the finger meets it, in CSS pixels. */
function toCss(designPx: number, scale: number): number {
  return designPx * scale;
}

describe('the minimum touch target', () => {
  it('is the CSS minimum converted at the scale of the reference screen', () => {
    // 48 CSS pixels on a 393-wide phone: 48 / (393 / 720) ≈ 88 design pixels.
    expect(MIN_TOUCH).toBe(88);
    const scale = fitScale(TOUCH_REFERENCE_SCREEN_CSS, 852);
    expect(toCss(MIN_TOUCH, scale)).toBeGreaterThanOrEqual(MIN_TOUCH_CSS);
  });

  it('is what the old «48 design pixels» rule was missing', () => {
    // The number the layout used to promise landed at about 26 CSS pixels — the
    // bug this whole pass is about. Kept as a test so nobody re-writes 48.
    const scale = fitScale(TOUCH_REFERENCE_SCREEN_CSS, 852);
    expect(toCss(48, scale)).toBeLessThan(MIN_TOUCH_CSS * 0.6);
  });

  it('grows a small zone and leaves a big one alone', () => {
    const grown = touchHitArea(210, 62);
    expect(grown.width).toBe(210);
    expect(grown.height).toBe(MIN_TOUCH);
    // Centred on the drawn plate, so the button is still where it looks.
    expect(grown.y).toBe((62 - MIN_TOUCH) / 2);
    expect(grown.x).toBe(0);

    const untouched = touchHitArea(420, 112);
    expect(untouched).toEqual({ x: 0, y: 0, width: 420, height: 112 });
  });
});

describe('every zone the player taps', () => {
  const domeHeight = VIEW.height * VIEW.domeHeightShare;
  const rowWidth = VIEW.width - VIEW.base.margin * 2;
  const hudButtonWidth = (VIEW.width - VIEW.hud.margin * 2 - VIEW.hud.buttonGap) / 2;
  const chipWidth =
    (rowWidth - VIEW.base.chipGap * (checkpointRows(balance).length - 1)) /
    checkpointRows(balance).length;
  const cellSize = VIEW.width / balance.shift.grid_width;

  /** name → the zone as a finger meets it, in design pixels. */
  const zones: readonly (readonly [string, number, number])[] = [
    ['«К ЗАБОЮ»', VIEW.faceButton.width, VIEW.faceButton.height],
    ['«СДАТЬ» / «ЗАЛП»', hudButtonWidth, hudButtonHitZone(domeHeight).height],
    ['лифт (строка поверхности)', VIEW.width, elevatorBandHeight(cellSize)],
    ['выбор врага', VIEW.dome.pickRadius * 2, VIEW.dome.pickRadius * 2],
    ['база: покупка апгрейда', VIEW.base.buyWidth, VIEW.base.buyHeight],
    ['база: чекпоинт лифта', chipWidth, VIEW.base.chipHeight],
    [
      'база: звук',
      touchHitArea(VIEW.base.muteWidth, VIEW.base.muteHeight).width,
      touchHitArea(VIEW.base.muteWidth, VIEW.base.muteHeight).height,
    ],
    ['база: начать смену', rowWidth, VIEW.base.startHeight],
    ['ангар: забрать', VIEW.hangar.buttonWidth, VIEW.hangar.buttonHeight],
    ['отчёт: на базу', VIEW.report.buttonWidth, VIEW.report.buttonHeight],
    ['победа: начать пятилетку', VIEW.victory.buttonWidth, VIEW.victory.buttonHeight],
  ];

  for (const [name, width, height] of zones) {
    it(`${name} is at least the minimum in both directions`, () => {
      expect(width).toBeGreaterThanOrEqual(MIN_TOUCH);
      expect(height).toBeGreaterThanOrEqual(MIN_TOUCH);
    });
  }

  it('measures at least 48 CSS pixels on the reference screen', () => {
    const scale = fitScale(TOUCH_REFERENCE_SCREEN_CSS, 852);
    for (const [name, width, height] of zones) {
      expect(toCss(Math.min(width, height), scale), name).toBeGreaterThanOrEqual(MIN_TOUCH_CSS);
    }
  });
});

describe('the HUD touch zone', () => {
  const domeHeight = VIEW.height * VIEW.domeHeightShare;
  const zone = hudButtonHitZone(domeHeight);

  it('stays inside the dome panel, so a tap on the shaft is never a salvo', () => {
    expect(zone.top + zone.height).toBeLessThanOrEqual(domeHeight);
    expect(zone.top).toBeGreaterThan(0);
  });

  it('covers the drawn button', () => {
    expect(zone.top).toBeLessThanOrEqual(VIEW.hud.buttonTop);
    expect(zone.top + zone.height).toBeGreaterThanOrEqual(
      VIEW.hud.buttonTop + VIEW.hud.buttonHeight,
    );
  });

  it('does not reach up into the dome and cargo bars', () => {
    expect(zone.top).toBeGreaterThanOrEqual(VIEW.hud.barTop + VIEW.hud.barHeight);
  });

  it('leaves the two buttons apart', () => {
    // Same vertical zone for both, so only the gap between them matters.
    expect(VIEW.hud.buttonGap).toBeGreaterThan(0);
  });
});

describe('the lift band', () => {
  const cellSize = VIEW.width / balance.shift.grid_width;

  it('is the row itself when a cell is already big enough', () => {
    expect(elevatorBandHeight(MIN_TOUCH + 10)).toBe(MIN_TOUCH + 10);
  });

  it('borrows only what it needs from the first row of rock', () => {
    const borrowed = elevatorBandHeight(cellSize) - cellSize;
    expect(borrowed).toBe(MIN_TOUCH - cellSize);
    // Most of the first row of rock is still its own.
    expect(borrowed).toBeLessThan(cellSize / 2);
  });
});

describe('the base screen still fits one portrait screen', () => {
  it('leaves the upgrade rows, the chips and the start button clear of each other', () => {
    const { base } = VIEW;
    const rows = upgradeIds(balance).length;
    const listBottom = base.listTop + (base.rowHeight + base.rowGap) * rows;
    const chipsTop = listBottom + base.sectionGap + base.sectionTitleHeight;
    const chipsBottom = chipsTop + base.chipHeight;
    const startTop = VIEW.height - base.startBottom - base.startHeight;
    const startBottom = startTop + base.startHeight;
    const hangarTop = VIEW.height - base.hangarBottom - base.hangarHeight;

    expect(listBottom).toBeLessThan(chipsTop);
    expect(chipsBottom).toBeLessThanOrEqual(startTop);
    expect(startBottom).toBeLessThanOrEqual(hangarTop);
    expect(hangarTop + base.hangarHeight).toBeLessThanOrEqual(VIEW.height);
  });

  it('keeps the checkpoint chips from touching each other', () => {
    const { base } = VIEW;
    const rowWidth = VIEW.width - base.margin * 2;
    const count = checkpointRows(balance).length;
    const chipWidth = (rowWidth - base.chipGap * (count - 1)) / count;
    expect(chipWidth).toBeGreaterThanOrEqual(MIN_TOUCH);
  });

  it('keeps the price buttons of two neighbouring rows apart', () => {
    const { base } = VIEW;
    const pitch = base.rowHeight + base.rowGap;
    expect(pitch).toBeGreaterThanOrEqual(base.buyHeight);
  });
});
