/**
 * Where the shaft camera should stand (issue #10). Pure view math: no Phaser and
 * no browser, so the three rules it arbitrates — follow the drill, follow the
 * finger, or stand still while the player looks around — can be tested on their
 * own. MainScene only collects the numbers and applies the answer.
 */

/** The shaft measured against the screen: everything the clamp needs. */
export interface ShaftBounds {
  /** Height of one cell, in design pixels. */
  readonly cellSize: number;
  /** Height of the dome zone at the top of the screen. */
  readonly domeHeight: number;
  /** Height of the whole visible frame. */
  readonly viewHeight: number;
  /** Rows in the shaft, entrance row included. */
  readonly rowCount: number;
}

export interface ShaftCameraInput extends ShaftBounds {
  /** Row the drill is on; fractional while it drives between cells. */
  readonly drillRow: number;
  /** A finger is dragging the shaft right now. */
  readonly dragging: boolean;
  /** A finger is down but has not travelled far enough to be a drag yet. */
  readonly pointerDown: boolean;
  /** The player dragged and let go: the view they chose stays until an order. */
  readonly manualScroll: boolean;
  /** Camera scroll the current drag started from. */
  readonly dragStartScrollY: number;
  /** How far the finger has travelled down since the drag started. */
  readonly dragDeltaY: number;
  /** Where the camera stands now. */
  readonly currentScrollY: number;
}

/** Highest the camera may go: the surface line stays under the dome zone. */
export function minShaftScroll(bounds: ShaftBounds): number {
  return -bounds.domeHeight;
}

/**
 * Lowest the camera may go: the last row lands on the bottom of the frame. A
 * shaft shorter than the screen has nothing to scroll, so the limit collapses
 * onto the top one instead of pulling the view above the surface.
 */
export function maxShaftScroll(bounds: ShaftBounds): number {
  return Math.max(minShaftScroll(bounds), bounds.rowCount * bounds.cellSize - bounds.viewHeight);
}

/** A scroll brought inside the shaft's travel. */
export function clampShaftScroll(scrollY: number, bounds: ShaftBounds): number {
  return Math.min(maxShaftScroll(bounds), Math.max(minShaftScroll(bounds), scrollY));
}

/** Scroll that puts one row in the middle of the shaft zone, below the dome. */
function rowCenterScroll(bounds: ShaftBounds, row: number): number {
  const shaftHeight = bounds.viewHeight - bounds.domeHeight;
  const rowY = (row + 0.5) * bounds.cellSize;
  return clampShaftScroll(rowY - (bounds.domeHeight + shaftHeight / 2), bounds);
}

/** Scroll that keeps the drill in the middle of the shaft zone, below the dome. */
export function followDrillScroll(bounds: ShaftBounds, drillRow: number): number {
  return rowCenterScroll(bounds, drillRow);
}

/**
 * Scroll that brings the face — the deepest row dug this shift — into the middle
 * of the shaft zone. Where the «К ЗАБОЮ» button sends the camera: back to the
 * work, which is not where the drill is when it has climbed up to hand over the
 * cargo.
 */
export function faceScroll(bounds: ShaftBounds, faceRow: number): number {
  return rowCenterScroll(bounds, faceRow);
}

/**
 * Is any of that row inside the visible strip of the shaft — under the dome zone
 * and over the bottom edge of the frame? A row exactly flush with either edge
 * does not count: there is nothing of it left to look at or tap.
 */
export function isFaceVisible(bounds: ShaftBounds, faceRow: number, scrollY: number): boolean {
  const top = faceRow * bounds.cellSize - scrollY;
  const bottom = top + bounds.cellSize;
  return bottom > bounds.domeHeight && top < bounds.viewHeight;
}

/**
 * Where to put the camera, or null when it must be left alone — either because
 * the player owns the view (a finger is down, or a drag ended and the manual
 * look is still on) or because the camera already stands there. The returned
 * value is clamped.
 */
export function shaftScroll(input: ShaftCameraInput): number | null {
  const wanted = wantedScroll(input);
  if (wanted === null || wanted === input.currentScrollY) {
    return null;
  }
  return wanted;
}

function wantedScroll(input: ShaftCameraInput): number | null {
  // A drag beats everything: the camera hangs off the finger.
  if (input.dragging) {
    return clampShaftScroll(input.dragStartScrollY - input.dragDeltaY, input);
  }
  // A finger resting on the screen may still become a drag, and a finished drag
  // leaves the manual look on until the player gives the drill an order. Either
  // way the auto-follow stands aside instead of yanking the view back.
  if (input.pointerDown || input.manualScroll) {
    return null;
  }
  return followDrillScroll(input, input.drillRow);
}
