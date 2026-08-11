import type { Balance } from './balance.js';
import {
  advanceDefense,
  aimTurretAt,
  clearEnemies,
  createDefense,
  defenseTimeToNextEvent,
  fireSalvoAt,
  resolveDefense,
  type DefenseState,
} from './defense.js';
import { cellYield, crystalChance, digTimeSec, layerIndexForRow, travelTimeSec } from './mining.js';
import { nextRandom, normalizeSeed } from './rng.js';

/**
 * The shift as a deterministic state machine: state plus `step(state, dtSec)`.
 * No graphics, no Math.random, no clock — the view only draws what it finds
 * here and feeds player taps back in. Same seed and same calls = same shift.
 *
 * Grid: `shift.grid_width` columns, rows 0..`shift.grid_depth`. Row 0 is the
 * mine entrance, it starts dug, and digging goes down from there.
 *
 * The drill never leaves the tunnel: it drives cell by cell over dug cells
 * only, horizontally and vertically, along the shortest route it can find.
 * A tap is one decision, not one cell: after the cell it was sent to, the drill
 * keeps digging the same way until the grid ends or the cargo fills up.
 *
 * The dome defence (src/sim/defense.ts) runs on the same clock: waves come out
 * while the shift is running and the drill never stops for them (PLAN_V1 §4).
 * When the dome falls the shift ends at once and the unbanked cargo is lost.
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

/** A cell on the grid. */
export interface GridPos {
  readonly col: number;
  readonly row: number;
}

/**
 * The four edge neighbours, in the order routes prefer them. The drill digs
 * a cell while standing on one of its dug neighbours, and it goes on in the
 * direction of that last step — preferring the neighbour above keeps a tap
 * digging downwards, which is what depth is for.
 */
const STEPS: readonly GridPos[] = [
  { col: 0, row: -1 },
  { col: -1, row: 0 },
  { col: 1, row: 0 },
  { col: 0, row: 1 },
];

/** What the drill is doing right now. */
export type DrillMode =
  /** Waiting for an order. */
  | 'idle'
  /** Driving through the tunnel to the cell it digs from, or up to the elevator. */
  | 'moving'
  /** Standing in the tunnel, drilling the target cell next to it. */
  | 'digging'
  /** In place but the cargo has no room: it does not start the cell. */
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

/**
 * Why the shift is over. `timer` — the six minutes ran out and everything came
 * up with the drill. `breach` — the dome fell, emergency ascent, the unbanked
 * cargo is gone. Never a defeat: what was handed over stays (PLAN_V1 §2).
 */
export type ShiftEndReason = 'timer' | 'breach';

export interface DrillTarget {
  readonly col: number;
  readonly row: number;
  /**
   * `cell` — rock to dig, `surface` — elevator cell to bank at,
   * `park` — dug cell to drive into and stop.
   */
  readonly kind: 'cell' | 'surface' | 'park';
}

export interface DrillState {
  /** Position in grid cells; fractional while driving between two cells. */
  col: number;
  row: number;
  mode: DrillMode;
  target: DrillTarget | null;
  /** Dug cells left to drive through, in order. Empty once the drive is over. */
  path: GridPos[];
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
  /** Set when the shift ends, null while it runs. */
  endReason: ShiftEndReason | null;
  timeLeftSec: number;
  drill: DrillState;
  /** Dome, waves and turret. Enemies only exist while the phase is `running`. */
  defense: DefenseState;
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
  /** Null only while the shift is still on. */
  readonly endReason: ShiftEndReason | null;
  /** Waves that came out this shift. */
  readonly waves: number;
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
    endReason: null,
    timeLeftSec: balance.shift.duration_sec,
    drill: {
      col: Math.floor(width / 2),
      row: ENTRANCE_ROW,
      mode: 'idle',
      target: null,
      path: [],
      digElapsedSec: 0,
      digTotalSec: 0,
      bankElapsedSec: 0,
    },
    defense: createDefense(balance),
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
    endReason: state.endReason,
    waves: state.defense.wavesSent,
  };
}

