import { beforeAll, describe, expect, it } from 'vitest';
import balanceJson from '../content/balance.json' with { type: 'json' };
import type { Balance, LayerBalance } from '../src/sim/balance.js';
import { digTimeSec } from '../src/sim/mining.js';
import {
  applyShiftResult,
  buyUpgrade,
  checkpointRows,
  createProfile,
  crystalId,
  deepestOpenCheckpoint,
  effectiveBalance,
  hasConveyor,
  isBottomReached,
  nextUpgrade,
  planBalance,
  scrapId,
  shiftBalance,
  upgradeIds,
  upgradeLevel,
  walletAmount,
  type Profile,
  type UpgradeLevels,
} from '../src/sim/progress.js';
import {
  aimDrill,
  callElevator,
  createShift,
  ENTRANCE_ROW,
  fireSalvo,
  isDug,
  shiftReport,
  step,
  type GridPos,
  type ShiftEndReason,
  type ShiftState,
} from '../src/sim/shift.js';

/**
 * The balance measurement GOAL_V1 asks for («Замер, которого никогда не делали»).
 *
 * It runs the real simulation — src/sim through its public API, not a copy of
 * its formulas — and answers three questions with numbers instead of arithmetic
 * on a napkin:
 *
 *   1. What does one minute inside each layer pay, in scrap and in crystals,
 *      with and without upgrades, with and without the conveyor?
 *   2. How much of a cycle is digging and how much is the road (PLAN_V1 §4
 *      claims the road is the main price of depth — here it is a number).
 *   3. Is the difficulty shape of PLAN_V1 §6 still there: first leaks around
 *      wave 5, breach around wave 9 bare-handed, survival with the salvo.
 *
 * Two things at once, on purpose. The `it` blocks are real invariants that fail
 * when a balance edit breaks the game; the report is a table for a human. The
 * table only prints in measurement mode, so `npm run test` stays quiet:
 *
 *     npm run measure     # vitest run … --mode measure --reporter=verbose
 *
 * `import.meta.env.MODE` is what tells the two apart — no new dependency and
 * no `process.env` (this project has no @types/node).
 *
 * ---------------------------------------------------------------- the bot
 *
 * A measurement is only as honest as the player it simulates, so the policy is
 * written down rather than implied.
 *
 * **A snake inside one layer.** The elevator drops the drill at the layer's top
 * checkpoint (rows 0 / 10 / 20 are checkpoints, `checkpoint_every_rows` is 5).
 * The bot digs one column of the layer top to bottom, steps one cell sideways,
 * digs the next one bottom to top, and so on, taking the columns outwards from
 * the middle one — 4, 3, 5, 2, 6 …
 *
 * Straight down a column is the natural tap (PLAN_V1 §4: one tap digs a whole
 * shaft), and staying inside the layer is what makes the three layers
 * comparable at all: a drill that falls through L1 into L2 measures the road
 * through the whole mine, not the layer it started in. Turning at the bottom
 * instead of driving back to the top is what keeps the comparison fair — see
 * `buildPlan`.
 *
 * The sim's own auto-continue does the digging: the bot only re-aims where the
 * snake turns, and where the drill would otherwise carry on out of the layer.
 * It re-aims while the drill is *driving* into the cell it has just opened, so
 * no dig progress is ever thrown away; `redirectsWhileDigging` counts the times
 * that failed and the invariants keep it at zero.
 *
 * Cargo: dig until the cargo is full (the drill blocks itself), then call the
 * elevator, hand over, come back. Exactly the loop PLAN_V1 §4 describes.
 *
 * **What the policy costs.** The snake sweeps a layer clean, so the face keeps
 * walking away from the elevator column and the road grows with it. A player
 * who only ever sinks one straight shaft pays less road and reaches the bottom
 * instead — that shift is measured too, as the progression run that defines
 * "typical upgrades" below.
 *
 * ------------------------------------------------------------- the window
 *
 * Everything is measured over one window: from the start of the shift to the
 * moment the last scrap is banked — either the layer ran out (the bot hands the
 * rest over and stops) or the timer did (the sim brings the drill up by itself,
 * PLAN_V1 §4). The whole window is real time the player spent, so the rate is
 * `banked / window`.
 *
 * The split of that window is exact, not sampled: digging is the sum of
 * `digTimeSec` over the cells that actually changed from rock to dug, handing
 * over is `elevator_bank_sec` per trip, waiting is the bot's own reaction time
 * (measured, and tiny — it decides every millisecond), and the road is what is
 * left. Nothing is re-derived from a formula the sim does not use itself.
 *
 * A second, narrower number is printed next to it: the steady cycle. That is
 * the bank-to-bank loop that ended with a full cargo, ignoring the first trip
 * (which starts at the face for free, because the elevator put the drill
 * there) and the last one (cut short by the layer or the clock). It is the
 * number the napkin in GOAL_V1 estimated, so it is the one to compare with.
 *
 * Waves are off for the income table. A shift cut short by a breach measures
 * the dome, not the layer. The dome gets its own two tables further down, and
 * one of them puts the waves back on top of the very same mining bot.
 *
 * One thing this measurement found that is not about balance at all: the shift
 * can freeze solid inside `src/sim/shift.ts`. See `tick` — it is worked around
 * here, counted, and shouted about at the end of the report.
 */

const BALANCE = balanceJson as unknown as Balance;

/** Print the table only when run as `npm run measure`. */
const REPORTING = import.meta.env.MODE === 'measure';

/**
 * Bot reaction time, in seconds of simulated time. Not a game number: it is how
 * often the measurement looks at the shift and gives the drill its next order.
 * One millisecond is far below anything the game cares about, and the waiting
 * it adds is measured and printed («простой») instead of being hidden.
 */
const SAMPLE_SEC = 1 / 1000;

/** No wave ever comes out this late: the income table is about the mine only. */
const NO_WAVES_SEC = 1e9;

/** Seeds the crystal counts are averaged over. Timing does not depend on them. */
const SEEDS: readonly number[] = [1, 2, 3, 4, 5];

/**
 * The balance as it was measured before the rhythm of PLAN_V1 §2.6 was fixed —
 * a 9×108 mine that took the bottom on the 17th shift and asked the player for
 * a decision about once every two minutes. Kept here so the report can put the
 * old numbers and the new ones side by side; nothing is computed from them.
 *
 * (The line before this one held the balance from before the economy rework of
 * issue #14 — a 9×30 mine whose bottom fell on the 73rd second of the first
 * shift. That comparison has done its job and now lives in the git history.)
 */
const BEFORE_RHYTHM = {
  scrapPerMin: [68.7, 121.7, 176.1],
  crystalPerMin: [0, 0.19, 0.26],
  conveyorScrapPerMin: [72.5, 137.5, 293.3],
  layerCells: [315, 323, 332],
  /** Mean and longest gap between decisions about the mine, per layer. */
  rhythmMeanSec: [122.2, 52.8, 34.1],
  rhythmMaxSec: [194.7, 97.5, 52.8],
  firstShiftDecisions: 3,
  firstShiftMeanSec: 122.2,
  firstShiftMaxSec: 194.7,
  bottomShift: 17,
} as const;

/**
 * The difficulty shape PLAN_V1 §6 records, measured on a bare account with the
 * drill on the surface. The mining numbers moved; this must not.
 */
const SHAPE = {
  bareFirstLeakWave: 4,
  bareBreachWave: 9,
  salvoFirstLeakWave: 6,
  salvoDomeHp: 45,
} as const;

/**
 * Shifts the progression run may play before we call the arc broken. It stops
 * as soon as the bottom is reached: row `grid_depth` closes the five-year plan
 * and starts a new one (PLAN_V1 §5), and everything after that is a different
 * game. The cap is well above the target band so a balance that never gets
 * there prints a number instead of running for ever.
 */
const MAX_PROGRESSION_SHIFTS = 45;

/**
 * Shifts of ordinary play that define «типичная прокачка» for tables 1, 2 and 4.
 * Three, as before: those tables are about a player a couple of shifts in, not
 * about one who has already dug out the Abyss.
 */
const TYPICAL_AFTER_SHIFTS = 3;

/**
 * How long the bottom of the Abyss may take (issue #14, owner's decision): a
 * week of play, of the order of 15–25 shifts. Below the band the whole
 * progression is skipped in one evening; above it the goal stops being a goal.
 */
const BOTTOM_SHIFTS_MIN = 15;
const BOTTOM_SHIFTS_MAX = 25;

/**
 * PLAN_V1 §2 rule 4: «следующий апгрейд всегда близко — самая дешёвая покупка
 * в 20–40 секундах». The limit the measurement holds the balance to, in seconds
 * of played shift. See `secondsToNextUpgrade` for what exactly is timed.
 */
const NEXT_UPGRADE_LIMIT_SEC = 40;

/**
 * PLAN_V1 §2 rule 4 used to read «в 20–40 секундах» and only the 40 was ever
 * checked. The floor cannot be checked here, and the reason is arithmetic, not
 * laziness — it is written down in PLAN_V1 §12 and repeated here because this
 * is where someone will next try to add the missing `expect`:
 *
 * `secondsToNextUpgrade` is measured at the base, right after the player has
 * spent everything they could. Buying stops exactly when the wallet no longer
 * covers the cheapest thing on offer, so what is left in it is a remainder that
 * lands anywhere between zero and that price. The distance to the next purchase
 * is therefore uniform-ish over `(0, cheapest / rate]` — its maximum is what the
 * balance sets, and its median is about half of that. Demanding «максимум ≤ 40 и
 * медиана ≥ 20» pins the two ends of the same distribution together and has
 * exactly one solution, where every shift ends 40 seconds from its next
 * purchase — which is not a game, it is a fixed point.
 *
 * So the rule keeps its ceiling and gives up its floor, and the intent behind
 * the floor — that a purchase stays a purchase and not a formality — is guarded
 * instead by `MIN_MEDIAN_NEXT_UPGRADE_SEC` on the median.
 */
const MIN_MEDIAN_NEXT_UPGRADE_SEC = 10;

/**
 * PLAN_V1 §2 rule 6: «игрок решает примерно раз в 20–30 секунд» — the target,
 * and the band the mean gap between decisions about the mine is aimed at.
 * See `noteDecision` for what a decision is.
 *
 * What is held to the band is `Rhythm.typicalSec` — the length of the gap a
 * random second of the shift falls into (see `Rhythm`). Not the mean: the gaps
 * are bimodal and their mean describes a moment that does not exist.
 *
 * The guarded band is wider than the target on the floor side only, because the
 * same numbers have to hold across a whole arc: the drill and the elevator both
 * shorten the trip, so the typical pause drifts down by the end of the arc — the
 * measured worst is 11.5 seconds at «всё к концу дуги», and the floor sits at 8.
 *
 * The ceiling does **not** get that slack. It is the half of §2.6 the player can
 * feel as a broken promise — «раз в 20–30 секунд» and then a minute of nothing —
 * so it is held at the 30 the rule says out loud. It was briefly raised to 32
 * with 35 as the gap limit, and nothing needed it: the whole sweep passes at
 * 30/35 with the worst typical pause at 27.3 seconds and the worst single gap at
 * 32.5 (state «лифт 20», the second layer). A guard set above what the game
 * measures is not a guard, it is a note saying the number was inconvenient.
 *
 * `RHYTHM_GAP_LIMIT_SEC` is the one that matters most: it is the longest single
 * stretch where the game asks the player for nothing. It was 252 seconds when
 * this invariant was written, and 63 in the version that was rejected for
 * measuring the mean.
 */
const RHYTHM_TARGET_MIN_SEC = 20;
const RHYTHM_TARGET_MAX_SEC = 30;
const RHYTHM_MIN_SEC = 8;
const RHYTHM_MAX_SEC = 30;
const RHYTHM_GAP_LIMIT_SEC = 35;

/**
 * How much richer each layer has to be than the one above it, per minute of
 * play, in every scenario (PLAN_V1 §5 «глубже всегда выгоднее»).
 *
 * A step has to be worth the deeper waves. The balance this replaced paid 0.8%
 * for the step from the first layer to the second while costing the player 28
 * points of dome, and the old invariant — which only compared the deepest layer
 * with the shallowest — never saw it.
 */
const LAYER_PREMIUM = 1.15;

/** A gap this long or longer is «тишина»: `Rhythm.longShare` sums them up. */
const LONG_GAP_SEC = 40;

/**
 * Share of a shift that may be spent inside gaps of `LONG_GAP_SEC` or longer.
 * The balance this replaced spent 96% of the first shift there.
 */
