import Phaser from 'phaser';
import { touchHitArea, VIEW } from '../game/layout.js';
import { isTapTravel } from '../game/shaftGesture.js';

/**
 * A button that behaves the way PLAN_V1 §3 promises: it fires when the finger
 * is **lifted**, and only if the finger stayed put (issue #11). A press that
 * turns into a swipe orders nothing — «ни одного игрового решения свайпом
 * принять нельзя» — and the threshold is the same one the shaft reads its
 * gestures with, so the whole game answers a travelling finger identically.
 *
 * The second half of the job is issue #8: the zone the finger is tested against
 * is grown to MIN_TOUCH in both directions around the drawn button. Where the
 * screen has room the button itself is that big (the base rows, the report and
 * victory buttons); where it has not (the HUD row, the sound toggle) the drawn
 * plate stays small and only the zone grows — a finger is wider than a pixel,
 * and the guideline is about what it can hit, not about what it can see.
 *
 * The HUD is the exception that does not come through here: its two buttons
 * live inside the shift's own gesture handling, like «К ЗАБОЮ» (see `hud.ts`).
 */

/**
 * Make a drawn rectangle a tappable button: hit zone at least MIN_TOUCH across,
 * `onTap` on release. Expects `setOrigin(0, 0)`, which every screen here uses.
 */
export function makeTapTarget(rect: Phaser.GameObjects.Rectangle, onTap: () => void): void {
  const area = touchHitArea(rect.width, rect.height);
  rect.setInteractive({
    hitArea: new Phaser.Geom.Rectangle(area.x, area.y, area.width, area.height),
    hitAreaCallback: Phaser.Geom.Rectangle.Contains,
    useHandCursor: true,
  });

  // The gesture is followed by hand rather than trusted to Phaser's own click
  // detection: only the pointer that went down on this button may press it, and
  // only if it has not travelled since.
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;

  rect.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
    pointerId = pointer.id;
    startX = pointer.x;
    startY = pointer.y;
  });

  rect.on(Phaser.Input.Events.GAMEOBJECT_POINTER_UP, (pointer: Phaser.Input.Pointer) => {
    // A finger that went down somewhere else and happened to come up here is
    // not a press of this button.
    const started = pointerId === pointer.id;
    pointerId = null;
    if (!started) {
      return;
    }
    const stillATap = isTapTravel({
      startX,
      startY,
      x: pointer.x,
      y: pointer.y,
      threshold: VIEW.dragThreshold,
    });
    if (stillATap) {
      onTap();
    }
  });
}
