import { describe, expect, it } from 'vitest';
import { VIEW } from '../src/game/layout.js';
import {
  advanceGesture,
  classifyGesture,
  tapPoint,
  type GestureKind,
  type GestureSample,
} from '../src/game/shaftGesture.js';

/** The real screen the scene feeds in: design pixels, dome zone on top. */
const DOME_HEIGHT = VIEW.height * VIEW.domeHeightShare;
const THRESHOLD = VIEW.dragThreshold;
/** A row of the shaft, well under the dome zone. */
const SHAFT_Y = 900;

function sample(patch: Partial<GestureSample> = {}): GestureSample {
  const startX = patch.startX ?? 360;
  const startY = patch.startY ?? SHAFT_Y;
  return {
    startX,
    startY,
    x: patch.x ?? startX,
    y: patch.y ?? startY,
    domeHeight: patch.domeHeight ?? DOME_HEIGHT,
    threshold: patch.threshold ?? THRESHOLD,
  };
}

/** The whole gesture: down, a few moves, up. Returns what it ended as. */
function gestureOf(...points: readonly (readonly [number, number])[]): {
  kind: GestureKind;
  tap: { x: number; y: number } | null;
} {
  const first = points[0];
  if (!first) {
    throw new Error('a gesture needs at least the point it went down at');
  }
  const [startX, startY] = first;
  let kind: GestureKind = 'tap';
  let last = sample({ startX, startY });
  for (const [x, y] of points.slice(1)) {
    last = sample({ startX, startY, x, y });
    kind = advanceGesture(kind, last);
  }
  return { kind, tap: tapPoint(kind, last) };
}

describe('classifyGesture', () => {
  it('calls a finger that has not travelled a tap', () => {
    expect(classifyGesture(sample())).toBe('tap');
    expect(classifyGesture(sample({ x: 360 + THRESHOLD - 1, y: SHAFT_Y + THRESHOLD - 1 }))).toBe(
      'tap',
    );
  });

  it('calls a vertical travel over the shaft a shaft drag', () => {
    expect(classifyGesture(sample({ y: SHAFT_Y - THRESHOLD }))).toBe('shaftDrag');
    expect(classifyGesture(sample({ y: SHAFT_Y + 400 }))).toBe('shaftDrag');
  });

  it('ignores a sideways swipe over the shaft', () => {
    expect(classifyGesture(sample({ x: 360 + THRESHOLD }))).toBe('ignored');
    expect(classifyGesture(sample({ startX: 120, x: 620 }))).toBe('ignored');
  });

  it('ignores any swipe that began up in the dome zone', () => {
    expect(classifyGesture(sample({ startY: 300, y: 530 }))).toBe('ignored');
    expect(classifyGesture(sample({ startY: 300, x: 600 }))).toBe('ignored');
  });

  it('reads a tap in the dome zone as a tap, so the turret can still be aimed', () => {
    expect(classifyGesture(sample({ startY: 300 }))).toBe('tap');
  });
});

describe('advanceGesture', () => {
  it('never lets a travelled finger become a tap again', () => {
    const wandered = advanceGesture('tap', sample({ x: 620 }));
    expect(wandered).toBe('ignored');
    // Back to where it started: still not an order.
    expect(advanceGesture(wandered, sample())).toBe('ignored');
  });

  it('keeps a shaft drag a shaft drag while the finger is down', () => {
    const dragging = advanceGesture('tap', sample({ y: SHAFT_Y - 200 }));
    expect(dragging).toBe('shaftDrag');
    expect(advanceGesture(dragging, sample())).toBe('shaftDrag');
    expect(advanceGesture(dragging, sample({ x: 620 }))).toBe('shaftDrag');
  });

  it('lets a sideways swipe over the shaft still become a scroll', () => {
    const sideways = advanceGesture('tap', sample({ x: 620 }));
    expect(advanceGesture(sideways, sample({ x: 620, y: SHAFT_Y - 200 }))).toBe('shaftDrag');
  });
});

describe('a whole gesture', () => {
  it('orders the cell the thumb pressed, wobble and all', () => {
    const { kind, tap } = gestureOf(
      [360, SHAFT_Y],
      [366, SHAFT_Y + 9],
      [358, SHAFT_Y + 14],
      [361, SHAFT_Y + 11],
    );
    expect(kind).toBe('tap');
    // The point that counts is where the finger went down, not where it left.
    expect(tap).toEqual({ x: 360, y: SHAFT_Y });
  });

  it('orders nothing on a sideways swipe across the shaft (PLAN_V1 §3)', () => {
    // The reviewer's case: x 120 → 620 along one row used to order {col:7,row:1}.
    const { kind, tap } = gestureOf([120, 490], [300, 490], [480, 490], [620, 490]);
    expect(kind).toBe('ignored');
    expect(tap).toBeNull();
  });

  it('orders nothing on a swipe that started in the dome zone', () => {
    // The reviewer's other case: y 300 → 530 used to order {col:4,row:1}.
    const { kind, tap } = gestureOf([360, 300], [360, 400], [360, 530]);
    expect(kind).toBe('ignored');
    expect(tap).toBeNull();
  });

  it('scrolls, and orders nothing, on a vertical swipe over the shaft', () => {
    const { kind, tap } = gestureOf([360, 1100], [360, 900], [360, 520]);
    expect(kind).toBe('shaftDrag');
    expect(tap).toBeNull();
  });

  it('still lets a plain tap through, in the shaft and in the dome zone', () => {
    expect(gestureOf([360, 900], [360, 900])).toEqual({
      kind: 'tap',
      tap: { x: 360, y: 900 },
    });
    expect(gestureOf([200, 150], [200, 150])).toEqual({
      kind: 'tap',
      tap: { x: 200, y: 150 },
    });
  });
});