const LONG_SHARE_LIMIT = 0.05;

/* ------------------------------------------------------------------ helpers */

function quietWaves(balance: Balance): Balance {
  return { ...balance, waves: { ...balance.waves, first_wave_sec: NO_WAVES_SEC } };
}

function layerAt(balance: Balance, index: number): LayerBalance {
  const layer = balance.layers[index];
  if (!layer) {
    throw new RangeError(`no layer ${index} in balance.layers`);
  }
  return layer;
}

/** Rows of a layer, clamped to the grid: the last layer ends at the bottom row. */
function layerRows(balance: Balance, index: number): { top: number; bottom: number } {
  const [top, bottom] = layerAt(balance, index).rows;
  return { top, bottom: Math.min(bottom, balance.shift.grid_depth) };
}

/** Columns in the order the snake takes them: the middle one, then outwards. */
function columnsOutwards(width: number): number[] {
  const home = Math.floor(width / 2);
  const cols: number[] = [home];
  for (let offset = 1; offset < width; offset += 1) {
    if (home - offset >= 0) {
      cols.push(home - offset);
    }
    if (home + offset < width) {
      cols.push(home + offset);
    }
  }
  return cols;
}

/**
 * The snake, cell by cell: one column dug top to bottom, the next one bottom to
 * top, and so on outwards from the middle. Every column change is one step
 * sideways into the cell the drill is already standing next to — no climbing
 * back to the top of the layer between teeth.
 *
 * The direction matters more than it looks. A comb that always digs downwards
 * has to drive the whole height of the layer back up before every new tooth,
 * and that toll is charged per column, so it eats a tenth of a shift spent in
 * the thin fast first layer and a fortieth of one spent in the third — it would
 * make depth look good by punishing the shallows. The snake pays one cell.
 *
 * `layerIndex` null means the whole mine: the shaft an ordinary shift sinks,
 * used by the progression run that defines what "typical upgrades" means.
 */
function buildPlan(balance: Balance, layerIndex: number | null): GridPos[] {
  const width = balance.shift.grid_width;
  const top = layerIndex === null ? ENTRANCE_ROW : layerRows(balance, layerIndex).top;
  const bottom = layerIndex === null ? balance.shift.grid_depth : layerRows(balance, layerIndex).bottom;
  // The layer's own top row is the corridor cell pushed above, so the tooth
  // starts one row below it. Row 0 is the open entrance and never a plan cell.
  const first = Math.max(top + 1, ENTRANCE_ROW + 1);
  const plan: GridPos[] = [];
  columnsOutwards(width).forEach((col, order) => {
    const rows: number[] = [];
    if (top > ENTRANCE_ROW) {
      rows.push(top);
    }
    for (let row = first; row <= bottom; row += 1) {
      rows.push(row);
    }
    if (order % 2 === 1) {
      rows.reverse();
    }
    for (const row of rows) {
      plan.push({ col, row });
    }
  });
  return plan;
}

/** Cells of the grid that are already open before a single one is dug. */
function dugMask(state: ShiftState): boolean[] {
  const mask: boolean[] = [];
  for (let row = 0; row < state.rowCount; row += 1) {
    for (let col = 0; col < state.width; col += 1) {
      mask.push(isDug(state, col, row));
    }
  }
  return mask;
}

interface DugSince {
  /** Seconds of pure drilling. */
  readonly sec: number;
  readonly cells: number;
  /** Shallowest and deepest row that was dug: proof the bot stayed in its layer. */
  readonly minRow: number;
  readonly maxRow: number;
}

/**
 * Seconds of pure drilling: `digTimeSec` — the sim's own function, at the
 * shift's own drill speed — summed over the cells that went from rock to dug.
 */
function digSecondsSince(state: ShiftState, before: readonly boolean[]): DugSince {
  let sec = 0;
  let cells = 0;
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;
  for (let row = 0; row < state.rowCount; row += 1) {
    for (let col = 0; col < state.width; col += 1) {
      const index = row * state.width + col;
      if (isDug(state, col, row) && before[index] === false) {
        sec += digTimeSec(state.balance.layers, row, state.balance.drill.speed_base);
        cells += 1;
        minRow = Math.min(minRow, row);
        maxRow = Math.max(maxRow, row);
      }
    }
  }
  return { sec, cells, minRow, maxRow };
}

/* --------------------------------------------------------------- the clock */

/**
 * One tick of the shift clock, plus a guard for a freeze in `src/sim/shift.ts`
 * that this measurement runs into and is not allowed to fix.
 *
 * `step` slices time on `timeToNextEvent` and gives up on the whole shift when
 * that slice is not greater than its float epsilon (1e-9 s). Every other event
 * has a matching transition in `resolve`, so an event that close is applied and
 * the clock moves on. The travelling drill has none: when a partial move leaves
 * it less than `EPS * move_rows_per_sec` short of the cell it is driving into,
 * `timeToNextEvent` returns less than an epsilon, `resolve` sees a path that is
 * not empty yet and does nothing, and the shift stops for good — the timer
 * freezes, the drill freezes, no phase ever ends it.
 *
 * Rare, but not theoretical: at a one-millisecond step this measurement walks
 * into it about once per shift as soon as the elevator upgrade makes the travel
 * speed a number like 9.6 cells per second, and never at 8. The fix belongs in
 * `src/sim/shift.ts` — the defence already floors its own events at
 * `MIN_EVENT_SEC` for exactly this reason, the drill's travel does not — so all
 * that happens here is a nudge onto the cell the drill had all but reached
 * (under eight billionths of a cell), counted and printed with the results.
 *
 * Returns true when the tick moved the shift, false when it had to be nudged.
 */
function tick(state: ShiftState): boolean {
  const phaseBefore = state.phase;
  const timeBefore = state.timeLeftSec;
  const colBefore = state.drill.col;
  const rowBefore = state.drill.row;
  const pathBefore = state.drill.path.length;
  const digBefore = state.drill.digElapsedSec;
  const bankBefore = state.drill.bankElapsedSec;

  step(state, SAMPLE_SEC);

  const moved =
    state.phase !== phaseBefore ||
    state.timeLeftSec !== timeBefore ||
    state.drill.col !== colBefore ||
    state.drill.row !== rowBefore ||
    state.drill.path.length !== pathBefore ||
    state.drill.digElapsedSec !== digBefore ||
    state.drill.bankElapsedSec !== bankBefore;
  if (moved) {
    return true;
  }

  const next = state.drill.path[0];
  if (state.drill.mode !== 'moving' || !next) {
    throw new Error(`the shift froze in mode "${state.drill.mode}" and the nudge does not fit`);
  }
  state.drill.col = next.col;
  state.drill.row = next.row;
  state.drill.path.shift();
  return false;
}

/* ---------------------------------------------------------------- the runner */

/** Why a bank-to-bank cycle ended. Only `cargo` cycles are steady ones. */
type CycleEnd = 'cargo' | 'exhausted' | 'timer';

interface Cycle {
  readonly startSec: number;
  readonly endSec: number;
  readonly scrap: number;
  readonly waitSec: number;
  readonly end: CycleEnd;
}

interface MineOptions {
  readonly balance: Balance;
  readonly seed: number;
  /** Layer to stay inside, or null for the whole mine (the progression shift). */
  readonly layerIndex: number | null;
  readonly startRow: number;
  readonly conveyor: boolean;
  /** Fire the salvo the moment it is ready and there is something to hit. */
  readonly salvo: boolean;
}

interface MineRun {
  readonly options: MineOptions;
  readonly state: ShiftState;
  readonly plan: readonly GridPos[];
  readonly startMask: readonly boolean[];
  planIndex: number;
  elapsedSec: number;
  /** Seconds the drill stood still with nothing to do but wait for the bot. */
  waitSec: number;
  cycleWaitSec: number;
  banks: number;
  cycles: Cycle[];
  cycleStartSec: number;
  cycleStartScrap: number;
  pendingEnd: CycleEnd | null;
  exhaustedAtSec: number | null;
  /** Re-aims that had to interrupt a cell being dug. Must stay at zero. */
  redirectsWhileDigging: number;
  /** Plan cells that could not be aimed at. Must stay at zero. */
  skipped: number;
  /** Times the shift froze and had to be nudged. See `tick`. */
  nudges: number;
  /**
   * Second of the run every player decision about the mine was taken on
   * (PLAN_V1 §2.6). See `noteDecision` for what counts as one.
   */
  decisionsSec: number[];
  /** When the bottom row was first dug: the five-year plan closes there (§5). */
  bottomAtSec: number | null;
  done: boolean;
}

/**
 * A decision of the player about the mine, for PLAN_V1 §2.6 («игрок решает
 * примерно раз в 20–30 секунд»).
 *
 * Two taps count, and only these two:
 *
 *   - a tap on a cell (`aimDrill`) — where to dig now;
 *   - a tap on the elevator (`callElevator`) — hand the cargo over now.
 *
 * The drill carrying on by itself is explicitly **not** a decision: that is the
 * half-AFK the rule is about, and counting it would measure the drill's work
 * instead of the player's attention. Nor is the salvo: it belongs to the
 * defence, whose own rhythm is the wave interval, and §2.6 is being broken by
 * the mine — the 70% of the screen that asks for nothing.
 *
 * «К ЗАБОЮ» (`src/ui/faceButton.ts`) is a camera control, not an order: it puts
 * the view back on the drill after a hand-over and changes nothing in the mine.
 * It is always the tap right before an `aimDrill`, so counting it would double
 * every hand-over and leave the gaps between decisions exactly where they are.
 */
function noteDecision(run: MineRun): void {
  run.decisionsSec.push(run.elapsedSec);
}

/**
 * Seconds between one decision about the mine and the next, over a whole run.
 *
 * The shift starts the clock, so the wait before the very first tap counts, and
 * so does the tail after the last one: a player who taps once and then watches
 * the drill for three minutes has waited three minutes, whichever end of the
 * shift the silence sits at. Zero-length gaps (two orders inside the same
 * millisecond, which the elevator can produce) are dropped — they are the
 * measurement's own step, not a decision the player could have felt.
 */
function decisionGaps(decisionsSec: readonly number[], windowSec: number): number[] {
  const moments = [0, ...decisionsSec, windowSec];
  const gaps: number[] = [];
  for (let index = 1; index < moments.length; index += 1) {
    const gap = (moments[index] ?? 0) - (moments[index - 1] ?? 0);
    if (gap > SAMPLE_SEC) {
      gaps.push(gap);
    }
  }
  return gaps;
}

/**
 * The rhythm of one run, and why it takes five numbers instead of one.
 *
 * The gaps are **bimodal by construction**, and the first version of this
 * measurement was thrown out for reporting their mean. A hand-over is two
 * decisions in a row — call the elevator, then send the drill back to the face —
 * so every cycle produces one long silence (drive down, dig until the cargo
 * fills) and one short one (drive up, hand over). A first shift measured
 *
 *     48.4  2.4  48.8  2.8  49.2  3.2  49.6  3.6  50.0  4.0  50.4  4.4  47.9
 *
 * has a mean of 28.1 seconds and not one single moment in it that is anything
 * like 28 seconds. The player sits through fifty.
 *
 * `typicalSec` is the number that does not lie: the length of the gap a random
 * second of the shift falls inside, which is `Σ g² / Σ g`. It weighs every gap
 * by how much of the player's time it actually occupies, so a minute of silence
 * counts as a minute and a two-second double tap counts as two seconds. On the
 * sequence above it gives 46.4 — which is what playing it feels like. This is
 * the number PLAN_V1 §2.6 is held to.
 *
 * `medianSec` is kept beside it as a cross-check (it is what the review that
 * found the bug reported), `longShare` says how much of the shift is spent
 * inside silences of `LONG_GAP_SEC` or more, and `gaps` is printed in order so
 * that the shape can be seen and not just trusted.
 */
interface Rhythm {
  readonly decisions: number;
  /** Length of the gap a random second of the shift falls into: Σg²/Σg. */
  readonly typicalSec: number;
  readonly medianSec: number;
  readonly meanSec: number;
  readonly maxSec: number;
  /** Share of the shift spent inside gaps of `LONG_GAP_SEC` or longer. */
  readonly longShare: number;
  readonly gaps: readonly number[];
}

