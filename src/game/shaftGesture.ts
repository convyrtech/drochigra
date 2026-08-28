/**
 * What the finger on the screen is doing (issue #10). Pure input math: no Phaser
 * and no browser, so the rule can be tested on its own.
 *
 * PLAN_V1 §3 allows exactly one gesture — a vertical swipe over the shaft, and
 * it moves the camera and nothing else: «ни одного игрового решения свайпом
 * принять нельзя». So two questions are kept apart here:
 *
 *   1. Is this still a tap? It stops being one as soon as the finger travels
 *      past the threshold on either axis, sideways included.
 *   2. Is this a shaft drag? Only a vertical travel that began below the dome
 *      zone, where the mine is.
 *
 * A gesture that is neither — a sideways swipe, a swipe that started up in the
 * dome zone — is `ignored`: it scrolls nothing and orders nothing.
 */

export type GestureKind = 'tap' | 'shaftDrag' | 'ignored';

export interface GestureSample {
  /** Where the finger went down. */
  readonly startX: number;
  readonly startY: number;
  /** Where the finger is now. */
  readonly x: number;
  readonly y: number;
  /** Height of the dome zone: the shaft begins under it. */
  readonly domeHeight: number;
  /** Travel that turns a tap into a swipe, in design pixels. */
  readonly threshold: number;
}

/** What this one sample looks like, with no memory of the gesture so far. */
export function classifyGesture(sample: GestureSample): GestureKind {
  const movedX = Math.abs(sample.x - sample.startX) >= sample.threshold;
  const movedY = Math.abs(sample.y - sample.startY) >= sample.threshold;
  if (!movedX && !movedY) {
    return 'tap';
  }
  // The mine scrolls, the dome zone does not: a swipe that began up there is
  // not a shaft drag, whichever way it went.
  if (movedY && sample.startY >= sample.domeHeight) {
    return 'shaftDrag';
  }
  return 'ignored';
}

/**
 * The gesture after one more sample. A finger that has travelled never becomes
 * a tap again — coming back to where it started does not turn a swipe into an
 * order — and a shaft drag stays a shaft drag until the finger is lifted.
 */
export function advanceGesture(current: GestureKind, sample: GestureSample): GestureKind {
  if (current === 'shaftDrag') {
    return 'shaftDrag';
  }
  const next = classifyGesture(sample);
  if (next === 'shaftDrag') {
    return 'shaftDrag';
  }
  if (current === 'ignored' || next === 'ignored') {
    return 'ignored';
  }
  return 'tap';
}

/** A point on the screen, in design pixels. */
export interface TapPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Where the tap landed, or null when the gesture was not a tap. The point is
 * where the finger went **down**, never where it came up: a thumb that wobbles
 * while pressing must order the cell it aimed at.
 */
export function tapPoint(kind: GestureKind, sample: GestureSample): TapPoint | null {
  if (kind !== 'tap') {
    return null;
  }
  return { x: sample.startX, y: sample.startY };
}
