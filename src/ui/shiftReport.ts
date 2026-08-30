import Phaser from 'phaser';
import { hasArt } from '../game/artTextures.js';
import type { ShiftOutcome } from '../sim/progress.js';
import type { ShiftReport } from '../sim/shift.js';
import { reportPage } from './formLayout.js';
import { drawFormPage } from './formPage.js';
import { makeTapTarget } from './tapTarget.js';

/**
 * End of shift screen: what the shift produced, what it did to the profile, and
 * one button back to the base (src/ui/baseScreen.ts), where the earnings are
 * spent. Everything shown here is already saved — the plan, the premium and the
 * new checkpoints come from the ShiftOutcome the base wrote to the profile.
 *
 * It is laid out as the paper form the station would file: a header band with
 * the form code and the five-year plan, the plan percent as the headline, and
 * one ruled row per figure — what it is on the left, the number on the right.
 * The numbers and the rules behind them are untouched, only the shape is a form.
 *
 * Where every word of it goes is decided in `src/ui/formLayout.ts`, which has no
 * Phaser in it and can therefore be measured by a test; this file hands the
 * result to `src/ui/formPage.ts` and wires the one button.
 */
export interface ShiftReportOptions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly maxDepthRow: number;
  /** What the shift added to the profile. Already applied and saved. */
  readonly outcome: ShiftOutcome;
  readonly onBack: () => void;
}

export function createShiftReport(
  scene: Phaser.Scene,
  report: ShiftReport,
  options: ShiftReportOptions,
): void {
  const { width, height, depth, maxDepthRow, outcome, onBack } = options;
  const page = reportPage({
    width,
    height,
    hasArt: (id) => hasArt(scene, id),
    report,
    outcome,
    maxDepthRow,
  });
  const drawn = drawFormPage(scene, page, { width, height, depth });
  makeTapTarget(drawn.button, onBack);
}
