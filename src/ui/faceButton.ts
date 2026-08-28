import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';

/**
 * «К ЗАБОЮ» — the way back to the work (issue #10). Every hand-over drags the
 * camera up to the elevator with the drill, and once the tunnel is deeper than a
 * screen the player is left staring at a wall of dug-out rock with nothing to
 * tap. The button sits in the bottom-right corner of the shaft zone and appears
 * only while the face is off screen; it sends the camera to the deepest cell dug
 * this shift, which is where the digging goes on.
 *
 * It is pinned to the screen (`setScrollFactor(0)`) and it has no Phaser input of
 * its own on purpose: MainScene routes taps into it through the same gesture
 * rules as the mine, so a swipe that starts on the button scrolls the shaft
 * instead of pressing it.
 */
export interface FaceButtonOptions {
  /** Screen width and height, in design pixels. */
  readonly width: number;
  readonly viewHeight: number;
  readonly depth: number;
}

export interface FaceButton {
  readonly setVisible: (visible: boolean) => void;
  /** Is this point of the screen on the button? Never true while it is hidden. */
  readonly contains: (x: number, y: number) => boolean;
}

export function createFaceButton(scene: Phaser.Scene, options: FaceButtonOptions): FaceButton {
  const { faceButton, font } = VIEW;
  const left = options.width - faceButton.margin - faceButton.width;
  const top = options.viewHeight - faceButton.margin - faceButton.height;

  const back = scene.add
    .rectangle(left, top, faceButton.width, faceButton.height, COLORS.button)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge);
  const label = scene.add
    .text(left + faceButton.width / 2, top + faceButton.height / 2, 'К ЗАБОЮ ▾', {
      fontFamily: FONT_FAMILY,
      fontSize: font.medium,
      color: cssColor(COLORS.text),
    })
    .setOrigin(0.5);

  let visible = false;
  for (const part of [back, label]) {
    part.setScrollFactor(0).setDepth(options.depth).setVisible(false);
  }

  return {
    setVisible(next: boolean): void {
      if (next === visible) {
        return;
      }
      visible = next;
      back.setVisible(next);
      label.setVisible(next);
    },
    contains(x: number, y: number): boolean {
      return (
        visible &&
        x >= left &&
        x <= left + faceButton.width &&
        y >= top &&
        y <= top + faceButton.height
      );
    },
  };
}
