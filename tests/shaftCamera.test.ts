import { describe, expect, it } from 'vitest';
import {
  clampShaftScroll,
  faceScroll,
  followDrillScroll,
  isFaceVisible,
  maxShaftScroll,
  minShaftScroll,
  shaftScroll,
  type ShaftBounds,
  type ShaftCameraInput,
} from '../src/game/shaftCamera.js';

/**
 * A shaft taller than the screen: 31 rows of 60 px is 1860 px of world under a
 * 1280 px frame whose top 400 px are the dome zone. So the camera may travel
 * from -400 (surface line at the bottom of the dome zone) to 580 (last row on
 * the bottom edge).
 */
const BOUNDS: ShaftBounds = {
  cellSize: 60,
  domeHeight: 400,
  viewHeight: 1280,
  rowCount: 31,
};

/** Idle hands: no finger anywhere, no manual look, camera parked at the top. */
function input(patch: Partial<ShaftCameraInput> = {}): ShaftCameraInput {
  return {
    ...BOUNDS,
    drillRow: 0,
    dragging: false,
    pointerDown: false,
    manualScroll: false,
    dragStartScrollY: 0,
    dragDeltaY: 0,
    currentScrollY: 0,
    ...patch,
  };
}

describe('clampShaftScroll', () => {
  it('keeps the camera between the surface line and the last row', () => {
    expect(minShaftScroll(BOUNDS)).toBe(-400);
    expect(maxShaftScroll(BOUNDS)).toBe(580);
    expect(clampShaftScroll(120, BOUNDS)).toBe(120);
  });

  it('stops the view from rising above the surface line', () => {
    expect(clampShaftScroll(-9999, BOUNDS)).toBe(-400);
  });

  it('stops the view from sliding below the last row', () => {
    expect(clampShaftScroll(9999, BOUNDS)).toBe(580);
  });

  it('collapses both limits onto the surface when the shaft is shorter than the screen', () => {
    // 5 rows of 60 px is 300 px of world under an 880 px shaft zone (1280 px
    // frame less the 400 px dome): the whole mine fits, so nothing scrolls.
    const short: ShaftBounds = { ...BOUNDS, rowCount: 5 };
    expect(maxShaftScroll(short)).toBe(-400);
    expect(minShaftScroll(short)).toBe(-400);
    expect(clampShaftScroll(400, short)).toBe(-400);
    expect(clampShaftScroll(-400, short)).toBe(-400);
  });
});

describe('followDrillScroll', () => {
  it('puts the drill in the middle of the shaft zone, below the dome', () => {
    // Cell 10 sits at 630 px; the middle of the shaft zone is 840 px down the
    // frame, so the camera stands 210 px above the surface line.
    expect(followDrillScroll(BOUNDS, 10)).toBe(-210);
  });

  it('does not lift the view over the surface for the topmost rows', () => {
    expect(followDrillScroll(BOUNDS, 0)).toBe(-400);
  });

  it('does not run past the bottom of the shaft for the deepest rows', () => {
    expect(followDrillScroll(BOUNDS, 30)).toBe(580);
  });
});

describe('faceScroll', () => {
  it('puts the face in the middle of the shaft zone, wherever the drill is', () => {
    expect(faceScroll(BOUNDS, 10)).toBe(-210);
    expect(faceScroll(BOUNDS, 14)).toBe(30);
  });

  it('clamps like everything else: the top rows and the bottom row', () => {
    expect(faceScroll(BOUNDS, 0)).toBe(-400);
    expect(faceScroll(BOUNDS, 30)).toBe(580);
  });

  it('always brings the face on screen, from the first row to the last', () => {
    for (let row = 0; row < BOUNDS.rowCount; row += 1) {
      expect(isFaceVisible(BOUNDS, row, faceScroll(BOUNDS, row))).toBe(true);
    }
  });
});