/** Layer the drill sits in right now: it sets how tough a fresh wave is. */
export function drillLayerIndex(state: ShiftState): number {
  const row = Math.min(state.rowCount - 1, Math.max(0, Math.round(state.drill.row)));
  return layerIndexForRow(state.balance.layers, row);
}

/* ------------------------------------------------------------------ orders */

/**
 * Send the drill to dig a cell. It drives there through the tunnel and then
 * keeps digging the same way on its own. Retargets whatever it was doing,
 * losing the progress of the cell it was on.
 *
 * Returns false when the cell cannot be dug, when no tunnel leads to it, and
 * while the cargo is being handed over: an interrupted hand-over would waste
 * the whole trip up.
 */
export function aimDrill(state: ShiftState, col: number, row: number): boolean {
  if (state.phase !== 'running' || state.drill.mode === 'banking' || !canDig(state, col, row)) {
    return false;
  }
  const route = routeToDig(state, startCell(state), col, row);
  if (!route) {
    return false;
  }
  setRoute(state, route, { col, row, kind: 'cell' });
  return true;
}

/** Call the elevator: the drill drives up through the tunnel and hands the cargo over. */
export function callElevator(state: ShiftState): boolean {
  const { drill } = state;
  if (state.phase === 'finished' || drill.mode === 'banking') {
    return false;
  }
  beginAscent(state);
  return true;
}

/**
 * Point the turret at one enemy. It holds that target until the enemy dies or
 * reaches the dome, then it goes back to shooting whoever is closest.
 */
export function aimTurret(state: ShiftState, enemyId: number): boolean {
  if (state.phase !== 'running') {
    return false;
  }
  return aimTurretAt(state.defense, enemyId);
}

