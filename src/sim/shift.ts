import type { Balance } from './balance.js';
import { cellYield, crystalChance, digTimeSec, travelTimeSec } from './mining.js';
import { nextRandom, normalizeSeed } from './rng.js';

/**
 * The shift as a deterministic state machine: state plus `step(state, dtSec)`.
 * No graphics, no Math.random, no clock — the view only draws what it finds
 * here and feeds player taps back in. Same seed and same calls = same shift.
 *
 * Grid: `shift.grid_width` columns, rows 0..`shift.grid_depth`. Row 0 is the
 * mine entrance, it starts dug, and digging goes down from there.
 *
 * Time is consumed event by event inside `step`, so one long step gives exactly
 * the same state as many short ones.
 */

/** Row of the mine entrance: already open, and where the elevator waits. */
export const ENTRANCE_ROW = 0;

/** Floating point slack for time and distance comparisons. Not a game number. */
const EPS = 1e-9;

/**
 * Safety bound for the instant-transition loop. A normal step resolves in a
 * handful of transitions; this only stops a bug from freezing the browser.
 */
const MAX_TRANSITIONS = 64;

export type CellState = 'rock' | 'dug';

/** What the drill is doing right now. */
export type DrillMode =
  /** Waiting for an order. */
  | 'idle'
  /** Driving to the target cell or up to the elevator. */
  | 'moving'
  /** Standing on the target cell, drilling it. */
  | 'digging'
  /** On the target cell but the cargo has no room: it does not start the cell. */
  | 'blocked'
  /** At the entrance, handing the cargo over. */
  | 'banking';

/** Phase of the whole shift. */
export type ShiftPhase =
  /** Timer running, player in control. */
  | 'running'
  /** Timer over: automatic ascent with everything mined. */
  | 'ending'
  /** Report on screen. */
  | 'finished';

export interface DrillTarget {
  readonly col: number;
  readonly row: number;
  readonly kind: 'cell' | 'surface';
}

export interface DrillState {
  /** Position in grid cells; fractional while driving. */
  col: number;
  row: number;
  mode: DrillMode;
  target: DrillTarget | null;
  digElapsedSec: number;
  digTotalSec: number;
  bankElapsedSec: number;
}

export interface ShiftState {
  readonly balance: Balance;
  readonly width: number;
  /** Number of rows including the entrance row: grid_depth + 1. */
  readonly rowCount: number;
  /** Row-major grid, index = row * width + col. */
  readonly cells: CellState[];
  readonly seed: number;
  phase: ShiftPhase;
  timeLeftSec: number;
  drill: DrillState;
  /** Scrap in the backpack: lost on an emergency ascent, banked at the elevator. */
  cargo: number;
  /** Scrap handed over. Safe forever (PLAN_V1 §2.1). */
  banked: number;
  /** Crystals: never in the cargo, never lost (PLAN_V1 §7). */
  crystals: number;
  /** Everything dug this shift, banked or not. */
  mined: number;
  /** Deepest row dug this shift. */
  deepestRow: number;
  rngState: number;
}

export interface ShiftReport {
  readonly mined: number;
  readonly banked: number;
  readonly deepestRow: number;
  readonly crystals: number;
}

/** Fresh shift: empty shaft, open entrance row, drill parked in the middle. */
export function createShift(balance: Balance, seed: number): ShiftState {
  const width = balance.shift.grid_width;
  const rowCount = balance.shift.grid_depth + 1;
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError(`shift.grid_width must be a positive integer, got ${width}`);
  }
  if (!Number.isInteger(rowCount) || rowCount <= 1) {
    throw new RangeError(`shift.grid_depth must be a positive integer, got ${balance.shift.grid_depth}`);
  }
  if (!(balance.drill.move_rows_per_sec > 0)) {
    throw new RangeError(`drill.move_rows_per_sec must be positive, got ${balance.drill.move_rows_per_sec}`);
  }
  if (!(balance.drill.speed_base > 0)) {
    throw new RangeError(`drill.speed_base must be positive, got ${balance.drill.speed_base}`);
  }

  const cells: CellState[] = new Array<CellState>(width * rowCount).fill('rock');
  for (let col = 0; col < width; col += 1) {
    cells[ENTRANCE_ROW * width + col] = 'dug';
  }

  return {
    balance,
    width,
    rowCount,
    cells,
    seed: normalizeSeed(seed),
    phase: 'running',
    timeLeftSec: balance.shift.duration_sec,
    drill: {
      col: Math.floor(width / 2),
      row: ENTRANCE_ROW,
      mode: 'idle',
      target: null,
      digElapsedSec: 0,
      digTotalSec: 0,
      bankElapsedSec: 0,
    },
    cargo: 0,
    banked: 0,
    crystals: 0,
    mined: 0,
    deepestRow: ENTRANCE_ROW,
    rngState: normalizeSeed(seed),
  };
}

/* ------------------------------------------------------------------ reading */