function rhythmOf(decisionsSec: readonly number[], windowSec: number): Rhythm {
  const gaps = decisionGaps(decisionsSec, windowSec);
  if (gaps.length === 0) {
    return {
      decisions: decisionsSec.length,
      typicalSec: windowSec,
      medianSec: windowSec,
      meanSec: windowSec,
      maxSec: windowSec,
      longShare: 1,
      gaps: [windowSec],
    };
  }
  const total = gaps.reduce((sum, gap) => sum + gap, 0);
  const squared = gaps.reduce((sum, gap) => sum + gap * gap, 0);
  const sorted = [...gaps].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const longSec = gaps.filter((gap) => gap >= LONG_GAP_SEC).reduce((sum, gap) => sum + gap, 0);
  return {
    decisions: decisionsSec.length,
    typicalSec: squared / total,
    medianSec: median,
    meanSec: total / gaps.length,
    maxSec: Math.max(...gaps),
    longShare: longSec / total,
    gaps,
  };
}

function advancePlan(run: MineRun): void {
  while (run.planIndex < run.plan.length) {
    const cell = run.plan[run.planIndex];
    if (!cell || !isDug(run.state, cell.col, cell.row)) {
      break;
    }
    run.planIndex += 1;
  }
  if (run.planIndex >= run.plan.length && run.exhaustedAtSec === null) {
    run.exhaustedAtSec = run.elapsedSec;
  }
}

function aimNext(run: MineRun): void {
  for (let guard = 0; guard < 16; guard += 1) {
    const cell = run.plan[run.planIndex];
    if (!cell) {
      return;
    }
    if (aimDrill(run.state, cell.col, cell.row)) {
      noteDecision(run);
      return;
    }
    run.planIndex += 1;
    run.skipped += 1;
  }
}

function requestBank(run: MineRun, end: CycleEnd): void {
  if (callElevator(run.state)) {
    noteDecision(run);
    run.pendingEnd = end;
  }
}

/** One decision of the player, taken every `SAMPLE_SEC` of simulated time. */
function botTick(run: MineRun): void {
  const state = run.state;
  if (state.phase !== 'running') {
    return;
  }
  if (run.options.salvo && state.defense.enemies.length > 0) {
    fireSalvo(state);
  }

  const drill = state.drill;
  if (drill.mode === 'banking') {
    return;
  }

  advancePlan(run);
  const next = run.plan[run.planIndex];

  if (!next) {
    // The layer is dug out. With a conveyor everything is already handed over,
    // so the run is simply over; otherwise the last cargo goes up first.
    if (state.autoBank) {
      run.done = true;
      return;
    }
    if (state.cargo > 0) {
      if (drill.target?.kind !== 'surface') {
        requestBank(run, 'exhausted');
      }
      return;
    }
    run.done = true;
    return;
  }

  if (drill.mode === 'blocked') {
    requestBank(run, 'cargo');
    return;
  }
  if (drill.mode === 'idle') {
    aimNext(run);
    return;
  }

  const target = drill.target;
  if (target?.kind === 'surface') {
    return;
  }
  if (target?.kind === 'cell' && target.col === next.col && target.row === next.row) {
    return;
  }
  // The drill carried on by itself past a turn of the snake: send it back.
  if (drill.mode === 'digging') {
    run.redirectsWhileDigging += 1;
  }
  aimNext(run);
}

function runMine(options: MineOptions): MineRun {
  const state = createShift(options.balance, options.seed, {
    startRow: options.startRow,
    autoBank: options.conveyor,
  });
  const run: MineRun = {
    options,
    state,
    plan: buildPlan(options.balance, options.layerIndex),
    startMask: dugMask(state),
    planIndex: 0,
    elapsedSec: 0,
    waitSec: 0,
    cycleWaitSec: 0,
    banks: 0,
    cycles: [],
    cycleStartSec: 0,
    cycleStartScrap: 0,
    pendingEnd: null,
    exhaustedAtSec: null,
    redirectsWhileDigging: 0,
    skipped: 0,
    nudges: 0,
    decisionsSec: [],
    bottomAtSec: null,
    done: false,
  };

  const hardCapSec = options.balance.shift.duration_sec * 3 + 120;
  while (!run.done && state.phase !== 'finished') {
    if (run.elapsedSec > hardCapSec) {
      throw new Error(`the shift did not finish in ${hardCapSec} s: the bot is stuck`);
    }
    botTick(run);
    if (run.done) {
      break;
    }
    const modeBefore = state.drill.mode;
    if (modeBefore === 'idle' || modeBefore === 'blocked') {
      run.waitSec += SAMPLE_SEC;
      run.cycleWaitSec += SAMPLE_SEC;
    }
    if (tick(state)) {
      run.elapsedSec += SAMPLE_SEC;
    } else {
      run.nudges += 1;
      // The nudge itself costs no time, so the waiting counted above did not
      // happen either.
      if (modeBefore === 'idle' || modeBefore === 'blocked') {
        run.waitSec -= SAMPLE_SEC;
        run.cycleWaitSec -= SAMPLE_SEC;
      }
    }

    if (run.bottomAtSec === null && state.deepestRow >= options.balance.shift.grid_depth) {
      run.bottomAtSec = run.elapsedSec;
    }

    if (modeBefore === 'banking' && state.drill.mode !== 'banking') {
      run.banks += 1;
      const end = run.pendingEnd ?? 'timer';
      run.cycles.push({
        startSec: run.cycleStartSec,
        endSec: run.elapsedSec,
        scrap: state.banked - run.cycleStartScrap,
        waitSec: run.cycleWaitSec,
        end,
      });
      run.cycleStartSec = run.elapsedSec;
      run.cycleStartScrap = state.banked;
      run.cycleWaitSec = 0;
      run.pendingEnd = null;
      if (end === 'exhausted') {
        run.done = true;
      }
    }
  }
  return run;
}

/* --------------------------------------------------------------- one result */

interface MineResult {
  readonly layerIndex: number;
  readonly upgraded: boolean;
  readonly conveyor: boolean;
  /** Seconds from the start of the shift to the last scrap handed over. */
  readonly windowSec: number;
  readonly scrap: number;
  /** Mean over `SEEDS`: the only thing in this run the seed changes. */
  readonly crystals: number;
  readonly cells: number;
  readonly digSec: number;
  readonly roadSec: number;
  readonly bankSec: number;
  readonly waitSec: number;
  readonly trips: number;
  /** Steady bank-to-bank cycles: the loop the napkin in GOAL_V1 estimated. */
  readonly steadyCycles: number;
  readonly steadySec: number;
  readonly steadyScrap: number;
  readonly steadyWaitSec: number;
  readonly steadyDigSec: number;
  readonly exhaustedAtSec: number | null;
  /** Cells the layer still had to give when the shift started. */
  readonly layerCells: number;
  /** Scrap the whole layer is worth: its cell count times its yield. */
  readonly layerScrap: number;
  readonly layerYield: number;
  /** Rows the bot actually dug. Must stay inside the layer it measures. */
  readonly minRow: number;
  readonly maxRow: number;
  readonly redirectsWhileDigging: number;
  readonly skipped: number;
  /** Freezes of src/sim/shift.ts this run had to nudge past. See `tick`. */
  readonly nudges: number;
  /** PLAN_V1 §2.6: how often the player is asked for anything. */
  readonly rhythm: Rhythm;
}

/** Seconds one hand-over costs in the scenario a result came from. */
function bankSecOf(result: MineResult): number {
  return result.conveyor ? 0 : BALANCE.shift.elevator_bank_sec;
}

function scrapPerMin(scrap: number, sec: number): number {
  return sec > 0 ? (scrap / sec) * 60 : 0;
}

/**
 * Every upgrade state the rhythm of §2.6 has to survive — and the reason this
 * list exists at all.
 *
 * The version of this measurement that was rejected guarded «с прокачкой и без»,
 * where «прокачка» meant one thing: whatever the greedy shopper of the
 * progression run happened to own after three shifts. That shopper did not buy
 * cargo until the sixth shift, so nobody ever measured a player with one cargo
 * level — and one cargo level was exactly what took `floor(capacity / yield)`
 * from two cells to three and put a 38-second silence back into the first layer.
 * An invariant that cannot see the most obvious purchase in the game is not an
 * invariant.
 *
 * So the states are enumerated by hand instead: every branch that touches the
 * loop, alone, low and high, and a few combinations. `cargo: 1` is in here by
 * name, and it is the one that used to break.
 */
interface UpgradeState {
  readonly name: string;
  readonly upgrades: UpgradeLevels;
  /** Five-year plan the state is measured in. Absent means the first one. */
  readonly plan?: number;
}

const RHYTHM_STATES: readonly UpgradeState[] = [
  { name: 'ничего', upgrades: {} },
  { name: 'карго 1', upgrades: { cargo: 1 } },
  { name: 'карго 4', upgrades: { cargo: 4 } },
  { name: 'карго 12', upgrades: { cargo: 12 } },
  { name: 'карго 24', upgrades: { cargo: 24 } },
  { name: 'бур 6', upgrades: { drill: 6 } },
  { name: 'бур 20', upgrades: { drill: 20 } },
  { name: 'бур 45', upgrades: { drill: 45 } },
  { name: 'лифт 6', upgrades: { elevator: 6 } },
  // The elevator is the branch that cuts the road, so it shortens the trip
  // without touching the digging — it pushes the typical pause *down* and the
  // road-heavy deep layer least of all. Twenty levels is past anything the arc
  // buys (six), and it is here because the sweep decides the band: a state the
  // sweep cannot see cannot be argued about.
  { name: 'лифт 20', upgrades: { elevator: 20 } },
  { name: 'карго 1 + бур 3', upgrades: { cargo: 1, drill: 3 } },
  { name: 'карго 1 + бур 6', upgrades: { cargo: 1, drill: 6 } },
  { name: 'карго 6 + бур 6', upgrades: { cargo: 6, drill: 6 } },
  // What the progression run actually owns when it reaches the bottom — the end
  // of the arc, copied from the «всё куплено» line of table 5 rather than
  // guessed. If that line moves, this one moves with it.
  { name: 'всё к концу дуги', upgrades: { cargo: 27, drill: 60, elevator: 6 } },
];

/**
 * Five-year plans the measurement runs, and why there is more than one.
 *
 * Reaching the bottom is the win, and the win hands the player the next plan
 * (`startNextPlan`): richer ore against heavier waves. That makes every plan a
 * reachable state of the game — the second one with certainty, since it is the
 * reward for finishing the first — and everything §2.6 and §5 promise has to
 * hold there too.
 *
 * Nothing here used to look past the first plan, and a plan that multiplied the
 * ore while leaving the backpack alone got all the way through review: from the
 * second plan on, `floor(capacity / yield)` fell to zero in the deepest layer
 * and the mine could not be dug at all. An invariant that counts from `BALANCE`
 * instead of from `planBalance(BALANCE, plan)` is blind to the whole second half
 * of the game.
 *
 * Plans 1, 2, 3 and 5: the first, the one the win hands out, the one after it,
 * and a far one where the multiplier has compounded four times.
 */
const MEASURED_PLANS: readonly number[] = [1, 2, 3, 5];

/** Upgrade states every plan is measured under: bare, mid-arc, end of arc. */
const PLAN_STATES: readonly UpgradeState[] = [
  { name: 'без прокачки', upgrades: {} },
  { name: 'карго 12', upgrades: { cargo: 12 } },
  { name: 'конец дуги', upgrades: { cargo: 27, drill: 60, elevator: 6 } },
];

interface RhythmProbe {
  readonly state: string;
  readonly plan: number;
  readonly layerIndex: number;
  /** Cells that went from rock to dug. Zero means the mine is unplayable. */
  readonly cells: number;
  /** Scrap actually handed over. Zero means the same. */
  readonly banked: number;
  readonly cellsPerTrip: number;
  readonly scrapPerMin: number;
  readonly rhythm: Rhythm;
}

/**
 * One layer under one upgrade state, on one seed. Lighter than `measureLayer`:
 * the crystal average needs five seeds, the rhythm and the rate do not.
 */
