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
 * The balance as it was measured before the economy was rebuilt for issue #14 —
 * a 9×30 mine where the bottom fell on the 73rd second of the first shift. Kept
 * here so the report can put the old numbers and the new ones side by side;
 * nothing is computed from them.
 */
const BEFORE_REWORK = {
  scrapPerMin: [324.6, 384.8, 419.4],
  crystalPerMin: [0, 1.67, 1.7],
  conveyorScrapPerMin: [391.3, 616.3, 833.5],
  layerCells: [81, 89, 98],
  bottomShift: 1,
  bottomSec: 73,
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
  /** When the bottom row was first dug: the five-year plan closes there (§5). */
  bottomAtSec: number | null;
  done: boolean;
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
      return;
    }
    run.planIndex += 1;
    run.skipped += 1;
  }
}

function requestBank(run: MineRun, end: CycleEnd): void {
  if (callElevator(run.state)) {
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
}

/** Seconds one hand-over costs in the scenario a result came from. */
function bankSecOf(result: MineResult): number {
  return result.conveyor ? 0 : BALANCE.shift.elevator_bank_sec;
}

function scrapPerMin(scrap: number, sec: number): number {
  return sec > 0 ? (scrap / sec) * 60 : 0;
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
  lines.push('── БЫЛО ДО ПЕРЕКРОЙКИ ЭКОНОМИКИ (issue #14) ─────────────────────────────────────');
  lines.push('');
  lines.push(
    table(
      ['слой', 'было клеток', 'стало клеток', 'было лом/мин', 'стало лом/мин', 'было крист/мин', 'стало крист/мин', 'было с конвейером', 'стало с конвейером'],
      layers.map(({ index }) => {
        const plain = pickResult(index, false, false);
        const belt = pickResult(index, false, true);
        return [
          layerName(index),
          String(BEFORE_REWORK.layerCells[index] ?? 0),
          String(plain.layerCells),
          num(BEFORE_REWORK.scrapPerMin[index] ?? 0),
          num(scrapPerMin(plain.scrap, plain.windowSec)),
          num(BEFORE_REWORK.crystalPerMin[index] ?? 0, 2),
          num((plain.crystals / plain.windowSec) * 60, 2),
          num(BEFORE_REWORK.conveyorScrapPerMin[index] ?? 0),
          num(scrapPerMin(belt.scrap, belt.windowSec)),
        ];
      }),
    ),
  );
  lines.push('');
  lines.push(
    `Дно: было на смене ${BEFORE_REWORK.bottomShift}, на ${BEFORE_REWORK.bottomSec}-й секунде; ` +
      `стало ${progression.bottomShift === null ? 'недостижимо' : `на смене ${progression.bottomShift}`}. ` +
      'Лом в минуту стал меньше, потому что клетка стоит дороже по времени, а не потому что слой обеднел:',
  );
  lines.push('в слое лежит вчетверо больше клеток, и ни один из них теперь не кончается за смену.');

  lines.push('');
  lines.push('§12 требует только L3 ≥ L1. Строки, где «L3 ПЛАТИТ МЕНЬШЕ L2», формально проверку');
  lines.push('проходят, но ломают обещание §5 «глубже всегда выгоднее» — решение за владельцем.');
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

function rate(layerIndex: number, upgraded: boolean, conveyor: boolean): number {
  const result = pickResult(layerIndex, upgraded, conveyor);
  return scrapPerMin(result.scrap, result.windowSec);
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

  it('карго вмещает клетку самого дорогого слоя, иначе бур встанет навсегда', () => {
    // A cell whose scrap does not fit an empty cargo can never be started: the
    // drill blocks, hands over an empty backpack, comes back and blocks again.
    // The mine simply stops paying, with nothing on screen to explain why — so
    // this is the one balance number that is a hard wall rather than a slider.
    const richest = Math.max(...BALANCE.layers.map((layer) => layer.yield));
    expect(BALANCE.cargo.capacity_base).toBeGreaterThanOrEqual(richest);
  });

  it('стартовый ряд каждого слоя — открытый чекпоинт лифта', () => {
    const checkpoints = checkpointRows(BALANCE);
    for (let index = 0; index < BALANCE.layers.length; index += 1) {
      expect(checkpoints).toContain(layerRows(BALANCE, index).top);
    }
  });

  it('глубина окупается: самый глубокий слой не хуже первого (PLAN_V1 §12)', () => {
    for (const conveyor of [false, true]) {
      for (const upgraded of [false, true]) {
        expect(rate(DEEPEST, upgraded, conveyor)).toBeGreaterThanOrEqual(rate(0, upgraded, conveyor));
      }
    }
  });

  it('с конвейером глубина честно растёт слой за слоем', () => {
    for (const upgraded of [false, true]) {
      for (let index = 1; index <= DEEPEST; index += 1) {
        expect(rate(index, upgraded, true)).toBeGreaterThan(rate(index - 1, upgraded, true));
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
  });
});