export function isInside(state: ShiftState, col: number, row: number): boolean {
  return (
    Number.isInteger(col) &&
    Number.isInteger(row) &&
    col >= 0 &&
    col < state.width &&
    row >= 0 &&
    row < state.rowCount
  );
}

export function cellAt(state: ShiftState, col: number, row: number): CellState {
  if (!isInside(state, col, row)) {
    throw new RangeError(`cell ${col},${row} is outside the grid`);
  }
  return state.cells[row * state.width + col] ?? 'rock';
}

export function isDug(state: ShiftState, col: number, row: number): boolean {
  return isInside(state, col, row) && cellAt(state, col, row) === 'dug';
}

/**
 * A cell can be dug when it is still rock and touches a dug cell by an edge.
 * No diagonals: the drill needs a tunnel to drive through.
 */
export function canDig(state: ShiftState, col: number, row: number): boolean {
  if (!isInside(state, col, row) || cellAt(state, col, row) === 'dug') {
    return false;
  }
  return (
    isDug(state, col, row - 1) ||
    isDug(state, col, row + 1) ||
    isDug(state, col - 1, row) ||
    isDug(state, col + 1, row)
  );
}

export function cargoCapacity(state: ShiftState): number {
  return state.balance.cargo.capacity_base;
}

export function cargoFree(state: ShiftState): number {
  return Math.max(0, cargoCapacity(state) - state.cargo);
}

/** True while the drill stands still because the next cell would not fit. */
export function isCargoBlocked(state: ShiftState): boolean {
  return state.drill.mode === 'blocked';
}

/** Dig progress of the current cell, 0..1. */
export function digProgress(state: ShiftState): number {
  const { digTotalSec, digElapsedSec } = state.drill;
  if (digTotalSec <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, digElapsedSec / digTotalSec));
}

/** Hand-over progress at the elevator, 0..1. */
export function bankProgress(state: ShiftState): number {
  const total = state.balance.shift.elevator_bank_sec;
  if (total <= 0) {
    return state.drill.mode === 'banking' ? 1 : 0;
  }
  return Math.min(1, Math.max(0, state.drill.bankElapsedSec / total));
}

export function shiftReport(state: ShiftState): ShiftReport {
  return {
    mined: state.mined,
    banked: state.banked,
    deepestRow: state.deepestRow,
    crystals: state.crystals,
  };
}

/* ------------------------------------------------------------------ orders */

/**
 * Send the drill to a cell. Retargets whatever it was doing, losing the
 * progress of the cell it was on. Returns false when the cell cannot be dug,
 * and while the cargo is being handed over: an interrupted hand-over would
 * waste the whole trip up.
 */
export function aimDrill(state: ShiftState, col: number, row: number): boolean {
  if (state.phase !== 'running' || state.drill.mode === 'banking' || !canDig(state, col, row)) {
    return false;
  }
  const { drill } = state;
  drill.target = { col, row, kind: 'cell' };
  drill.mode = 'moving';
  drill.digElapsedSec = 0;
  drill.digTotalSec = 0;
  drill.bankElapsedSec = 0;
  return true;
}

/** Call the elevator: the drill drives up its own column and hands the cargo over. */
export function callElevator(state: ShiftState): boolean {
  const { drill } = state;
  if (state.phase === 'finished' || drill.mode === 'banking') {
    return false;
  }
  beginAscent(state);
  return true;
}

/* -------------------------------------------------------------------- step */

/** Advances the shift by `dtSec` seconds. Deterministic for any slicing of time. */
export function step(state: ShiftState, dtSec: number): ShiftState {
  if (!Number.isFinite(dtSec) || dtSec < 0) {
    throw new RangeError(`dtSec must be a non-negative finite number, got ${dtSec}`);
  }

  let remaining = dtSec;
  resolve(state);
  while (state.phase !== 'finished' && remaining > EPS) {
    const slice = Math.min(remaining, timeToNextEvent(state));
    if (!(slice > EPS)) {
      break;
    }
    advance(state, slice);
    remaining -= slice;
    resolve(state);
  }
  return state;
}

/** Seconds until the next thing that changes the state on its own. */
function timeToNextEvent(state: ShiftState): number {
  const { drill } = state;
  let time = Number.POSITIVE_INFINITY;
  if (state.phase === 'running') {
    time = Math.min(time, state.timeLeftSec);
  }
  switch (drill.mode) {
    case 'moving':
      time = Math.min(time, travelTimeSec(distanceToTarget(state), state.balance.drill.move_rows_per_sec));
      break;
    case 'digging':
      time = Math.min(time, drill.digTotalSec - drill.digElapsedSec);
      break;
    case 'banking':
      time = Math.min(time, state.balance.shift.elevator_bank_sec - drill.bankElapsedSec);
      break;
    case 'idle':
    case 'blocked':
      break;
  }
  return Math.max(0, time);
}