function probeRhythm(layerIndex: number, state: UpgradeState): RhythmProbe {
  const plan = state.plan ?? 1;
  // The same order the game itself uses (`shiftBalance`): the plan first, the
  // levels bought on top of it.
  const balance = effectiveBalance(planBalance(quietWaves(BALANCE), plan), state.upgrades);
  const { top } = layerRows(balance, layerIndex);
  const run = runMine({
    balance,
    seed: SEEDS[0] ?? 1,
    layerIndex,
    startRow: top,
    conveyor: false,
    salvo: false,
  });
  const dug = digSecondsSince(run.state, run.startMask);
  // The rate of the steady cycle, not of the whole window: a window holds a
  // whole number of trips plus a stump, and one trip more or less swings the
  // window rate by a twelfth. Comparing layers on that noise would make the
  // depth premium look like it moves when nothing moved.
  const steady = run.cycles.slice(1).filter((cycle) => cycle.end === 'cargo');
  const steadySec = steady.reduce((sum, cycle) => sum + (cycle.endSec - cycle.startSec), 0);
  const steadyScrap = steady.reduce((sum, cycle) => sum + cycle.scrap, 0);
  return {
    state: state.name,
    plan,
    layerIndex,
    cells: dug.cells,
    banked: run.state.banked,
    cellsPerTrip: run.banks > 0 ? dug.cells / run.banks : dug.cells,
    scrapPerMin:
      steady.length >= 2
        ? scrapPerMin(steadyScrap, steadySec)
        : scrapPerMin(run.state.banked, run.elapsedSec),
    rhythm: rhythmOf(run.decisionsSec, run.elapsedSec),
  };
}

function measureLayer(layerIndex: number, upgrades: UpgradeLevels, conveyor: boolean): MineResult {
  const balance = effectiveBalance(quietWaves(BALANCE), upgrades);
  const { top } = layerRows(balance, layerIndex);
  const runs = SEEDS.map((seed) =>
    runMine({ balance, seed, layerIndex, startRow: top, conveyor, salvo: false }),
  );
  const first = runs[0];
  if (!first) {
    throw new Error('no seeds to measure');
  }
  // Only the crystal roll depends on the seed, so every run has to agree on the
  // clock and on the scrap. If it ever does not, the measurement is broken.
  for (const run of runs) {
    if (Math.abs(run.elapsedSec - first.elapsedSec) > 1e-6 || run.state.banked !== first.state.banked) {
      throw new Error('the same scenario ran differently on two seeds');
    }
  }

  const dig = digSecondsSince(first.state, first.startMask);
  const bankSec = first.banks * balance.shift.elevator_bank_sec;
  const steady = first.cycles.slice(1).filter((cycle) => cycle.end === 'cargo');
  // The elevator shaft is already open where it crosses the layer, so the cells
  // the layer can still pay for are the plan minus what the lift dug for free.
  const layerCells = first.plan.filter(
    (cell) => first.startMask[cell.row * first.state.width + cell.col] === false,
  ).length;

  return {
    layerIndex,
    upgraded: Object.keys(upgrades).length > 0,
    conveyor,
    windowSec: first.elapsedSec,
    scrap: first.state.banked,
    crystals: runs.reduce((sum, run) => sum + run.state.crystals, 0) / runs.length,
    cells: dig.cells,
    digSec: dig.sec,
    roadSec: first.elapsedSec - dig.sec - bankSec - first.waitSec,
    bankSec,
    waitSec: first.waitSec,
    trips: first.banks,
    steadyCycles: steady.length,
    steadySec: steady.reduce((sum, cycle) => sum + (cycle.endSec - cycle.startSec), 0),
    steadyScrap: steady.reduce((sum, cycle) => sum + cycle.scrap, 0),
    steadyWaitSec: steady.reduce((sum, cycle) => sum + cycle.waitSec, 0),
    // Every cell of a layer costs the same, so the scrap of a cycle says how
    // many cells it dug and `digTimeSec` says how long that took.
    steadyDigSec:
      (steady.reduce((sum, cycle) => sum + cycle.scrap, 0) / layerAt(balance, layerIndex).yield) *
      digTimeSec(balance.layers, layerRows(balance, layerIndex).bottom, balance.drill.speed_base),
    exhaustedAtSec: first.exhaustedAtSec,
    layerCells,
    layerScrap: layerCells * layerAt(balance, layerIndex).yield,
    layerYield: layerAt(balance, layerIndex).yield,
    minRow: dig.minRow,
    maxRow: dig.maxRow,
    redirectsWhileDigging: first.redirectsWhileDigging,
    skipped: first.skipped,
    nudges: runs.reduce((sum, run) => sum + run.nudges, 0),
    rhythm: rhythmOf(first.decisionsSec, first.elapsedSec),
  };
}

/* ----------------------------------------------------------- the whole shift */

interface ShiftResult {
  readonly layerIndex: number;
  readonly upgraded: boolean;
  readonly scrap: number;
  readonly crystals: number;
  readonly waves: number;
  readonly endReason: ShiftEndReason | null;
  readonly domeHp: number;
  readonly domeHpMax: number;
  readonly breachAtSec: number | null;
  readonly nudges: number;
}

/** The same mining bot, but with the dome defence switched on. */
function measureShiftWithWaves(layerIndex: number, upgrades: UpgradeLevels): ShiftResult {
  const balance = effectiveBalance(BALANCE, upgrades);
  const { top } = layerRows(balance, layerIndex);
  const runs = SEEDS.map((seed) =>
    runMine({ balance, seed, layerIndex, startRow: top, conveyor: false, salvo: true }),
  );
  const first = runs[0];
  if (!first) {
    throw new Error('no seeds to measure');
  }
  const report = shiftReport(first.state);
  return {
    layerIndex,
    upgraded: Object.keys(upgrades).length > 0,
    scrap: report.banked,
    crystals: runs.reduce((sum, run) => sum + run.state.crystals, 0) / runs.length,
    waves: report.waves,
    endReason: report.endReason,
    domeHp: first.state.defense.hp,
    domeHpMax: first.state.defense.hpMax,
    breachAtSec: report.endReason === 'breach' ? first.elapsedSec : null,
    nudges: runs.reduce((sum, run) => sum + run.nudges, 0),
  };
}

/* ------------------------------------------------------------------ defence */

interface DefenseResult {
  readonly salvo: boolean;
  readonly firstLeakWave: number | null;
  readonly firstLeakSec: number | null;
  readonly breachWave: number | null;
  readonly breachSec: number | null;
  readonly waves: number;
  readonly leaked: number;
  readonly killed: number;
  readonly domeHp: number;
  readonly domeHpMax: number;
  readonly endReason: ShiftEndReason | null;
}

/**
 * The conditions PLAN_V1 §6 was measured under: a fresh account, nothing bought,
 * the drill standing on the surface. The drill never digs here, so the layer the
 * waves are scaled by stays the first one for the whole shift.
 */
function measureDefense(salvo: boolean): DefenseResult {
  const state = createShift(BALANCE, SEEDS[0] ?? 1, {});
  let elapsedSec = 0;
  let firstLeakWave: number | null = null;
  let firstLeakSec: number | null = null;
  let breachWave: number | null = null;
  let breachSec: number | null = null;

  while (state.phase !== 'finished') {
    if (salvo && state.defense.enemies.length > 0) {
      fireSalvo(state);
    }
    const before = state.defense.enemies.map((enemy) => ({
      id: enemy.id,
      wave: enemy.wave,
      progress: enemy.progress,
    }));
    const leakedBefore = state.defense.leaked;

    if (tick(state)) {
      elapsedSec += SAMPLE_SEC;
    }

    const leaks = state.defense.leaked - leakedBefore;
    if (leaks > 0 && firstLeakWave === null) {
      // The ones that vanished nearest the dome are the ones that reached it.
      const alive = new Set(state.defense.enemies.map((enemy) => enemy.id));
      const gone = before
        .filter((enemy) => !alive.has(enemy.id))
        .sort((a, b) => b.progress - a.progress);
      const leaker = gone[0];
      if (leaker) {
        firstLeakWave = leaker.wave;
        firstLeakSec = elapsedSec;
      }
    }
    if (state.endReason === 'breach' && breachWave === null) {
      breachWave = state.defense.wavesSent;
      breachSec = elapsedSec;
    }
  }

  const report = shiftReport(state);
  return {
    salvo,
    firstLeakWave,
    firstLeakSec,
    breachWave,
    breachSec,
    waves: report.waves,
    leaked: state.defense.leaked,
    killed: state.defense.killed,
    domeHp: state.defense.hp,
    domeHpMax: state.defense.hpMax,
    endReason: report.endReason,
  };
}

/* -------------------------------------------------------- typical upgrades */

/**
 * Ordinary play, shift after shift: each one sinks a shaft from the deepest
 * checkpoint the previous one opened, waves on and the salvo used, everything
 * handed over spent the way rule №4 of PLAN_V1 §2 invites — always on the
 * cheapest thing on offer. It runs until the bottom of the Abyss is dug, which
 * is the number issue #14 is about, or until `MAX_PROGRESSION_SHIFTS`.
 *
 * Nothing is held back from the shopping, the conveyor included: over a whole
 * week of play it is a purchase a real player reaches, and leaving it out would
 * measure a game nobody plays. It is bought when it becomes the cheapest thing
 * on offer — which, at 1.4 per level, is once the elevator has outgrown it.
 *
 * «Типичная прокачка» of tables 1, 2 and 4 is this run frozen after
 * `TYPICAL_AFTER_SHIFTS` shifts.
 */
interface ProgressionShift {
  readonly index: number;
  readonly startRow: number;
  readonly scrap: number;
  readonly crystals: number;
  readonly deepestRow: number;
  /** New rows this shift dug: the shaft is fresh rock again every shift. */
  readonly cells: number;
  /** Rows of depth this shift added to the record. Zero is a shift that stood still. */
  readonly gained: number;
  readonly waves: number;
  readonly endReason: ShiftEndReason | null;
  /** Second of the shift the bottom row was dug on, if it was. */
  readonly bottomAtSec: number | null;
  /** Upgrade levels bought with what this shift paid. */
  readonly bought: number;
  /** The cheapest thing still on offer once that money is spent, and how far it is. */
  readonly nextId: string;
  readonly nextCost: number;
  readonly nextSec: number;
  /** Everything owned once that money is spent. */
  readonly levels: string;
  readonly nudges: number;
  /** PLAN_V1 §2.6: decisions about the mine this shift asked for. */
  readonly rhythm: Rhythm;
}

interface Progression {
  readonly shifts: readonly ProgressionShift[];
  readonly profile: Profile;
  /** Levels owned after `TYPICAL_AFTER_SHIFTS`: «прокачка» of tables 1, 2 and 4. */
  readonly typical: UpgradeLevels;
  /** Shift the bottom was dug on, or null when the run never got there. */
  readonly bottomShift: number | null;
}

/**
 * How far the next upgrade is, in seconds of played shift (PLAN_V1 §2 rule 4).
 *
 * Measured where the player actually stands: at the base, right after spending
 * everything they could on the cheapest branches. What is left in the wallet
 * counts, and the missing part is divided by what the shift that has just ended
 * paid per second of its own length — the honest answer to «сколько ещё играть
 * до следующей покупки», assuming the next shift pays like the last one.
 *
 * Every branch is timed, not just the cheapest one by price: a crystal branch
 * three crystals away can be nearer in time than a scrap branch that costs a
 * hundred, and the rule is about what the player can look forward to next.
 * A branch whose currency the shift did not pay at all is infinitely far.
 */
function secondsToNextUpgrade(
  profile: Profile,
  ratePerSec: Readonly<Record<string, number>>,
): { readonly id: string; readonly cost: number; readonly sec: number } {
  let best = { id: '—', cost: 0, sec: Number.POSITIVE_INFINITY };
  for (const id of upgradeIds(BALANCE)) {
    const next = nextUpgrade(BALANCE, profile, id);
    if (!next) {
      continue;
    }
    const missing = Math.max(0, next.cost - walletAmount(profile, next.currency));
    const rate = ratePerSec[next.currency] ?? 0;
    const sec = missing === 0 ? 0 : rate > 0 ? missing / rate : Number.POSITIVE_INFINITY;
    if (sec < best.sec || (sec === best.sec && next.cost < best.cost)) {
      best = { id, cost: next.cost, sec };
    }
  }
  return best;
}

function buyGreedy(profile: Profile, skip: readonly string[]): { profile: Profile; bought: string[] } {
  const bought: string[] = [];
  for (let guard = 0; guard < 500; guard += 1) {
    let bestId: string | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const id of upgradeIds(BALANCE)) {
      if (skip.includes(id)) {
        continue;
      }
      const next = nextUpgrade(BALANCE, profile, id);
      if (!next || walletAmount(profile, next.currency) < next.cost || next.cost >= bestCost) {
        continue;
      }
      bestId = id;
      bestCost = next.cost;
    }
    if (bestId === null) {
      break;
    }
    const after = buyUpgrade(BALANCE, profile, bestId);
    if (!after) {
      break;
    }
    profile = after;
    bought.push(bestId);
  }
  return { profile, bought };
}