/** One salvo over the whole screen. False while the cooldown is still running. */
export function fireSalvo(state: ShiftState): boolean {
  if (state.phase !== 'running') {
    return false;
  }
  return fireSalvoAt(state.balance, state.defense);
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
    time = Math.min(time, defenseTimeToNextEvent(state.balance, state.defense));
  }
  switch (drill.mode) {
    case 'moving':
      time = Math.min(time, travelTimeSec(distanceToNextStep(state), state.balance.drill.move_rows_per_sec));
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
    advanceDefense(state.balance, state.defense, dtSec);
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
    state.endReason = 'timer';
    // Enemies leave with the wave that sent them: the ascent is not a fight.
    clearEnemies(state.defense);
    if (drill.mode !== 'banking') {
      beginAscent(state);
    }
    return true;
  }

  if (state.phase === 'running') {
    if (resolveDefense(state.balance, state.defense, drillLayerIndex(state))) {
      return true;
    }
    if (state.defense.hp <= EPS) {
      breachDome(state);
      return true;
    }
  }

  if (state.phase === 'ending' && (drill.mode === 'idle' || drill.mode === 'blocked')) {
    beginAscent(state);
    return true;
  }

  switch (drill.mode) {
    case 'moving':
      if (drill.path.length > 0) {
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
  const start = startCell(state);
  const route = routeToSurface(state, start);
  if (!route) {
    // Every dug cell touches row 0 through the tunnel it was dug from, so this
    // only guards a broken grid: hand the cargo over where the drill stands.
    drill.path = [];
    drill.col = Math.min(state.width - 1, Math.max(0, Math.round(drill.col)));
    drill.row = ENTRANCE_ROW;
    drill.target = { col: drill.col, row: ENTRANCE_ROW, kind: 'surface' };
    drill.mode = 'banking';
    drill.digElapsedSec = 0;
    drill.digTotalSec = 0;
    drill.bankElapsedSec = 0;
    return;
  }
  const last = route[route.length - 1] ?? start;
  setRoute(state, route, { col: last.col, row: last.row, kind: 'surface' });
}

/**
 * The dome is down: emergency ascent, right now. The shift is over, the cargo
 * that was not handed over is gone, everything already banked stays, and the
 * depth reached still counts (PLAN_V1 §2). This is not a defeat screen.
 */
function breachDome(state: ShiftState): void {
  const { drill } = state;
  state.defense.hp = 0;
  clearEnemies(state.defense);
  state.cargo = 0;
  state.endReason = 'breach';
  state.phase = 'finished';
  drill.mode = 'idle';
  drill.target = null;
  drill.path = [];
  drill.digElapsedSec = 0;
  drill.digTotalSec = 0;
  drill.bankElapsedSec = 0;
}

/** Cells between the drill and the next cell on its route. */
function distanceToNextStep(state: ShiftState): number {
  const { drill } = state;
  const next = drill.path[0];
  if (!next) {
    return 0;
  }
  return Math.abs(next.col - drill.col) + Math.abs(next.row - drill.row);
}

function moveDrill(state: ShiftState, dtSec: number): void {
  const { drill } = state;
  let reach = state.balance.drill.move_rows_per_sec * dtSec;
  while (reach > EPS) {
    const next = drill.path[0];
    if (!next) {
      return;
    }
    const dCol = next.col - drill.col;
    const dRow = next.row - drill.row;
    const distance = Math.abs(dCol) + Math.abs(dRow);
    if (distance <= reach + EPS) {
      drill.col = next.col;
      drill.row = next.row;
      drill.path.shift();
      reach -= distance;
      continue;
    }
    const share = reach / distance;
    drill.col += dCol * share;
    drill.row += dRow * share;
    return;
  }
}

function arrive(state: ShiftState): void {
  const { drill } = state;
  const target = drill.target;
  drill.path = [];
  if (!target) {
    drill.mode = 'idle';
    return;
  }

  if (target.kind === 'surface') {
    drill.mode = 'banking';
    drill.bankElapsedSec = 0;
    return;
  }

  if (target.kind === 'park' || cellAt(state, target.col, target.row) === 'dug') {
    drill.mode = 'idle';
    drill.target = null;
    return;
  }

  // Full cargo stops the drill in the tunnel: it never starts a cell whose
  // scrap would not fit, so nothing mined is ever thrown away (PLAN_V1 §4).
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

  // One tap is one decision: the drill drives into the cell it has just opened
  // and goes on digging the same way, until the grid ends or the cargo fills up.
  const dCol = target.col - drill.col;
  const dRow = target.row - drill.row;
  const entered: GridPos = { col: target.col, row: target.row };
  const ahead: GridPos = { col: target.col + dCol, row: target.row + dRow };
  drill.path = [entered];
  drill.target = canDig(state, ahead.col, ahead.row)
    ? { col: ahead.col, row: ahead.row, kind: 'cell' }
    : { col: entered.col, row: entered.row, kind: 'park' };
  drill.mode = 'moving';
  drill.digElapsedSec = 0;
  drill.digTotalSec = 0;
}

function completeBank(state: ShiftState): void {
  const { drill } = state;
  state.banked += state.cargo;
  state.cargo = 0;
  drill.target = null;
  drill.path = [];
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

/* ------------------------------------------------------------------- routes */

/** Cell a route starts from: the one the drill is entering, or the one it stands on. */
function startCell(state: ShiftState): GridPos {
  const { drill } = state;
  const pending = drill.mode === 'moving' ? drill.path[0] : undefined;
  if (pending) {
    return pending;
  }
  return { col: Math.round(drill.col), row: Math.round(drill.row) };
}

/**
 * Puts the drill on a route. The cell it is already driving into stays the
 * first step: the drill cannot turn around in the middle of a cell.
 */
function setRoute(state: ShiftState, route: readonly GridPos[], target: DrillTarget): void {
  const { drill } = state;
  const pending = drill.mode === 'moving' ? drill.path[0] : undefined;
  drill.path = pending ? [pending, ...route] : [...route];
  drill.target = target;
  drill.mode = 'moving';
  drill.digElapsedSec = 0;
  drill.digTotalSec = 0;
  drill.bankElapsedSec = 0;
}

interface Reach {
  /** Distance in cells from the start, -1 when unreachable. */
  readonly dist: number[];
  /** Index of the previous cell on the shortest route, -1 when there is none. */
  readonly prev: number[];
}

function cellIndex(state: ShiftState, pos: GridPos): number {
  return pos.row * state.width + pos.col;
}

/** Breadth-first walk over dug cells: the drill only drives through the tunnel. */
function reachFrom(state: ShiftState, start: GridPos): Reach {
  const size = state.width * state.rowCount;
  const dist = new Array<number>(size).fill(-1);
  const prev = new Array<number>(size).fill(-1);
  if (!isDug(state, start.col, start.row)) {
    return { dist, prev };
  }

  const startIndex = cellIndex(state, start);
  dist[startIndex] = 0;
  const queue: number[] = [startIndex];
  for (let head = 0; head < queue.length; head += 1) {
    const from = queue[head] ?? 0;
    const fromCol = from % state.width;
    const fromRow = (from - fromCol) / state.width;
    const fromDist = dist[from] ?? 0;
    for (const stepPos of STEPS) {
      const col = fromCol + stepPos.col;
      const row = fromRow + stepPos.row;
      if (!isDug(state, col, row)) {
        continue;
      }
      const index = row * state.width + col;
      if ((dist[index] ?? -1) >= 0) {
        continue;
      }
      dist[index] = fromDist + 1;
      prev[index] = from;
      queue.push(index);
    }
  }
  return { dist, prev };
}

/** Cells to drive through to get from `start` to `goal`, `start` excluded. */
function routeCells(state: ShiftState, reach: Reach, start: GridPos, goal: GridPos): GridPos[] {
  const startIndex = cellIndex(state, start);
  const cells: GridPos[] = [];
  let index = cellIndex(state, goal);
  while (index !== startIndex) {
    const col = index % state.width;
    cells.push({ col, row: (index - col) / state.width });
    const back = reach.prev[index] ?? -1;
    if (back < 0) {
      return [];
    }
    index = back;
  }
  cells.reverse();
  return cells;
}

/**
 * Route to a cell the target can be dug from: the nearest dug edge neighbour
 * of the target, ties broken by `STEPS`. Null when no tunnel leads there.
 */
function routeToDig(state: ShiftState, start: GridPos, col: number, row: number): GridPos[] | null {
  const reach = reachFrom(state, start);
  let best: GridPos | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const stepPos of STEPS) {
    const launch: GridPos = { col: col + stepPos.col, row: row + stepPos.row };
    if (!isDug(state, launch.col, launch.row)) {
      continue;
    }
    const dist = reach.dist[cellIndex(state, launch)] ?? -1;
    if (dist < 0 || dist >= bestDist) {
      continue;
    }
    best = launch;
    bestDist = dist;
  }
  if (!best) {
    return null;
  }
  return routeCells(state, reach, start, best);
}

/** Route up to the nearest entrance cell. Null when no tunnel leads there. */
function routeToSurface(state: ShiftState, start: GridPos): GridPos[] | null {
  const reach = reachFrom(state, start);
  let best: GridPos | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let col = 0; col < state.width; col += 1) {
    const dist = reach.dist[cellIndex(state, { col, row: ENTRANCE_ROW })] ?? -1;
    if (dist < 0 || dist >= bestDist) {
      continue;
    }
    best = { col, row: ENTRANCE_ROW };
    bestDist = dist;
  }
  if (!best) {
    return null;
  }
  return routeCells(state, reach, start, best);
}