describe('isFaceVisible', () => {
  it('sees the face while it is in the shaft strip', () => {
    // Row 10 spans 600..660 of the world; at scroll -210 that is 810..870 on a
    // screen whose shaft strip runs from 400 to 1280.
    expect(isFaceVisible(BOUNDS, 10, -210)).toBe(true);
  });

  it('does not see a face that the dome zone has swallowed', () => {
    // Row 5 spans 300..360: at scroll -40 its bottom edge is exactly the 400 px
    // line of the dome zone, so there is nothing left of it to tap.
    expect(isFaceVisible(BOUNDS, 5, -40)).toBe(false);
    expect(isFaceVisible(BOUNDS, 5, -41)).toBe(true);
    expect(isFaceVisible(BOUNDS, 5, 200)).toBe(false);
  });

  it('does not see a face that has slid off the bottom edge', () => {
    // Row 20 spans 1200..1260: at scroll -80 its top edge is exactly the bottom
    // of the 1280 px frame.
    expect(isFaceVisible(BOUNDS, 20, -80)).toBe(false);
    expect(isFaceVisible(BOUNDS, 20, -79)).toBe(true);
    expect(isFaceVisible(BOUNDS, 20, -400)).toBe(false);
  });

  it('loses the face when the drill climbs up to hand the cargo over', () => {
    // The case the button exists for: the drill is back at the entrance and the
    // camera follows it, so the shaft strip shows rows 0..14 and row 20 — the
    // face — is below the frame. The button's scroll brings it back.
    const atSurface = followDrillScroll(BOUNDS, 0);
    expect(isFaceVisible(BOUNDS, 14, atSurface)).toBe(true);
    expect(isFaceVisible(BOUNDS, 20, atSurface)).toBe(false);
    expect(isFaceVisible(BOUNDS, 20, faceScroll(BOUNDS, 20))).toBe(true);
  });
});

describe('shaftScroll', () => {
  it('follows the drill when no finger is on the screen', () => {
    expect(shaftScroll(input({ drillRow: 10, currentScrollY: -400 }))).toBe(-210);
  });

  it('says nothing to do when the camera already stands where the drill is', () => {
    expect(shaftScroll(input({ drillRow: 10, currentScrollY: -210 }))).toBeNull();
  });

  it('hangs the camera off the finger during a drag', () => {
    // Finger dragged 150 px up (negative delta): the view goes 150 px deeper.
    const dragging = input({
      drillRow: 10,
      dragging: true,
      pointerDown: true,
      dragStartScrollY: 0,
      dragDeltaY: -150,
      currentScrollY: 0,
    });
    expect(shaftScroll(dragging)).toBe(150);
  });

  it('drags from where the gesture started, not from where the camera stands', () => {
    const dragging = input({
      dragging: true,
      pointerDown: true,
      dragStartScrollY: 200,
      dragDeltaY: -100,
      currentScrollY: 260,
    });
    expect(shaftScroll(dragging)).toBe(300);
  });

  it('clamps a drag that pulls past the bottom of the shaft', () => {
    const dragging = input({
      dragging: true,
      pointerDown: true,
      dragStartScrollY: 500,
      dragDeltaY: -4000,
      currentScrollY: 500,
    });
    expect(shaftScroll(dragging)).toBe(580);
  });

  it('keeps the scrolled view after the finger lets go (issue #10)', () => {
    // The regression: the drag ended deep in the shaft while the drill is still
    // near the top. The auto-follow must not yank the view back on the next
    // frame, or the deep cells can never be tapped.
    const afterDrag = input({
      drillRow: 2,
      manualScroll: true,
      currentScrollY: 500,
    });
    expect(shaftScroll(afterDrag)).toBeNull();
  });

  it('holds the manual view frame after frame, wherever the drill goes', () => {
    for (const drillRow of [0, 5, 12, 30]) {
      expect(shaftScroll(input({ drillRow, manualScroll: true, currentScrollY: 500 }))).toBeNull();
    }
  });

  it('follows the drill again once an order clears the manual look', () => {
    const afterOrder = input({
      drillRow: 10,
      manualScroll: false,
      currentScrollY: 500,
    });
    expect(shaftScroll(afterOrder)).toBe(-210);
  });

  it('leaves the camera alone while a still finger rests on the screen', () => {
    const resting = input({
      drillRow: 10,
      pointerDown: true,
      dragging: false,
      currentScrollY: 500,
    });
    expect(shaftScroll(resting)).toBeNull();
  });

  it('follows the drill as soon as a still finger is lifted', () => {
    const lifted = input({ drillRow: 10, pointerDown: false, currentScrollY: 500 });
    expect(shaftScroll(lifted)).toBe(-210);
  });
});