function runProgression(): Progression {
  let profile = createProfile(BALANCE);
  const shifts: ProgressionShift[] = [];
  let typical: UpgradeLevels = profile.upgrades;
  let bottomShift: number | null = null;
  for (let index = 1; index <= MAX_PROGRESSION_SHIFTS && bottomShift === null; index += 1) {
    const balance = shiftBalance(BALANCE, profile);
    const startRow = deepestOpenCheckpoint(BALANCE, profile);
    const deepestBefore = profile.deepestRow;
    const run = runMine({
      balance,
      seed: index,
      layerIndex: null,
      startRow,
      conveyor: hasConveyor(profile),
      salvo: true,
    });
    const report = shiftReport(run.state);
    const dug = digSecondsSince(run.state, run.startMask);
    const outcome = applyShiftResult(BALANCE, profile, report);
    const purchase = buyGreedy(outcome.profile, []);
    profile = purchase.profile;
    // What the shift paid per second of its own length: the rate the wait for
    // the next upgrade is measured against.
    const seconds = BALANCE.shift.duration_sec;
    const ratePerSec: Record<string, number> = {
      [scrapId(BALANCE)]: outcome.scrapEarned / seconds,
      [crystalId(BALANCE)]: outcome.crystalsEarned / seconds,
    };
    const next = secondsToNextUpgrade(profile, ratePerSec);
    shifts.push({
      index,
      startRow,
      scrap: outcome.scrapEarned,
      crystals: outcome.crystalsEarned,
      deepestRow: report.deepestRow,
      cells: dug.cells,
      gained: Math.max(0, report.deepestRow - deepestBefore),
      waves: report.waves,
      endReason: report.endReason,
      bottomAtSec: run.bottomAtSec,
      bought: purchase.bought.length,
      nextId: next.id,
      nextCost: next.cost,
      nextSec: next.sec,
      levels: levelsText(profile),
      nudges: run.nudges,
      rhythm: rhythmOf(run.decisionsSec, run.elapsedSec),
    });
    if (index <= TYPICAL_AFTER_SHIFTS) {
      typical = profile.upgrades;
    }
    if (isBottomReached(BALANCE, profile)) {
      bottomShift = index;
    }
  }
  return { shifts, profile, typical, bottomShift };
}

/* ------------------------------------------------------------------- report */

function pad(text: string, width: number, right: boolean): string {
  const gap = ' '.repeat(Math.max(0, width - text.length));
  return right ? gap + text : text + gap;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  // A column of numbers is right-aligned; a dash where a number would not mean
  // anything (no steady cycle, no trips) does not make the column text.
  const numeric = headers.map(
    (_, index) =>
      rows.some((row) => /^[+-]?\d/.test(row[index] ?? '')) &&
      rows.every((row) => /^[+-]?\d/.test(row[index] ?? '') || (row[index] ?? '') === '—'),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => pad(cell, widths[index] ?? 0, numeric[index] === true))
      .join('  ')
      .trimEnd();
  const rule = widths.map((width) => '─'.repeat(width)).join('  ');
  return [line(headers), rule, ...rows.map(line)].join('\n');
}