/** Runs the clocks for `dtSec` seconds without crossing any event boundary. */
function advance(state: ShiftState, dtSec: number): void {
  const { drill } = state;
  if (state.phase === 'running') {
    state.timeLeftSec = Math.max(0, state.timeLeftSec - dtSec);
  }
  switch (drill.mode) {
    case 'moving':
      moveDrill(state, dtSec);
      break;
    case 'digging':
      drill.digElapsedSec += dtSec;
      break;
    case 'banking':
      drill.bankElapsedSec += dtSec;
      break;
    case 'idle':
    case 'blocked':
      break;
  }
}

/** Applies every transition that is already due, in order. */
function resolve(state: ShiftState): void {
  for (let guard = 0; guard < MAX_TRANSITIONS; guard += 1) {
    if (!resolveOnce(state)) {
      return;
    }
  }
}

function resolveOnce(state: ShiftState): boolean {
  const { drill } = state;

  if (state.phase === 'running' && state.timeLeftSec <= EPS) {
    state.timeLeftSec = 0;
    state.phase = 'ending';
    if (drill.mode !== 'banking') {
      beginAscent(state);
    }
    return true;
  }

  if (state.phase === 'ending' && (drill.mode === 'idle' || drill.mode === 'blocked')) {
    beginAscent(state);
    return true;
  }

  switch (drill.mode) {
    case 'moving':
      if (distanceToTarget(state) > EPS) {
        return false;
      }
      arrive(state);
      return true;
    case 'digging':
      if (drill.digElapsedSec < drill.digTotalSec - EPS) {
        return false;
      }
      completeDig(state);
      return true;
    case 'banking':
      if (drill.bankElapsedSec < state.balance.shift.elevator_bank_sec - EPS) {
        return false;
      }
      completeBank(state);
      return true;
    case 'idle':
    case 'blocked':
      return false;
  }
}

function beginAscent(state: ShiftState): void {
  const { drill } = state;
  const col = Math.min(state.width - 1, Math.max(0, Math.round(drill.col)));
  drill.target = { col, row: ENTRANCE_ROW, kind: 'surface' };
  drill.mode = 'moving';
  drill.digElapsedSec = 0;
  drill.digTotalSec = 0;
  drill.bankElapsedSec = 0;
}

function distanceToTarget(state: ShiftState): number {
  const { drill } = state;
  if (!drill.target) {
    return 0;
  }
  return Math.hypot(drill.target.col - drill.col, drill.target.row - drill.row);
}

function moveDrill(state: ShiftState, dtSec: number): void {
  const { drill } = state;
  const target = drill.target;
  if (!target) {
    return;
  }
  const dCol = target.col - drill.col;
  const dRow = target.row - drill.row;
  const distance = Math.hypot(dCol, dRow);
  const reach = state.balance.drill.move_rows_per_sec * dtSec;
  if (distance <= EPS || distance <= reach) {
    drill.col = target.col;
    drill.row = target.row;
    return;
  }
  drill.col += (dCol / distance) * reach;
  drill.row += (dRow / distance) * reach;
}

function arrive(state: ShiftState): void {
  const { drill } = state;
  const target = drill.target;
  if (!target) {
    drill.mode = 'idle';
    return;
  }
  drill.col = target.col;
  drill.row = target.row;

  if (target.kind === 'surface') {
    drill.mode = 'banking';
    drill.bankElapsedSec = 0;
    return;
  }

  if (cellAt(state, target.col, target.row) === 'dug') {
    drill.mode = 'idle';
    drill.target = null;
    return;
  }

  // Full cargo stops the drill: it never starts a cell whose scrap would not
  // fit, so nothing mined is ever thrown away (PLAN_V1 §4).
  if (cellYield(state.balance.layers, target.row) > cargoFree(state) + EPS) {
    drill.mode = 'blocked';
    return;
  }

  drill.mode = 'digging';
  drill.digElapsedSec = 0;
  drill.digTotalSec = digTimeSec(state.balance.layers, target.row, state.balance.drill.speed_base);
}

function completeDig(state: ShiftState): void {
  const { drill } = state;
  const target = drill.target;
  if (!target) {
    drill.mode = 'idle';
    return;
  }

  state.cells[target.row * state.width + target.col] = 'dug';
  const scrap = cellYield(state.balance.layers, target.row);
  state.cargo += scrap;
  state.mined += scrap;
  if (target.row > state.deepestRow) {
    state.deepestRow = target.row;
  }
  rollCrystal(state, target.row);

  drill.col = target.col;
  drill.row = target.row;
  drill.mode = 'idle';
  drill.target = null;
  drill.digElapsedSec = 0;
  drill.digTotalSec = 0;
}

function completeBank(state: ShiftState): void {
  const { drill } = state;
  state.banked += state.cargo;
  state.cargo = 0;
  drill.target = null;
  drill.bankElapsedSec = 0;
  drill.mode = 'idle';
  if (state.phase === 'ending') {
    state.phase = 'finished';
  }
}

/** One seeded roll per dug cell, so the crystal stream depends only on the seed. */
function rollCrystal(state: ShiftState, row: number): void {
  const draw = nextRandom(state.rngState);
  state.rngState = draw.state;
  if (draw.value < crystalChance(state.balance.layers, row)) {
    state.crystals += 1;
  }
}