function num(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function layerName(index: number): string {
  return layerAt(BALANCE, index).id;
}

function scenarioName(upgraded: boolean, conveyor: boolean): string {
  return `${upgraded ? 'прокачка' : 'без прокачки'} / ${conveyor ? 'конвейер' : 'без конвейера'}`;
}

function levelsText(profile: Profile): string {
  const parts = upgradeIds(BALANCE)
    .filter((id) => upgradeLevel(profile, id) > 0)
    .map((id) => `${id} ${upgradeLevel(profile, id)}`);
  return parts.length > 0 ? parts.join(', ') : 'ничего';
}

/* -------------------------------------------------------------- the measure */

let income: MineResult[] = [];
let shiftsWithWaves: ShiftResult[] = [];
let defenseBare: DefenseResult;
let defenseSalvo: DefenseResult;
let progression: Progression;
let typical: UpgradeLevels;
let probes: RhythmProbe[] = [];
let planProbes: RhythmProbe[] = [];
let report = '';

function buildReport(): string {
  const lines: string[] = [];
  const layers = BALANCE.layers.map((layer, index) => ({ layer, index }));

  lines.push('');
  lines.push('════════════════════════════════════════════════════════════════════════════════');
  lines.push('  ЗАМЕР БАЛАНСА «ВОСТОК-9» — прогон src/sim, не арифметика');
  lines.push('════════════════════════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(
    `Смена ${BALANCE.shift.duration_sec} с · сетка ${BALANCE.shift.grid_width}×${BALANCE.shift.grid_depth} · ` +
      `карго ${BALANCE.cargo.capacity_base} · бур ${BALANCE.drill.move_rows_per_sec} ряд/с · ` +
      `сдача ${BALANCE.shift.elevator_bank_sec} с`,
  );
  lines.push(
    `Слои: ${layers
      .map(({ layer }) => `${layer.id} ${layer.rows[0]}–${layer.rows[1]}, ${layer.hardness_sec} с/кл, ${layer.yield} лома, крист ${Math.round(layer.crystal_chance * 100)}%`)
      .join(' · ')}`,
  );
  lines.push(`Шаг замера ${SAMPLE_SEC * 1000} мс · кристаллы усреднены по сидам ${SEEDS.join(',')}`);
  lines.push('');
  lines.push('Бот: змейка внутри слоя (колонка вниз, соседняя вверх, от центра к краям),');
  lines.push('сдача по заполнению карго, окно замера — от старта смены до последней сдачи.');
  lines.push('Волны в таблицах 1–2 выключены: смена, оборванная пробитием, мерила бы купол.');

  lines.push('');
  lines.push('── 1. ДОХОДНОСТЬ СЛОЯ ───────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(
    table(
      [
        'сценарий',
        'слой',
        'лом/мин',
        'крист/мин',
        'сдано',
        'окно, с',
        'циклов',
        'цикл, с',
        'лом/мин в цикле',
        'слой кончился',
        'в слое всего',
      ],
      income.map((result) => [
        scenarioName(result.upgraded, result.conveyor),
        layerName(result.layerIndex),
        num(scrapPerMin(result.scrap, result.windowSec)),
        num((result.crystals / result.windowSec) * 60, 2),
        num(result.scrap, 0),
        num(result.windowSec),
        String(result.steadyCycles),
        result.steadyCycles > 0 ? num(result.steadySec / result.steadyCycles, 2) : '—',
        result.steadyCycles > 0 ? num(scrapPerMin(result.steadyScrap, result.steadySec)) : '—',
        result.exhaustedAtSec === null
          ? `нет, взято ${result.cells} кл.`
          : `${num(result.exhaustedAtSec, 0)} с`,
        `${result.layerCells} кл. = ${result.layerScrap} лома`,
      ]),
    ),
  );

  lines.push('');
  lines.push('── 2. КУДА УХОДИТ ВРЕМЯ ─────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(
    table(
      [
        'сценарий',
        'слой',
        'копка, с',
        'дорога, с',
        'сдача, с',
        'поездок',
        'копка, %',
        'дорога+сдача, %',
        'в цикле копка, %',
        'в цикле дорога+сдача, %',
      ],
      income.map((result) => {
        const cycleRoad = result.steadySec - result.steadyDigSec - result.steadyCycles * bankSecOf(result) - result.steadyWaitSec;
        return [
          scenarioName(result.upgraded, result.conveyor),
          layerName(result.layerIndex),
          num(result.digSec),
          num(result.roadSec),
          num(result.bankSec),
          String(result.trips),
          num((result.digSec / result.windowSec) * 100),
          num(((result.roadSec + result.bankSec) / result.windowSec) * 100),
          result.steadyCycles > 0 ? num((result.steadyDigSec / result.steadySec) * 100) : '—',
          result.steadyCycles > 0
            ? num(((cycleRoad + result.steadyCycles * bankSecOf(result)) / result.steadySec) * 100)
            : '—',
        ];
      }),
    ),
  );
  lines.push('');
  lines.push(
    `Простой (бур стоит и ждёт приказа бота) за весь замер: ${num(
      income.reduce((sum, result) => sum + result.waitSec, 0),
      3,
    )} с — на числа не влияет.`,
  );

  lines.push('');
  lines.push('── 3. ОБОРОНА: ФОРМА СЛОЖНОСТИ §6 (без прокачки, бур на поверхности) ────────────');
  lines.push('');
  lines.push(
    table(
      ['режим', 'первый прилёт', 'пробитие', 'чем кончилась', 'купол', 'волн', 'сбито', 'прилетело'],
      [defenseBare, defenseSalvo].map((result) => [
        result.salvo ? 'залп по готовности' : 'без залпа',
        result.firstLeakWave === null
          ? 'ни одного'
          : `волна ${result.firstLeakWave}, ${num(result.firstLeakSec ?? 0, 0)} с`,
        result.breachWave === null ? 'нет' : `волна ${result.breachWave}, ${num(result.breachSec ?? 0, 0)} с`,
        result.endReason === 'breach' ? 'аварийный подъём' : 'дожила до таймера',
        `${num(result.domeHp, 0)}/${num(result.domeHpMax, 0)}`,
        String(result.waves),
        String(result.killed),
        String(result.leaked),
      ]),
    ),
  );
  lines.push('');
  lines.push(
    `§6 записано: без залпа первый прилёт волна ${SHAPE.bareFirstLeakWave}, пробитие волна ${SHAPE.bareBreachWave}; ` +
      `с залпом — таймер, купол ${SHAPE.salvoDomeHp}/100, первый прилёт волна ${SHAPE.salvoFirstLeakWave}.`,
  );
  lines.push(
    `Замер: без залпа волна ${defenseBare.firstLeakWave} / ${defenseBare.breachWave}, ` +
      `с залпом волна ${defenseSalvo.firstLeakWave}, купол ${num(defenseSalvo.domeHp, 0)}/${num(defenseSalvo.domeHpMax, 0)}. ` +
      `Числа обороны перекройка экономики не трогала, и форма осталась той же.`,
  );

  lines.push('');
  lines.push('── 4. ТОТ ЖЕ СЛОЙ, НО С ВОЛНАМИ (залп по готовности) ────────────────────────────');
  lines.push('');
  lines.push(
    table(
      ['прокачка', 'слой', 'сдано', 'крист', 'волн', 'чем кончилась', 'купол'],
      shiftsWithWaves.map((result) => [
        result.upgraded ? 'типичная' : 'нет',
        layerName(result.layerIndex),
        num(result.scrap, 0),
        num(result.crystals, 2),
        String(result.waves),
        result.endReason === 'breach'
          ? `пробитие, ${num(result.breachAtSec ?? 0, 0)} с`
          : 'дожила до таймера',
        `${num(result.domeHp, 0)}/${num(result.domeHpMax, 0)}`,
      ]),
    ),
  );
  lines.push('');
  lines.push('Прогон обрывается, когда слой выкопан, — поэтому «волн» мало там, где слой мелкий.');

  lines.push('');
  lines.push('── 5. ДУГА: ОБЫЧНАЯ ИГРА С НУЛЯ ДО ДНА ──────────────────────────────────────────');
  lines.push('');
  lines.push(
    table(
      [
        'смена',
        'старт, ряд',
        'клеток',
        'заработано лома',
        'кристаллов',
        'глубина',
        '+рядов',
        'волн',
        'чем кончилась',
        'куплено уровней',
        'след. покупка',
        'до неё, с',
        'после смены куплено всего',
      ],
      progression.shifts.map((shift) => [
        String(shift.index),
        String(shift.startRow),
        String(shift.cells),
        num(shift.scrap, 0),
        num(shift.crystals, 0),
        String(shift.deepestRow),
        String(shift.gained),
        String(shift.waves),
        shift.endReason === 'breach' ? 'пробитие' : 'таймер',
        String(shift.bought),
        shift.nextId,
        Number.isFinite(shift.nextSec) ? num(shift.nextSec, 0) : '∞',
        shift.levels,
      ]),
    ),
  );
  lines.push('');
  if (progression.bottomShift !== null) {
    const last = progression.shifts[progression.shifts.length - 1];
    lines.push(
      `ДНО ВЗЯТО НА СМЕНЕ ${progression.bottomShift} (ряд ${BALANCE.shift.grid_depth})` +
        `${last?.bottomAtSec === null || last?.bottomAtSec === undefined ? '' : `, на ${num(last.bottomAtSec, 0)}-й секунде смены`}. ` +
        `Цель issue #14 — неделя игры, ${BOTTOM_SHIFTS_MIN}–${BOTTOM_SHIFTS_MAX} смен.`,
    );
  } else {
    lines.push(
      `ДНО НЕ ВЗЯТО за ${progression.shifts.length} смен — глубже ряда ` +
        `${Math.max(...progression.shifts.map((shift) => shift.deepestRow))} прогон не ушёл.`,
    );
  }
  const waits = progression.shifts.map((shift) => shift.nextSec);
  const overLimit = waits.filter((sec) => sec > NEXT_UPGRADE_LIMIT_SEC).length;
  const sortedWaits = [...waits].sort((a, b) => a - b);
  lines.push(
    `Правило §2.4 «следующий апгрейд всегда близко»: дальше всего покупка отходила на ` +
      `${num(Math.max(...waits), 0)} с игры, медиана ${num(sortedWaits[Math.floor(sortedWaits.length / 2)] ?? 0, 0)} с, ` +
      `предел ${NEXT_UPGRADE_LIMIT_SEC} с, за пределом ${overLimit} смен(ы) из ${waits.length}.`,
  );
  lines.push(
    `Глубина: смена добавляла ${num(Math.min(...progression.shifts.map((s) => s.gained)), 0)}–` +
      `${num(Math.max(...progression.shifts.map((s) => s.gained)), 0)} рядов к рекорду, ` +
      `и открывала ${num(Math.min(...progression.shifts.map((s) => s.cells)), 0)}–` +
      `${num(Math.max(...progression.shifts.map((s) => s.cells)), 0)} клеток.`,
  );
  lines.push(`«Прокачка» в таблицах 1, 2 и 4 = после ${TYPICAL_AFTER_SHIFTS} смен, ${levelsText({ ...progression.profile, upgrades: typical })}`);
  lines.push(
    `В кошельке к концу дуги: ${walletAmount(progression.profile, scrapId(BALANCE))} лома, ` +
      `${walletAmount(progression.profile, crystalId(BALANCE))} кристаллов; всё куплено: ${levelsText(progression.profile)}`,
  );

  lines.push('');
  lines.push('── 6. РИТМ РЕШЕНИЙ ИГРОКА (PLAN_V1 §2.6) ────────────────────────────────────────');
  lines.push('');
  lines.push('Решение = тап по клетке (перенацелить бур) или тап по лифту (сдать карго).');
  lines.push('Автопродолжение бура и залп решениями не считаются: §2.6 — про то, как часто');
  lines.push('игра просит игрока, а не про то, как часто она работает сама.');
  lines.push('');
  lines.push('Паузы бимодальны: сдача — это два тапа подряд, между сдачами одна долгая копка.');
  lines.push('Поэтому «типичная» — не среднее, а длина паузы, в которую попадает случайная секунда');
  lines.push('смены (Σg²/Σg): именно её игрок и просиживает. Среднее оставлено рядом как справка.');
  lines.push('');
  lines.push(
    table(
      [
        'сценарий',
        'слой',
        'решений',
        'типичная, с',
        'медиана, с',
        'среднее, с',
        'максимум, с',
        `доля смены в тишине ≥${LONG_GAP_SEC} с`,
      ],
      income.map((result) => [
        scenarioName(result.upgraded, result.conveyor),
        layerName(result.layerIndex),
        String(result.rhythm.decisions),
        num(result.rhythm.typicalSec),
        num(result.rhythm.medianSec),
        num(result.rhythm.meanSec),
        num(result.rhythm.maxSec),
        `${num(result.rhythm.longShare * 100, 0)}%`,
      ]),
    ),
  );
  lines.push('');
  lines.push(
    table(
      [
        'смена',
        'старт, ряд',
        'решений',
        'типичная, с',
        'медиана, с',
        'максимум, с',
        `тишина ≥${LONG_GAP_SEC} с`,
      ],
      progression.shifts.map((shift) => [
        String(shift.index),
        String(shift.startRow),
        String(shift.rhythm.decisions),
        num(shift.rhythm.typicalSec),
        num(shift.rhythm.medianSec),
        num(shift.rhythm.maxSec),
        `${num(shift.rhythm.longShare * 100, 0)}%`,
      ]),
    ),
  );
  lines.push('');
  const firstShift = progression.shifts[0];
  if (firstShift) {
    lines.push('ПЕРВАЯ СМЕНА, все паузы по порядку (с):');
    lines.push(`  ${firstShift.rhythm.gaps.map((gap) => num(gap)).join('  ')}`);
    lines.push(
      `  ${firstShift.rhythm.decisions} решени(й) · типичная ${num(firstShift.rhythm.typicalSec)} с · ` +
        `медиана ${num(firstShift.rhythm.medianSec)} с · среднее ${num(firstShift.rhythm.meanSec)} с · ` +
        `максимум ${num(firstShift.rhythm.maxSec)} с · ` +
        `в тишине ≥${LONG_GAP_SEC} с — ${num(firstShift.rhythm.longShare * 100, 0)}% смены.`,
    );
    lines.push(
      `  Цель §2.6 — ${RHYTHM_TARGET_MIN_SEC}–${RHYTHM_TARGET_MAX_SEC} с; инвариант держит типичную ` +
        `в ${RHYTHM_MIN_SEC}–${RHYTHM_MAX_SEC} с, ни одной паузы длиннее ${RHYTHM_GAP_LIMIT_SEC} с ` +
        `и не больше ${num(LONG_SHARE_LIMIT * 100, 0)}% смены в тишине.`,
    );
  }
  const arcTypical = progression.shifts.map((shift) => shift.rhythm.typicalSec);
  lines.push(
    `Вся дуга: типичная пауза ${num(Math.min(...arcTypical))}–${num(Math.max(...arcTypical))} с, ` +
      `самая долгая пауза за дугу ${num(Math.max(...progression.shifts.map((s) => s.rhythm.maxSec)))} с.`,
  );
  const beltRhythm = income.filter((result) => result.conveyor);
  lines.push(
    `С конвейером решений почти нет (${beltRhythm.map((result) => result.rhythm.decisions).join('/')} ` +
      'за смену по слоям) — он и покупается за то, что убирает ходки (§4). Это осознанная плата ' +
      'за самый дорогой апгрейд игры, а не дыра в §2.6, поэтому инвариант его не сторожит.',
  );

  lines.push('');
  lines.push('── 7. РИТМ И ПРЕМИЯ ПОД КАЖДОЙ ВЕТКОЙ ПРОКАЧКИ ──────────────────────────────────');
  lines.push('');
  lines.push('Не «путь жадного бота», а перебор состояний руками: каждая ветка, которая трогает');
  lines.push('петлю, поодиночке и в связках. Строка «карго 1» — та самая покупка, на которой');
  lines.push('прошлый заход и сломался: одна она делала тишину 38-секундной.');
  lines.push('');
  lines.push(
    table(
      ['состояние', 'слой', 'кл/ходку', 'лом/мин', 'типичная, с', 'максимум, с', `тишина ≥${LONG_GAP_SEC} с`, 'премия к слою выше'],
      probes.map((probe, index) => {
        const previous = probe.layerIndex > 0 ? probes[index - 1] : undefined;
        return [
          probe.layerIndex === 0 ? probe.state : '',
          layerName(probe.layerIndex),
          num(probe.cellsPerTrip, 2),
          num(probe.scrapPerMin, 0),
          num(probe.rhythm.typicalSec),
          num(probe.rhythm.maxSec),
          `${num(probe.rhythm.longShare * 100, 0)}%`,
          previous ? num(probe.scrapPerMin / previous.scrapPerMin, 3) : '—',
        ];
      }),
    ),
  );
  lines.push('');
  lines.push(
    `Худшее по перебору: типичная ${num(Math.min(...probes.map((p) => p.rhythm.typicalSec)))}–` +
      `${num(Math.max(...probes.map((p) => p.rhythm.typicalSec)))} с, ` +
      `самая долгая пауза ${num(Math.max(...probes.map((p) => p.rhythm.maxSec)))} с, ` +
      `тишина ${num(Math.max(...probes.map((p) => p.rhythm.longShare)) * 100, 0)}%.`,
  );

  lines.push('');
  lines.push('── 8. ПЯТИЛЕТКИ: ТА ЖЕ ИГРА ПОСЛЕ ПОБЕДЫ (PLAN_V1 §5) ───────────────────────────');
  lines.push('');
  lines.push('Дно = победа, победа = следующая пятилетка: руда богаче, волны крепче. Значит');
  lines.push('вторая пятилетка — не экзотика, а стопроцентно достижимое состояние, и §2.6 и §5');
  lines.push('обязаны держаться в ней так же, как в первой. Считается всё от planBalance, а не');
  lines.push('от balance.json: пятилетка, которая множила руду и не трогала карго, прошла три');
  lines.push('круга приёмки — во втором плане в ходку влезало НОЛЬ клеток третьего слоя и шахта');
  lines.push('не копалась вовсе, а ни один инвариант туда не смотрел.');
  lines.push('');
  lines.push(
    table(
      ['пятилетка', 'состояние', 'слой', 'карго', 'лом/клетку', 'кл/ходку', 'клеток за смену', 'лом/мин', 'типичная, с', 'максимум, с', 'премия к слою выше'],
      planProbes.map((probe, index) => {
        const state = PLAN_STATES.find((candidate) => candidate.name === probe.state);
        const bent = effectiveBalance(
          planBalance(BALANCE, probe.plan),
          state?.upgrades ?? {},
        );
        const previous = probe.layerIndex > 0 ? planProbes[index - 1] : undefined;
        return [
          probe.layerIndex === 0 ? String(probe.plan) : '',
          probe.layerIndex === 0 ? probe.state : '',
          layerName(probe.layerIndex),
          num(bent.cargo.capacity_base, 0),
          num(layerAt(bent, probe.layerIndex).yield, 0),
          num(probe.cellsPerTrip, 2),
          num(probe.cells, 0),
          num(probe.scrapPerMin, 0),
          num(probe.rhythm.typicalSec),
          num(probe.rhythm.maxSec),
          previous ? num(probe.scrapPerMin / previous.scrapPerMin, 3) : '—',
        ];
      }),
    ),
  );
  lines.push('');
  {
    const dead = planProbes.filter((probe) => probe.cells === 0 || probe.banked === 0);
    lines.push(
      dead.length === 0
        ? `Шахта копается во всех ${MEASURED_PLANS.length} пятилетках (${MEASURED_PLANS.join(', ')}) и во всех трёх слоях: ` +
            `клеток за смену ${num(Math.min(...planProbes.map((p) => p.cells)), 0)}–` +
            `${num(Math.max(...planProbes.map((p) => p.cells)), 0)}, ` +
            'ходка везде той же длины, что в первой пятилетке.'
        : `ШАХТА НЕ КОПАЕТСЯ: ${dead.map((p) => `${p.state}, пятилетка ${p.plan}, ${layerName(p.layerIndex)}`).join('; ')}`,
    );
    lines.push(
      `Худшее по пятилеткам: типичная ${num(Math.min(...planProbes.map((p) => p.rhythm.typicalSec)))}–` +
        `${num(Math.max(...planProbes.map((p) => p.rhythm.typicalSec)))} с, ` +
        `самая долгая пауза ${num(Math.max(...planProbes.map((p) => p.rhythm.maxSec)))} с, ` +
        `тишина ${num(Math.max(...planProbes.map((p) => p.rhythm.longShare)) * 100, 0)}%.`,
    );
  }

  lines.push('');
  lines.push('── ВЫВОД ────────────────────────────────────────────────────────────────────────');
  lines.push('');
  for (const conveyor of [false, true]) {
    for (const upgraded of [false, true]) {
      const rates = layers.map(({ index }) => {
        const found = pickResult(index, upgraded, conveyor);
        return scrapPerMin(found.scrap, found.windowSec);
      });
      const [l1 = 0, l2 = 0, l3 = 0] = rates;
      const shape = l3 >= l2 ? 'глубже — выгоднее' : 'L3 ПЛАТИТ МЕНЬШЕ L2';
      lines.push(
        `${pad(scenarioName(upgraded, conveyor), 34, false)} ` +
          `L1 ${pad(num(l1), 7, true)}  L2 ${pad(num(l2), 7, true)}  L3 ${pad(num(l3), 7, true)}  лом/мин   ${shape}`,
      );
    }
  }
  lines.push('');
  lines.push('Кристаллы в минуту (без прокачки):');
  for (const conveyor of [false, true]) {
    const rates = layers.map(({ index }) => {
      const found = pickResult(index, false, conveyor);
      return (found.crystals / found.windowSec) * 60;
    });
    const [c1 = 0, c2 = 0, c3 = 0] = rates;
    lines.push(
      `${pad(conveyor ? 'с конвейером' : 'без конвейера', 34, false)} ` +
        `L1 ${pad(num(c1, 2), 7, true)}  L2 ${pad(num(c2, 2), 7, true)}  L3 ${pad(num(c3, 2), 7, true)}  крист/мин   ` +
        `${c3 > c2 * 1.05 ? 'глубже — выгоднее' : 'L3 НЕ ЛУЧШЕ L2'}`,
    );
  }

  lines.push('');
  lines.push('── БЫЛО ДО ПРАВКИ РИТМА §2.6 ────────────────────────────────────────────────────');
  lines.push('');
  lines.push(
    table(
      [
        'слой',
        'было: среднее / макс, с',
        'стало: типичная / макс, с',
        'было клеток',
        'стало клеток',
        'было лом/мин',
        'стало лом/мин',
        'было крист/мин',
        'стало крист/мин',
        'было с конвейером',
        'стало с конвейером',
      ],
      layers.map(({ index }) => {
        const plain = pickResult(index, false, false);
        const belt = pickResult(index, false, true);
        return [
          layerName(index),
          `${num(BEFORE_RHYTHM.rhythmMeanSec[index] ?? 0)} / ${num(BEFORE_RHYTHM.rhythmMaxSec[index] ?? 0)}`,
          `${num(plain.rhythm.typicalSec)} / ${num(plain.rhythm.maxSec)}`,
          String(BEFORE_RHYTHM.layerCells[index] ?? 0),
          String(plain.layerCells),
          num(BEFORE_RHYTHM.scrapPerMin[index] ?? 0),
          num(scrapPerMin(plain.scrap, plain.windowSec)),
          num(BEFORE_RHYTHM.crystalPerMin[index] ?? 0, 2),
          num((plain.crystals / plain.windowSec) * 60, 2),
          num(BEFORE_RHYTHM.conveyorScrapPerMin[index] ?? 0),
          num(scrapPerMin(belt.scrap, belt.windowSec)),
        ];
      }),
    ),
  );
  lines.push('');
  lines.push(
    'Колонка «было» — среднее: типичной паузы тогда никто не считал, и в этом была вся ошибка.',
  );
  lines.push(
    `Первая смена: было ${BEFORE_RHYTHM.firstShiftDecisions} решени(й) за смену ` +
      `(среднее ${num(BEFORE_RHYTHM.firstShiftMeanSec)} с, самая долгая пауза ${num(BEFORE_RHYTHM.firstShiftMaxSec)} с), ` +
      `стало ${firstShift?.rhythm.decisions ?? 0} ` +
      `(типичная ${num(firstShift?.rhythm.typicalSec ?? 0)} с, самая долгая ${num(firstShift?.rhythm.maxSec ?? 0)} с, ` +
      `в тишине ≥${LONG_GAP_SEC} с — ${num((firstShift?.rhythm.longShare ?? 0) * 100, 0)}% смены).`,
  );
  lines.push(
    `Дно: было на смене ${BEFORE_RHYTHM.bottomShift}, ` +
      `стало ${progression.bottomShift === null ? 'недостижимо' : `на смене ${progression.bottomShift}`}. ` +
      'Ходка теперь набирает карго за 2 клетки первого слоя вместо шестнадцати, и это число не',
  );
  lines.push(
    'двигает ни один апгрейд: ветка «Карго» поднимает ёмкость и добычу вместе (см. таблицу 7).',
  );

  lines.push('');
  lines.push(
    `§5 требует премию не меньше ${num((LAYER_PREMIUM - 1) * 100, 0)}% на КАЖДОЙ соседней паре во всех ` +
      'четырёх сценариях. Раньше сторожилось только «L3 не хуже L1», и середина шахты жила без присмотра:',
  );
  lines.push('шаг с первого слоя на второй платил 0,8% и стоил игроку 28 очков купола.');
  const nudges =
    income.reduce((sum, result) => sum + result.nudges, 0) +
    shiftsWithWaves.reduce((sum, result) => sum + result.nudges, 0) +
    progression.shifts.reduce((sum, shift) => sum + shift.nudges, 0);
  if (nudges > 0) {
    lines.push('');
    lines.push(
      `ВНИМАНИЕ: смена ${nudges} раз(а) намертво вставала внутри src/sim/shift.ts, и замеру пришлось`,
    );
    lines.push('подтолкнуть бур вручную — см. комментарий к `tick` в этом файле. Это баг симуляции,');
    lines.push('а не баланса: в игре такая смена просто зависла бы. Чинить в src/sim/shift.ts.');
  }
  lines.push('');

  return lines.join('\n');
}

beforeAll(() => {
  progression = runProgression();
  typical = progression.typical;

  income = [];
  for (const conveyor of [false, true]) {
    for (const upgrades of [{}, typical]) {
      for (let index = 0; index < BALANCE.layers.length; index += 1) {
        income.push(measureLayer(index, upgrades, conveyor));
      }
    }
  }

  shiftsWithWaves = [];
  for (const upgrades of [{}, typical]) {
    for (let index = 0; index < BALANCE.layers.length; index += 1) {
      shiftsWithWaves.push(measureShiftWithWaves(index, upgrades));
    }
  }

  probes = [];
  for (const state of RHYTHM_STATES) {
    for (let index = 0; index < BALANCE.layers.length; index += 1) {
      probes.push(probeRhythm(index, state));
    }
  }

  planProbes = [];
  for (const state of PLAN_STATES) {
    for (const plan of MEASURED_PLANS) {
      for (let index = 0; index < BALANCE.layers.length; index += 1) {
        planProbes.push(probeRhythm(index, { ...state, plan }));
      }
    }
  }

  defenseBare = measureDefense(false);
  defenseSalvo = measureDefense(true);

  report = buildReport();
  // A whole arc down to the bottom is tens of simulated shifts at a one
  // millisecond step, so the hook needs more than vitest's default ten seconds.
}, 600_000);

function pickResult(layerIndex: number, upgraded: boolean, conveyor: boolean): MineResult {
  const found = income.find(
    (result) =>
      result.layerIndex === layerIndex && result.upgraded === upgraded && result.conveyor === conveyor,
  );
  if (!found) {
    throw new Error(`no measurement for layer ${layerIndex}`);
  }
  return found;
}

/**
 * The same layer, measured over its steady bank-to-bank cycles instead of the
 * whole window. This is what the depth premium is guarded on.
 *
 * A window holds a whole number of trips plus a stump, so the window rate moves
 * by a twelfth when one more trip fits — noise that has nothing to do with the
 * layer being richer or poorer. The report keeps printing the window rate,
 * because that is the honest «лом за смену»; the invariant compares cycles,
 * because that is the honest «лом за ходку».
 */
function steadyRate(layerIndex: number, upgraded: boolean, conveyor: boolean): number {
  const result = pickResult(layerIndex, upgraded, conveyor);
  return result.steadyCycles >= 2
    ? scrapPerMin(result.steadyScrap, result.steadySec)
    : scrapPerMin(result.scrap, result.windowSec);
}

/** Index of the deepest layer, so a fourth ore later does not need a new test. */
const DEEPEST = BALANCE.layers.length - 1;

describe('замер баланса', () => {
  it('печатает отчёт (npm run measure)', () => {
    expect(report.length).toBeGreaterThan(0);
    if (REPORTING) {
      console.log(report);
    }
  });

  it('меряет то, что просили: бот не выходит из слоя и не теряет копку', () => {
    for (const result of income) {
      expect(result.redirectsWhileDigging).toBe(0);
      expect(result.skipped).toBe(0);
      // Every cell the bot dug is a cell of its own layer, and nothing dug is
      // ever lost: the whole window ends with everything handed over.
      const rows = layerRows(BALANCE, result.layerIndex);
      expect(result.minRow).toBeGreaterThanOrEqual(rows.top);
      expect(result.maxRow).toBeLessThanOrEqual(rows.bottom);
      expect(result.cells).toBeLessThanOrEqual(result.layerCells);
      expect(result.scrap).toBe(result.cells * result.layerYield);
      // The bot decides every millisecond, so waiting must be noise, not time.
      expect(result.waitSec).toBeLessThan(result.windowSec * 0.01);
    }
  });

  it('карго вмещает клетку самого дорогого слоя в каждой пятилетке, иначе бур встанет навсегда', () => {
    // A cell whose scrap does not fit an empty cargo can never be started: the
    // drill blocks, hands over an empty backpack, comes back and blocks again.
    // The mine simply stops paying, with nothing on screen to explain why — so
    // this is the one balance number that is a hard wall rather than a slider.
    //
    // Counted from `planBalance`, not from balance.json. The wall was checked at
    // level zero of the first plan only, and a five-year plan that doubled the
    // ore while leaving the backpack at 96 walked straight through it: from the
    // second plan on the richest cell was 192 and the cargo 96, so the reward
    // for winning was a mine nobody could dig.
    for (const plan of MEASURED_PLANS) {
      const bent = planBalance(BALANCE, plan);
      const richest = Math.max(...bent.layers.map((layer) => layer.yield));
      expect(bent.cargo.capacity_base, `пятилетка ${plan}`).toBeGreaterThanOrEqual(richest);
    }
  });

  it('стартовый ряд каждого слоя — открытый чекпоинт лифта', () => {
    const checkpoints = checkpointRows(BALANCE);
    for (let index = 0; index < BALANCE.layers.length; index += 1) {
      expect(checkpoints).toContain(layerRows(BALANCE, index).top);
    }
  });

  it('глубина окупается: каждый следующий слой заметно богаче предыдущего (PLAN_V1 §5)', () => {
    // «L3 ≥ L1» is what this used to check, and it let the middle of the mine
    // out of sight: a balance where the second layer paid 0.8% more than the
    // first passed it, while §5 promises the player a reason to risk the deeper
    // waves. Every neighbouring pair is checked now, in all four scenarios, and
    // the step has to be big enough to notice rather than merely positive.
    for (const conveyor of [false, true]) {
      for (const upgraded of [false, true]) {
        for (let index = 1; index <= DEEPEST; index += 1) {
          const deeper = steadyRate(index, upgraded, conveyor);
          const shallower = steadyRate(index - 1, upgraded, conveyor);
          expect(
            deeper / shallower,
            `${scenarioName(upgraded, conveyor)}: ${layerName(index - 1)} ${num(shallower)} → ${layerName(index)} ${num(deeper)}`,
          ).toBeGreaterThanOrEqual(LAYER_PREMIUM);
        }
      }
    }
  });

  it('премия за глубину видна и в кристаллах (PLAN_V1 §7)', () => {
    // Scrap is guarded above; crystals are the other half of «глубже выгоднее»,
    // and they are what pays for the elevator and the conveyor.
    for (const conveyor of [false, true]) {
      const rates = BALANCE.layers.map((_, index) => {
        const found = pickResult(index, false, conveyor);
        return (found.crystals / found.windowSec) * 60;
      });
      for (let index = 1; index <= DEEPEST; index += 1) {
        expect(rates[index] ?? 0, `конвейер ${conveyor}: L${index} → L${index + 1}`).toBeGreaterThan(
          rates[index - 1] ?? 0,
        );
      }
    }
  });

  it('дорога — главная цена глубины (PLAN_V1 §4)', () => {
    const share = (result: MineResult): number => (result.roadSec + result.bankSec) / result.windowSec;
    expect(share(pickResult(DEEPEST, false, false))).toBeGreaterThan(share(pickResult(0, false, false)));
    // The conveyor is what buys the road away, so it has to shrink it to nothing.
    expect(pickResult(DEEPEST, false, true).bankSec).toBe(0);
    expect(pickResult(DEEPEST, false, true).roadSec).toBeLessThan(
      pickResult(DEEPEST, false, false).roadSec,
    );
  });

  it('кристаллы идут только со второго слоя и глубже (PLAN_V1 §7)', () => {
    for (let index = 0; index <= DEEPEST; index += 1) {
      const measured = pickResult(index, false, false).crystals;
      if (layerAt(BALANCE, index).crystal_chance > 0) {
        expect(measured).toBeGreaterThan(0);
      } else {
        expect(measured).toBe(0);
      }
    }
  });

  it('дно Бездны — цель на неделю игры, а не на первую смену (issue #14)', () => {
    // The one number the whole rework of the economy is about. A run that never
    // gets there is as broken as one that gets there in the first shift, so the
    // band is checked from both sides.
    expect(progression.bottomShift).not.toBeNull();
    expect(progression.bottomShift ?? 0).toBeGreaterThanOrEqual(BOTTOM_SHIFTS_MIN);
    expect(progression.bottomShift ?? 0).toBeLessThanOrEqual(BOTTOM_SHIFTS_MAX);
  });

  it('каждая смена что-то добавляет (PLAN_V1 §2.3)', () => {
    // Scrap always, and the levels it buys: no shift of the arc ends with the
    // player owning exactly what they owned before it.
    for (const shift of progression.shifts) {
      expect(shift.scrap).toBeGreaterThan(0);
      expect(shift.cells).toBeGreaterThan(0);
    }
    // The depth record is the other half of «добавляет», and it may stand still
    // for a shift or two while the upgrades catch up — but not for the whole arc.
    const moved = progression.shifts.filter((shift) => shift.gained > 0).length;
    expect(moved * 2).toBeGreaterThan(progression.shifts.length);
  });

  it('следующий апгрейд всегда близко: не дальше 40 секунд игры (PLAN_V1 §2.4)', () => {
    for (const shift of progression.shifts) {
      expect(shift.nextSec, `смена ${shift.index}, ${shift.nextId}`).toBeLessThanOrEqual(
        NEXT_UPGRADE_LIMIT_SEC,
      );
    }
    // The intent the abandoned floor of the rule carried: a purchase that is
    // always already paid for is not a purchase. The median is the honest place
    // to hold that — see `MIN_MEDIAN_NEXT_UPGRADE_SEC` for why the floor cannot
    // sit on the maximum.
    const waits = [...progression.shifts.map((shift) => shift.nextSec)].sort((a, b) => a - b);
    const median = waits[Math.floor(waits.length / 2)] ?? 0;
    expect(median).toBeGreaterThanOrEqual(MIN_MEDIAN_NEXT_UPGRADE_SEC);
  });

  it('игрок решает раз в 20–30 секунд: каждый слой, с прокачкой и без (PLAN_V1 §2.6)', () => {
    // The rule the mine was breaking: one tap at t=0 and nothing asked of the
    // player for the next three minutes.
    //
    // Both upgrade states are guarded. An earlier version let the upgraded rows
    // through as «a cross-section nobody plays» while the report printed a 63
    // second silence in one of them — that row is the careful player who buys
    // upgrades and does not go deeper because §6 made depth a risk, and there is
    // nothing synthetic about them.
    //
    // The conveyor rows are the one exception, and it is a design decision, not
    // a dodge: the conveyor removes the hand-over, so it removes the rhythm, and
    // §4 sells it for exactly that.
    for (const result of income) {
      if (result.conveyor) {
        continue;
      }
      const where = `${scenarioName(result.upgraded, result.conveyor)}, ${layerName(result.layerIndex)}`;
      expect(result.rhythm.typicalSec, where).toBeGreaterThanOrEqual(RHYTHM_MIN_SEC);
      expect(result.rhythm.typicalSec, where).toBeLessThanOrEqual(RHYTHM_MAX_SEC);
      expect(result.rhythm.maxSec, where).toBeLessThanOrEqual(RHYTHM_GAP_LIMIT_SEC);
      expect(result.rhythm.longShare, where).toBeLessThanOrEqual(LONG_SHARE_LIMIT);
    }
  });

  it('игрок решает раз в 20–30 секунд: под любой веткой прокачки (PLAN_V1 §2.6)', () => {
    // The invariant the rejected version did not have. See `RHYTHM_STATES`: one
    // cargo level used to take the silence of the first layer from 26 seconds to
    // 38, and nothing in the measurement looked there.
    for (const probe of probes) {
      const where = `${probe.state}, ${layerName(probe.layerIndex)}`;
      expect(probe.rhythm.typicalSec, where).toBeGreaterThanOrEqual(RHYTHM_MIN_SEC);
      expect(probe.rhythm.typicalSec, where).toBeLessThanOrEqual(RHYTHM_MAX_SEC);
      expect(probe.rhythm.maxSec, where).toBeLessThanOrEqual(RHYTHM_GAP_LIMIT_SEC);
      expect(probe.rhythm.longShare, where).toBeLessThanOrEqual(LONG_SHARE_LIMIT);
    }
  });

  it('премия за глубину держится под любой веткой прокачки (PLAN_V1 §5)', () => {
    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index];
      const previous = probes[index - 1];
      if (!probe || !previous || probe.layerIndex === 0) {
        continue;
      }
      expect(
        probe.scrapPerMin / previous.scrapPerMin,
        `${probe.state}: ${layerName(probe.layerIndex - 1)} → ${layerName(probe.layerIndex)}`,
      ).toBeGreaterThanOrEqual(LAYER_PREMIUM);
    }
  });

  it('ветка карго не двигает число клеток в ходке — иначе она двигает тишину §2.6', () => {
    // The structural guarantee behind the whole rhythm. A trip is
    // `floor(capacity / yield)` cells and two decisions; if a purchase changes
    // that count, it changes the silence by a whole cell — half a minute in the
    // first layer — and no price can soften an integer. So the branch moves the
    // backpack and the ore by the same share, and this walks every level of it
    // to prove the ratio never moves.
    //
    // The hard wall of §5 rides along: cargo cannot fall under the richest cell
    // at any level either, because both sides scale together.
    // Every level, in every five-year plan: the plan multiplies the ore too, so
    // walking the levels of the first plan alone proves nothing about the game
    // the player is handed for winning.
    const cellsAtZero = BALANCE.layers.map((layer) =>
      Math.floor(BALANCE.cargo.capacity_base / layer.yield),
    );
    for (const plan of MEASURED_PLANS) {
      for (let level = 0; level <= 60; level += 1) {
        const balance = effectiveBalance(planBalance(BALANCE, plan), { cargo: level });
        const where = `пятилетка ${plan}, карго ${level}`;
        const richest = Math.max(...balance.layers.map((layer) => layer.yield));
        expect(balance.cargo.capacity_base, where).toBeGreaterThanOrEqual(richest);
        balance.layers.forEach((layer, index) => {
          expect(Math.floor(balance.cargo.capacity_base / layer.yield), `${where}, ${layer.id}`).toBe(
            cellsAtZero[index],
          );
        });
      }
    }
  });

  it('шахта копается в каждой пятилетке: победа не выключает игру (PLAN_V1 §5)', () => {
    // The proof the arithmetic above cannot give: the real simulation, in every
    // measured plan, in every layer, under three upgrade states. A plan that
    // bends the ore without the backpack passes any check that multiplies two
    // numbers and dies here — the drill never opens a single cell and hands over
    // an empty backpack for six minutes.
    for (const probe of planProbes) {
      const where = `${probe.state}, пятилетка ${probe.plan}, ${layerName(probe.layerIndex)}`;
      expect(probe.cells, where).toBeGreaterThan(0);
      expect(probe.banked, where).toBeGreaterThan(0);
    }
  });

  it('пятилетка не трогает ни ходку, ни ритм §2.6', () => {
    // A plan is «the same mine paying better against a heavier siege» (§5), and
    // that is a measurable claim: hardness, drill speed and the cells-per-trip
    // quotient are all untouched, so every pause of the shift has to come out
    // exactly as it does in the first plan. Anything else means the plan has
    // quietly become a different game.
    for (const probe of planProbes) {
      const base = planProbes.find(
        (candidate) =>
          candidate.plan === 1 &&
          candidate.state === probe.state &&
          candidate.layerIndex === probe.layerIndex,
      );
      const where = `${probe.state}, пятилетка ${probe.plan}, ${layerName(probe.layerIndex)}`;
      expect(base, where).toBeDefined();
      expect(probe.cellsPerTrip, where).toBeCloseTo(base?.cellsPerTrip ?? 0, 6);
      expect(probe.cells, where).toBe(base?.cells ?? 0);
      expect(probe.rhythm.typicalSec, where).toBeCloseTo(base?.rhythm.typicalSec ?? 0, 6);
      expect(probe.rhythm.maxSec, where).toBeCloseTo(base?.rhythm.maxSec ?? 0, 6);
      // And the band itself, so this test fails on its own rather than only
      // through the first plan's row.
      expect(probe.rhythm.typicalSec, where).toBeGreaterThanOrEqual(RHYTHM_MIN_SEC);
      expect(probe.rhythm.typicalSec, where).toBeLessThanOrEqual(RHYTHM_MAX_SEC);
      expect(probe.rhythm.maxSec, where).toBeLessThanOrEqual(RHYTHM_GAP_LIMIT_SEC);
      expect(probe.rhythm.longShare, where).toBeLessThanOrEqual(LONG_SHARE_LIMIT);
    }
  });

  it('премия за глубину держится в каждой пятилетке (PLAN_V1 §5)', () => {
    for (let index = 0; index < planProbes.length; index += 1) {
      const probe = planProbes[index];
      const previous = planProbes[index - 1];
      if (!probe || !previous || probe.layerIndex === 0) {
        continue;
      }
      expect(
        probe.scrapPerMin / previous.scrapPerMin,
        `${probe.state}, пятилетка ${probe.plan}: ${layerName(probe.layerIndex - 1)} → ${layerName(probe.layerIndex)}`,
      ).toBeGreaterThanOrEqual(LAYER_PREMIUM);
    }
  });

  it('игрок решает раз в 20–30 секунд: каждая смена дуги, первая тоже (PLAN_V1 §2.6)', () => {
    // The first shift is the only chance the game gets with a stranger, and it
    // used to be the worst one in the arc: sixteen cells of the first layer
    // fitted one cargo, so the second tap of the game came on the 200th second.
    // Every shift of the arc is held to the band, not just the first — this is
    // the run a player actually plays, shift after shift.
    for (const shift of progression.shifts) {
      const where = `смена ${shift.index}, старт ${shift.startRow}`;
      expect(shift.rhythm.typicalSec, where).toBeGreaterThanOrEqual(RHYTHM_MIN_SEC);
      expect(shift.rhythm.typicalSec, where).toBeLessThanOrEqual(RHYTHM_MAX_SEC);
      expect(shift.rhythm.maxSec, where).toBeLessThanOrEqual(RHYTHM_GAP_LIMIT_SEC);
      expect(shift.rhythm.longShare, where).toBeLessThanOrEqual(LONG_SHARE_LIMIT);
    }
  });

  it('форма сложности §6 цела: без залпа купол течёт и падает', () => {
    // One wave of slack on each side of the numbers PLAN_V1 §6 wrote down. A
    // wave is the unit the shape is described in, and the measured run is
    // already one wave off on the leaks (see the report), so anything tighter
    // would be guarding the wording rather than the game.
    expect(defenseBare.firstLeakWave).not.toBeNull();
    expect(defenseBare.firstLeakWave ?? 0).toBeGreaterThanOrEqual(SHAPE.bareFirstLeakWave - 1);
    expect(defenseBare.firstLeakWave ?? 0).toBeLessThanOrEqual(SHAPE.bareFirstLeakWave + 1);
    expect(defenseBare.endReason).toBe('breach');
    expect(defenseBare.breachWave ?? 0).toBeGreaterThanOrEqual(SHAPE.bareBreachWave - 1);
    expect(defenseBare.breachWave ?? 0).toBeLessThanOrEqual(SHAPE.bareBreachWave + 1);
  });

  it('форма сложности §6 цела: с залпом смена доживает до таймера, но впритык', () => {
    expect(defenseSalvo.endReason).toBe('timer');
    // §6 measured 45/100 left. A band of ±25 around it: above it the salvo has
    // turned the shift into an autopilot, below it the dome is one leak from
    // falling and "почти вытягиваешь голыми руками" is no longer true.
    expect(defenseSalvo.domeHp).toBeGreaterThan(SHAPE.salvoDomeHp - 25);
    expect(defenseSalvo.domeHp).toBeLessThan(SHAPE.salvoDomeHp + 25);
    expect(defenseSalvo.firstLeakWave ?? 0).toBeGreaterThan(defenseBare.firstLeakWave ?? 0);
    // `SHAPE.salvoFirstLeakWave` was printed in the report and checked by
    // nobody: the wave the salvo stops covering is half of «впритык», and the
    // same one wave of slack the bare run gets.
    expect(defenseSalvo.firstLeakWave).not.toBeNull();
    expect(defenseSalvo.firstLeakWave ?? 0).toBeGreaterThanOrEqual(SHAPE.salvoFirstLeakWave - 1);
    expect(defenseSalvo.firstLeakWave ?? 0).toBeLessThanOrEqual(SHAPE.salvoFirstLeakWave + 1);
  });
});
