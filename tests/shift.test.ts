import { describe, expect, it } from 'vitest';
import balanceJson from '../content/balance.json' with { type: 'json' };
import type { Balance } from '../src/sim/balance.js';
import {
  aimDrill,
  callElevator,
  canDig,
  cargoCapacity,
  cellAt,
  createShift,
  digProgress,
  ENTRANCE_ROW,
  isCargoBlocked,
  isDug,
  shiftReport,
  step,
  type ShiftState,
} from '../src/sim/shift.js';

const balance = balanceJson as unknown as Balance;

/** Column the drill starts in: middle of the grid. */
const START_COL = Math.floor(balance.shift.grid_width / 2);

/**
 * No wave ever comes out this late. These tests are about the drill, the cargo
 * and the timer; the dome defence has its own file, tests/defense.test.ts.
 */
const QUIET_WAVES = 1e9;

/** Balance variant. Tests bend single numbers, they never invent new ones. */
function balanceWith(patch: {
  cargoCapacity?: number;
  durationSec?: number;
  bankSec?: number;
  firstWaveSec?: number;
  domeHp?: number;
  enemyHpBase?: number;
}): Balance {
  return {
    ...balance,
    shift: {
      ...balance.shift,
      duration_sec: patch.durationSec ?? balance.shift.duration_sec,
      elevator_bank_sec: patch.bankSec ?? balance.shift.elevator_bank_sec,
    },
    cargo: {
      ...balance.cargo,
      capacity_base: patch.cargoCapacity ?? balance.cargo.capacity_base,
    },
    dome: {
      ...balance.dome,
      hp_base: patch.domeHp ?? balance.dome.hp_base,
    },
    waves: {
      ...balance.waves,
      first_wave_sec: patch.firstWaveSec ?? balance.waves.first_wave_sec,
      enemy_hp_base: patch.enemyHpBase ?? balance.waves.enemy_hp_base,
    },
  };
}

function travelSec(cells: number, from: Balance = balance): number {
  return cells / from.drill.move_rows_per_sec;
}

function digSec(layerIndex: number, from: Balance = balance): number {
  const layer = from.layers[layerIndex];
  if (!layer) {
    throw new Error(`no layer ${layerIndex} in balance`);
  }
  return layer.hardness_sec / from.drill.speed_base;
}

function layerYield(layerIndex: number): number {
  const layer = balance.layers[layerIndex];
  if (!layer) {
    throw new Error(`no layer ${layerIndex} in balance`);
  }
  return layer.yield;
}

/** Digging one cell: drill it from the tunnel, then drive into it. */
const PER_CELL_SEC = digSec(0) + travelSec(1);

/** Row ranges as balance.json lists them: the tests follow the data. */
function layerRows(layerIndex: number): readonly [number, number] {
  const layer = balance.layers[layerIndex];
  if (!layer) {
    throw new Error(`no layer ${layerIndex} in balance`);
  }
  return layer.rows;
}

/**
 * Runs the shift until the drill has nothing left to do. Used where the test is
 * about where the drill stops, not about how long it took: how long a shaft
 * takes is a balance number and it changes.
 */
function runUntilIdle(state: ShiftState, stepSec = 1): void {
  for (let guard = 0; guard < 100000; guard += 1) {
    if (state.drill.mode === 'idle' || state.phase !== 'running') {
      return;
    }
    step(state, stepSec);
  }
  throw new Error('the drill never stopped');
}

/**
 * Digs one cell to the end and returns the time spent. Waits until the drill
 * has driven into the fresh cell, which is where the next order starts from.
 *
 * Hands the cargo over on the way when the cell no longer fits it, and only
 * then: how many cells of a layer fit one cargo is a balance number (two of the
 * first layer today, one of the third), and a helper that assumed a shaft could
 * be sunk on one backpack would break the next time it changes.
 *
 * The seconds it returns are the seconds the caller asked for — the digging —
 * plus, on the one call per cargo where the drill had to go up first, the trip.
 * Callers that time a single cell (`digSec`) never hit that: they dig the first
 * cell of a fresh shift into an empty backpack.
 */
function digCell(state: ShiftState, col: number, row: number): number {
  let spent = 0;
  const limit = 2000;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(aimDrill(state, col, row)).toBe(true);
    for (let guard = 0; guard < limit; guard += 1) {
      if (state.phase !== 'running') {
        return spent;
      }
      if (isDug(state, col, row) && state.drill.col === col && state.drill.row === row) {
        return spent;
      }
      if (isCargoBlocked(state)) {
        bankCargo(state);
        break;
      }
      step(state, 0.05);
      spent += 0.05;
    }
  }
  throw new Error(`cell ${col},${row} was not dug in ${limit} steps`);
}

/** Sends the drill up, waits out the hand-over and leaves it idle at the top. */
function bankCargo(state: ShiftState): void {
  expect(callElevator(state)).toBe(true);
  for (let guard = 0; guard < 20000; guard += 1) {
    if (state.phase !== 'running' || state.drill.mode === 'idle') {
      return;
    }
    step(state, 0.05);
  }
  throw new Error('the cargo was never handed over');
}

/** Straight tunnel down a column, from the entrance to `toRow` inclusive. */
function digDownTo(state: ShiftState, col: number, toRow: number): void {
  for (let row = ENTRANCE_ROW + 1; row <= toRow; row += 1) {
    if (!isDug(state, col, row)) {
      digCell(state, col, row);
    }
  }
}

/** Gallery along one row, from `fromCol` leftwards to `toCol` inclusive. */
function digLeftTo(state: ShiftState, row: number, fromCol: number, toCol: number): void {
  for (let col = fromCol; col >= toCol; col -= 1) {
    if (!isDug(state, col, row)) {
      digCell(state, col, row);
    }
  }
}

/** Seconds the drill needs to reach the elevator after it is called. */
function timeToBank(state: ShiftState): number {
  expect(callElevator(state)).toBe(true);
  const dt = 0.005;
  let spent = 0;
  for (let guard = 0; guard < 4000; guard += 1) {
    if (state.drill.mode === 'banking') {
      return spent;
    }
    step(state, dt);
    spent += dt;
  }
  throw new Error('the drill never reached the elevator');
}

/** Runs the timer out without spending any surplus time on the ascent. */
function runTimerOut(state: ShiftState): void {
  step(state, state.timeLeftSec);
}

describe('createShift', () => {
  it('opens the entrance row and leaves everything below as rock', () => {
    const state = createShift(balance, 1);
    expect(state.width).toBe(balance.shift.grid_width);
    expect(state.rowCount).toBe(balance.shift.grid_depth + 1);
    for (let col = 0; col < state.width; col += 1) {
      expect(cellAt(state, col, ENTRANCE_ROW)).toBe('dug');
      expect(cellAt(state, col, ENTRANCE_ROW + 1)).toBe('rock');
    }
  });

  it('parks the drill on the entrance row with an empty cargo and a full timer', () => {
    const state = createShift(balance, 1);
    expect(state.drill.row).toBe(ENTRANCE_ROW);
    expect(state.drill.mode).toBe('idle');
    expect(state.cargo).toBe(0);
    expect(state.banked).toBe(0);
    expect(state.crystals).toBe(0);
    expect(state.timeLeftSec).toBeCloseTo(balance.shift.duration_sec, 10);
    expect(state.phase).toBe('running');
  });
});

describe('neighbour rule', () => {
  it('allows only cells touching a dug cell by an edge', () => {
    const state = createShift(balance, 1);
    expect(canDig(state, START_COL, ENTRANCE_ROW + 1)).toBe(true);
    expect(canDig(state, START_COL, ENTRANCE_ROW + 2)).toBe(false);
    expect(canDig(state, START_COL, ENTRANCE_ROW)).toBe(false); // already dug
  });

  it('refuses a diagonal neighbour', () => {
    const state = createShift(balance, 1);
    digCell(state, START_COL, 1);
    expect(isDug(state, START_COL, 1)).toBe(true);
    const order = state.drill.target;
    // (START_COL + 1, 2) touches the dug (START_COL, 1) only by a corner.
    expect(canDig(state, START_COL + 1, 2)).toBe(false);
    expect(aimDrill(state, START_COL + 1, 2)).toBe(false);
    expect(state.drill.target).toEqual(order);
  });

  it('refuses cells outside the grid', () => {
    const state = createShift(balance, 1);
    expect(canDig(state, -1, 1)).toBe(false);
    expect(canDig(state, state.width, 1)).toBe(false);
    expect(canDig(state, START_COL, state.rowCount)).toBe(false);
    expect(canDig(state, START_COL, 1.5)).toBe(false);
  });

  it('opens sideways cells once a row is entered', () => {
    const state = createShift(balance, 1);
    digDownTo(state, START_COL, 2);
    expect(canDig(state, START_COL, 2)).toBe(false);
    expect(canDig(state, START_COL - 1, 2)).toBe(true);
    expect(canDig(state, START_COL + 1, 2)).toBe(true);
    expect(canDig(state, START_COL, 3)).toBe(true);
  });
});

describe('travel time', () => {
  it('digs the neighbouring cell from where it stands, then drives into it', () => {
    const state = createShift(balance, 1);
    expect(aimDrill(state, START_COL, 1)).toBe(true);

    // The entrance row is already a tunnel, so there is no road to pay first.
    step(state, 0.01);
    expect(state.drill.mode).toBe('digging');
    expect(state.drill.row).toBe(ENTRANCE_ROW);

    step(state, digSec(0));
    expect(isDug(state, START_COL, 1)).toBe(true);
    expect(state.drill.mode).toBe('moving');
    expect(state.drill.row).toBeGreaterThan(ENTRANCE_ROW);
    expect(state.drill.row).toBeLessThan(1);

    step(state, travelSec(1));
    expect(state.drill.row).toBe(1);
  });

  it('scales the road with the number of rows', () => {
    const state = createShift(balance, 1);
    digDownTo(state, START_COL, 5);
    expect(state.drill.row).toBe(5);

    expect(callElevator(state)).toBe(true);
    step(state, travelSec(5) - 0.001);
    expect(state.drill.mode).toBe('moving');
    step(state, 0.002);
    expect(state.drill.mode).toBe('banking');
    expect(state.drill.row).toBe(ENTRANCE_ROW);
  });

  it('gives the same result for one long step and many short ones', () => {
    const long = createShift(balance, 7);
    const short = createShift(balance, 7);
    aimDrill(long, START_COL, 1);
    aimDrill(short, START_COL, 1);

    step(long, 1);
    for (let i = 0; i < 100; i += 1) {
      step(short, 0.01);
    }

    expect(long.cargo).toBe(short.cargo);
    expect(long.drill.mode).toBe(short.drill.mode);
    expect(long.timeLeftSec).toBeCloseTo(short.timeLeftSec, 6);
    expect(long.crystals).toBe(short.crystals);
  });
});

describe('tunnel routes', () => {
  it('counts the cells of the tunnel, not the straight line', () => {
    const state = createShift(balanceWith({ cargoCapacity: 1e6 }), 1);
    digDownTo(state, START_COL, 6);
    digLeftTo(state, 6, START_COL - 1, 0);
    expect(state.drill.col).toBe(0);
    expect(state.drill.row).toBe(6);

    // (START_COL + 1, 1) is dug from (START_COL, 1): four cells back along the
    // gallery plus five up the shaft, while the straight line is about 6.4.
    expect(aimDrill(state, START_COL + 1, 1)).toBe(true);
    step(state, travelSec(6.5));
    expect(state.drill.mode).toBe('moving');

    step(state, travelSec(9) - travelSec(6.5) + 0.002);
    expect(state.drill.mode).toBe('digging');
    expect(state.drill.col).toBe(START_COL);
    expect(state.drill.row).toBe(1);
  });

  it('ignores a target no tunnel leads to', () => {
    const state = createShift(balance, 1);
    // A dug pocket cut off from the mine: the drill must not teleport into it.
    state.cells[5 * state.width + 0] = 'dug';

    expect(canDig(state, 0, 6)).toBe(true);
    expect(aimDrill(state, 0, 6)).toBe(false);
    expect(state.drill.mode).toBe('idle');
    expect(state.drill.target).toBeNull();
  });

  it('makes a winding way back to the elevator cost more than a straight one', () => {
    const straight = createShift(balanceWith({ cargoCapacity: 1e6 }), 1);
    digDownTo(straight, START_COL, 5);
    const straightSec = timeToBank(straight);

    const winding = createShift(balanceWith({ cargoCapacity: 1e6 }), 1);
    digDownTo(winding, START_COL, 5);
    digLeftTo(winding, 5, START_COL - 1, 0);
    const windingSec = timeToBank(winding);

    // Straight: five rows up. Winding: four cells of gallery plus five rows.
    expect(straightSec).toBeCloseTo(travelSec(5), 2);
    expect(windingSec).toBeCloseTo(travelSec(9), 2);
    expect(windingSec).toBeGreaterThan(straightSec);
  });
});

describe('one tap keeps the drill digging', () => {
  it('digs on downwards after the cell it was sent to', () => {
    const state = createShift(balanceWith({ cargoCapacity: 1e6 }), 1);
    expect(aimDrill(state, START_COL, 1)).toBe(true);

    step(state, PER_CELL_SEC * 4);
    for (let row = 1; row <= 4; row += 1) {
      expect(isDug(state, START_COL, row)).toBe(true);
    }
    expect(isDug(state, START_COL, 5)).toBe(false);
    expect(state.drill.col).toBe(START_COL);
    expect(state.drill.row).toBe(4);
  });

  it('goes on sideways when the tap was sideways', () => {
    const state = createShift(balanceWith({ cargoCapacity: 1e6 }), 1);
    digDownTo(state, START_COL, 2);
    expect(aimDrill(state, START_COL - 1, 2)).toBe(true);

    step(state, PER_CELL_SEC * 3);
    expect(isDug(state, START_COL - 1, 2)).toBe(true);
    expect(isDug(state, START_COL - 2, 2)).toBe(true);
    expect(isDug(state, START_COL - 3, 2)).toBe(true);
    expect(isDug(state, START_COL, 3)).toBe(false);
  });

  it('stops at the bottom of the grid', () => {
    const bottom = balance.shift.grid_depth;
    // The whole shaft is far more than one shift of digging, so the clock and
    // the waves are taken out of the way: this is about where the drill stops.
    const state = createShift(
      balanceWith({ cargoCapacity: 1e6, durationSec: 1e6, firstWaveSec: QUIET_WAVES }),
      1,
    );
    expect(aimDrill(state, START_COL, 1)).toBe(true);

    runUntilIdle(state);
    expect(isDug(state, START_COL, bottom)).toBe(true);
    expect(state.deepestRow).toBe(bottom);
    expect(state.drill.row).toBe(bottom);
    expect(state.drill.mode).toBe('idle');
    expect(state.drill.target).toBeNull();
    expect(state.phase).toBe('running');
  });

  it('stops at the wall when it digs sideways', () => {
    const state = createShift(balanceWith({ cargoCapacity: 1e6 }), 1);
    digDownTo(state, START_COL, 1);
    expect(aimDrill(state, START_COL - 1, 1)).toBe(true);

    step(state, PER_CELL_SEC * START_COL + 1);
    for (let col = 0; col < START_COL; col += 1) {
      expect(isDug(state, col, 1)).toBe(true);
    }
    expect(state.drill.col).toBe(0);
    expect(state.drill.mode).toBe('idle');
    expect(state.drill.target).toBeNull();
  });

  it('stops when the cargo is full and keeps every gram', () => {
    const capacity = layerYield(0) * 3;
    const state = createShift(balanceWith({ cargoCapacity: capacity }), 1);
    expect(aimDrill(state, START_COL, 1)).toBe(true);

    step(state, PER_CELL_SEC * 3 + 1);
    expect(state.drill.mode).toBe('blocked');
    expect(state.drill.row).toBe(3);
    expect(isDug(state, START_COL, 3)).toBe(true);
    expect(isDug(state, START_COL, 4)).toBe(false);
    expect(state.cargo).toBe(capacity);
    expect(state.mined).toBe(capacity);
    expect(state.banked).toBe(0);
  });

  it('waits for the player after banking instead of digging on', () => {
    const capacity = layerYield(0) * 2;
    const state = createShift(balanceWith({ cargoCapacity: capacity }), 1);
    aimDrill(state, START_COL, 1);
    step(state, PER_CELL_SEC * 2 + 1);
    expect(state.drill.mode).toBe('blocked');

    expect(callElevator(state)).toBe(true);
    step(state, travelSec(2) + balance.shift.elevator_bank_sec + 0.01);
    expect(state.banked).toBe(capacity);
    expect(state.drill.mode).toBe('idle');

    step(state, 5);
    expect(state.drill.mode).toBe('idle');
    expect(state.drill.target).toBeNull();
    expect(state.cargo).toBe(0);
  });
});

describe('dig time by layer', () => {
  it('takes the hardness of the first layer on row 1', () => {
    const state = createShift(balance, 1);
    expect(aimDrill(state, START_COL, 1)).toBe(true);

    step(state, digSec(0) - 0.002);
    expect(isDug(state, START_COL, 1)).toBe(false);
    expect(digProgress(state)).toBeGreaterThan(0.9);

    step(state, 0.004);
    expect(isDug(state, START_COL, 1)).toBe(true);
  });

  it('changes hardness exactly where balance puts the layer boundary', () => {
    // Both boundaries, wherever they are: the last row of a layer still costs
    // that layer, and the very next row already costs the one below it.
    for (let index = 0; index + 1 < balance.layers.length; index += 1) {
      const last = layerRows(index)[1];
      const state = createShift(
        balanceWith({ cargoCapacity: 1e6, durationSec: 1e6, firstWaveSec: QUIET_WAVES }),
        1,
      );
      digDownTo(state, START_COL, last - 1);

      const lastRow = digCell(state, START_COL, last);
      const nextRow = digCell(state, START_COL, last + 1);
      const road = travelSec(1);

      // Each row costs its own layer, to the step of the loop above. The test
      // used to say «the next row costs more», which quietly assumed the rock
      // gets harder with depth; it no longer does (see tests/mining.test.ts —
      // what grows with depth is the scrap a second of drilling is worth), so
      // the check now reads both numbers out of balance instead.
      const slack = 0.1;
      expect(lastRow).toBeGreaterThanOrEqual(digSec(index) + road);
      expect(lastRow).toBeLessThan(digSec(index) + road + slack);
      expect(nextRow).toBeGreaterThanOrEqual(digSec(index + 1) + road);
      expect(nextRow).toBeLessThan(digSec(index + 1) + road + slack);
    }
  });

  it('drops the scrap of the layer it dug', () => {
    const state = createShift(
      balanceWith({ cargoCapacity: 1e6, durationSec: 1e6, firstWaveSec: QUIET_WAVES }),
      1,
    );
    digCell(state, START_COL, 1);
    expect(state.cargo).toBe(layerYield(0));

    // Down through the whole first layer and one row into the second one.
    const firstRow = layerRows(1)[0];
    digDownTo(state, START_COL, firstRow);
    expect(state.cargo).toBe(layerYield(0) * (firstRow - 1) + layerYield(1));
  });

  it('retargeting loses the progress of the abandoned cell', () => {
    const state = createShift(balance, 1);
    aimDrill(state, START_COL, 1);
    step(state, digSec(0) / 2);
    expect(digProgress(state)).toBeGreaterThan(0);

    expect(aimDrill(state, START_COL + 1, 1)).toBe(true);
    expect(digProgress(state)).toBe(0);
    expect(isDug(state, START_COL, 1)).toBe(false);
  });
});

describe('cargo', () => {
  it('fills up to the capacity and stops the drill without losing scrap', () => {
    const capacity = layerYield(0) * 2;
    const state = createShift(balanceWith({ cargoCapacity: capacity }), 1);
    expect(cargoCapacity(state)).toBe(capacity);

    digCell(state, START_COL, 1);
    digCell(state, START_COL, 2);
    expect(state.cargo).toBe(capacity);

    // Third cell does not fit: the drill stays in the tunnel and stands still.
    expect(aimDrill(state, START_COL, 3)).toBe(true);
    step(state, 10);
    expect(state.drill.mode).toBe('blocked');
    expect(isCargoBlocked(state)).toBe(true);
    expect(isDug(state, START_COL, 3)).toBe(false);
    expect(state.cargo).toBe(capacity);
    expect(state.mined).toBe(capacity);
    expect(state.banked).toBe(0);
    expect(digProgress(state)).toBe(0);
  });

  it('never mines more than it can carry or bank', () => {
    const capacity = layerYield(0) * 3;
    const state = createShift(balanceWith({ cargoCapacity: capacity }), 1);
    for (let row = 1; row <= 6; row += 1) {
      aimDrill(state, START_COL, row);
      step(state, 5);
    }
    expect(state.cargo).toBeLessThanOrEqual(capacity);
    expect(state.mined).toBe(state.banked + state.cargo);
  });

  it('digs again after the cargo is emptied', () => {
    const capacity = layerYield(0) * 2;
    const state = createShift(balanceWith({ cargoCapacity: capacity }), 1);
    digCell(state, START_COL, 1);
    digCell(state, START_COL, 2);

    callElevator(state);
    step(state, travelSec(2) + balance.shift.elevator_bank_sec + 0.01);
    expect(state.cargo).toBe(0);
    expect(state.banked).toBe(capacity);

    digCell(state, START_COL, 3);
    expect(isDug(state, START_COL, 3)).toBe(true);
    expect(state.cargo).toBe(layerYield(0));
  });
});

describe('elevator', () => {
  it('banks the cargo after the hand-over time and empties the backpack', () => {
    const state = createShift(balance, 1);
    digCell(state, START_COL, 1);
    const carried = state.cargo;
    expect(carried).toBeGreaterThan(0);

    expect(callElevator(state)).toBe(true);
    step(state, travelSec(1));
    expect(state.drill.mode).toBe('banking');

    step(state, balance.shift.elevator_bank_sec - 0.002);
    expect(state.banked).toBe(0);
    expect(state.cargo).toBe(carried);

    step(state, 0.004);
    expect(state.banked).toBe(carried);
    expect(state.cargo).toBe(0);
    expect(state.drill.mode).toBe('idle');
    expect(state.drill.row).toBe(ENTRANCE_ROW);
  });

  it('keeps banked scrap safe across later trips', () => {
    const state = createShift(balance, 1);
    digCell(state, START_COL, 1);
    callElevator(state);
    step(state, travelSec(1) + balance.shift.elevator_bank_sec + 0.01);
    const bankedOnce = state.banked;

    digCell(state, START_COL, 2);
    callElevator(state);
    step(state, travelSec(2) + balance.shift.elevator_bank_sec + 0.01);
    expect(state.banked).toBe(bankedOnce + layerYield(0));
    expect(state.mined).toBe(state.banked);
  });

  it('ignores taps while the cargo is being handed over', () => {
    const state = createShift(balance, 1);
    digCell(state, START_COL, 1);
    callElevator(state);
    step(state, travelSec(1) + balance.shift.elevator_bank_sec / 2);
    expect(state.drill.mode).toBe('banking');
    expect(aimDrill(state, START_COL, 2)).toBe(false);
    expect(state.drill.mode).toBe('banking');
  });
});

describe('shift timer', () => {
  /** One tap down, dug until the cargo is full: a known depth and a known load. */
  function shiftStoppedAtRow(rows: number): ShiftState {
    const capacity = layerYield(0) * rows;
    const state = createShift(balanceWith({ cargoCapacity: capacity, firstWaveSec: QUIET_WAVES }), 1);
    expect(aimDrill(state, START_COL, 1)).toBe(true);
    step(state, PER_CELL_SEC * (rows + 1));
    expect(state.drill.mode).toBe('blocked');
    expect(state.drill.row).toBe(rows);
    expect(state.cargo).toBe(capacity);
    return state;
  }

  it('counts down and never goes below zero', () => {
    const state = createShift(balanceWith({ firstWaveSec: QUIET_WAVES }), 1);
    step(state, 10);
    expect(state.timeLeftSec).toBeCloseTo(balance.shift.duration_sec - 10, 6);
    step(state, balance.shift.duration_sec);
    expect(state.timeLeftSec).toBe(0);
  });

  it('ascends automatically when the time is out and banks everything', () => {
    const state = shiftStoppedAtRow(3);
    const carried = state.cargo;

    runTimerOut(state);
    expect(state.phase).toBe('ending');
    expect(state.drill.mode).toBe('moving');
    expect(state.cargo).toBe(carried);

    step(state, travelSec(3) + balance.shift.elevator_bank_sec + 0.01);
    expect(state.phase).toBe('finished');
    expect(state.cargo).toBe(0);
    expect(state.banked).toBe(carried);
    expect(state.mined).toBe(state.banked);
  });

  it('takes the road and the hand-over before the report shows up', () => {
    const state = shiftStoppedAtRow(3);
    runTimerOut(state);

    step(state, travelSec(3) - 0.002);
    expect(state.phase).toBe('ending');
    step(state, 0.004);
    expect(state.drill.mode).toBe('banking');
    expect(state.phase).toBe('ending');
    step(state, balance.shift.elevator_bank_sec + 0.01);
    expect(state.phase).toBe('finished');
  });

  it('accepts no orders once finished', () => {
    const state = createShift(balanceWith({ firstWaveSec: QUIET_WAVES }), 1);
    step(state, balance.shift.duration_sec + balance.shift.elevator_bank_sec + 1);
    expect(state.phase).toBe('finished');
    expect(aimDrill(state, START_COL, 1)).toBe(false);
    expect(callElevator(state)).toBe(false);

    const before = { ...state.drill, path: [...state.drill.path] };
    step(state, 60);
    expect(state.drill).toEqual(before);
    expect(state.timeLeftSec).toBe(0);
  });

  it('reports what the shift produced', () => {
    const state = shiftStoppedAtRow(4);
    step(state, balance.shift.duration_sec + travelSec(4) + balance.shift.elevator_bank_sec + 0.01);

    const report = shiftReport(state);
    expect(report.deepestRow).toBe(4);
    expect(report.mined).toBe(layerYield(0) * 4);
    expect(report.banked).toBe(report.mined);
    expect(report.crystals).toBe(state.crystals);
  });
});

describe('crystals', () => {
  const deepBalance = balanceWith({ cargoCapacity: 1e6, durationSec: 1e6, firstWaveSec: QUIET_WAVES });

  /** Digs a wide field in layers II and III and returns the crystal count. */
  function crystalRun(seed: number): number {
    const state = createShift(deepBalance, seed);
    digDownTo(state, START_COL, balance.shift.grid_depth);
    for (let row = 10; row <= balance.shift.grid_depth; row += 1) {
      for (let col = START_COL - 1; col >= 0; col -= 1) {
        digCell(state, col, row);
      }
      for (let col = START_COL + 1; col < state.width; col += 1) {
        digCell(state, col, row);
      }
    }
    return state.crystals;
  }

  it('drops nothing in the first layer', () => {
    const first = balance.layers[0];
    expect(first?.crystal_chance).toBe(0);
    const state = createShift(deepBalance, 12345);
    digDownTo(state, START_COL, 9);
    expect(state.crystals).toBe(0);
  });

  it('drops crystals in the deeper layers', () => {
    expect(crystalRun(1)).toBeGreaterThan(0);
  });

  it('gives the same crystals for the same seed', () => {
    expect(crystalRun(2024)).toBe(crystalRun(2024));
  });

  it('gives different crystals for different seeds', () => {
    const counts = new Set([crystalRun(1), crystalRun(2), crystalRun(3), crystalRun(4)]);
    expect(counts.size).toBeGreaterThan(1);
  });

  it('does not put crystals in the cargo and never loses them', () => {
    // The whole first layer plus three rows of the second one: deep enough for
    // the crystal rolls to have something to roll on.
    const secondTop = layerRows(1)[0];
    const deepRow = secondTop + 2;
    const load = layerYield(0) * (secondTop - 1) + layerYield(1) * 3;
    const state = createShift(
      balanceWith({ cargoCapacity: load, durationSec: 1e6, firstWaveSec: QUIET_WAVES }),
      99,
    );
    digDownTo(state, START_COL, deepRow);
    const crystals = state.crystals;
    expect(state.cargo).toBe(load);

    step(state, state.balance.shift.duration_sec + 100);
    expect(state.phase).toBe('finished');
    expect(state.crystals).toBe(crystals);
    expect(state.banked).toBe(load);
  });
});

describe('step guards', () => {
  it('rejects a negative or broken dt', () => {
    const state = createShift(balance, 1);
    expect(() => step(state, -1)).toThrow(RangeError);
    expect(() => step(state, Number.NaN)).toThrow(RangeError);
    expect(() => step(state, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('does nothing for a zero dt', () => {
    const state = createShift(balance, 1);
    step(state, 0);
    expect(state.timeLeftSec).toBe(balance.shift.duration_sec);
    expect(state.drill.mode).toBe('idle');
  });

  /**
   * Issue #13. `step` cuts time on the next event and drops the whole slice
   * when it is not greater than its float slack (1e-9 s). A partial move can
   * leave the drill a hair short of the cell it is driving into: closer than
   * `slack * move_rows_per_sec`, so the honest travel time is under the slack,
   * yet further than the slack itself, so `moveDrill` does not snap onto the
   * cell either. Before the fix nothing resolved that state and the shift
   * froze for good — the timer stopped, the drill stopped, and the player was
   * left inside a shift no phase could ever end.
   */
  it('never freezes when the drill stops a float hair short of a cell', () => {
    /** The slack `step` compares its slices against. Not a game number. */
    const SLACK_SEC = 1e-9;
    const speed = balance.drill.move_rows_per_sec;
    // Middle of the window that used to freeze: wider than the slack in cells,
    // narrower than the distance the drill covers in one slack of time.
    const gap = (SLACK_SEC + SLACK_SEC * speed) / 2;

    // A cargo big enough that the drill never blocks: this test is about the
    // clock, and one cell of the first layer now fills the real backpack.
    const state = createShift(balanceWith({ cargoCapacity: 1e6 }), 1);
    expect(aimDrill(state, START_COL, 1)).toBe(true);
    step(state, digSec(0));
    // The cell is open and the drill is driving into it, one whole cell away.
    expect(state.drill.mode).toBe('moving');
    expect(state.drill.row).toBe(ENTRANCE_ROW);

    step(state, (1 - gap) / speed);
    expect(state.drill.mode).toBe('moving');
    expect(state.drill.row).toBeLessThan(1);
    expect(1 - state.drill.row).toBeLessThan(SLACK_SEC * speed);

    const timeLeft = state.timeLeftSec;
    step(state, PER_CELL_SEC);
    // The time is spent on work, not swallowed: the drill drove into the cell
    // it had almost reached and carried on digging downwards.
    expect(state.timeLeftSec).toBeCloseTo(timeLeft - PER_CELL_SEC, 6);
    expect(isDug(state, START_COL, 2)).toBe(true);
    expect(state.drill.row).toBeGreaterThan(1);
  });
});

describe('the elevator drops the drill at a checkpoint', () => {
  /** Row the elevator drops at in these tests: an open checkpoint of the mine. */
  const DROP_ROW = balance.shift.checkpoint_every_rows;

  it('digs the shaft down to the drop row and leaves the rest as rock', () => {
    const state = createShift(balance, 1, { startRow: DROP_ROW });
    for (let row = ENTRANCE_ROW; row <= DROP_ROW; row += 1) {
      expect(cellAt(state, START_COL, row)).toBe('dug');
    }
    expect(cellAt(state, START_COL, DROP_ROW + 1)).toBe('rock');
    for (let col = 0; col < state.width; col += 1) {
      // Only the shaft is open below the entrance: the rest is untouched rock.
      expect(cellAt(state, col, ENTRANCE_ROW)).toBe('dug');
      if (col !== START_COL) {
        expect(cellAt(state, col, DROP_ROW)).toBe('rock');
      }
    }
  });

  it('parks the drill on the drop row with the depth already counted', () => {
    const state = createShift(balance, 1, { startRow: DROP_ROW });
    expect(state.startRow).toBe(DROP_ROW);
    expect(state.drill.row).toBe(DROP_ROW);
    expect(state.drill.col).toBe(START_COL);
    expect(state.drill.mode).toBe('idle');
    expect(state.deepestRow).toBe(DROP_ROW);
    expect(state.phase).toBe('running');
  });

  it('brings no scrap and no crystals for the cells of the shaft', () => {
    const state = createShift(balance, 1, { startRow: balance.shift.grid_depth });
    expect(state.cargo).toBe(0);
    expect(state.banked).toBe(0);
    expect(state.mined).toBe(0);
    expect(state.crystals).toBe(0);
  });

  it('starts on the surface when the setup says nothing', () => {
    const plain = createShift(balance, 1);
    expect(plain.startRow).toBe(ENTRANCE_ROW);
    expect(plain.deepestRow).toBe(ENTRANCE_ROW);
    expect(createShift(balance, 1, {}).startRow).toBe(ENTRANCE_ROW);
    expect(cellAt(plain, START_COL, ENTRANCE_ROW + 1)).toBe('rock');
  });

  it('refuses a drop row that is not a row of the grid', () => {
    for (const startRow of [-1, balance.shift.grid_depth + 1, 1.5, Number.NaN]) {
      expect(() => createShift(balance, 1, { startRow })).toThrow(RangeError);
    }
    // The bottom row is still a row: the deepest checkpoint is a valid drop.
    expect(() => createShift(balance, 1, { startRow: balance.shift.grid_depth })).not.toThrow();
  });

  it('digs on downwards from the drop row', () => {
    const state = createShift(balanceWith({ cargoCapacity: 1e6 }), 1, { startRow: DROP_ROW });
    expect(aimDrill(state, START_COL, DROP_ROW + 1)).toBe(true);

    step(state, PER_CELL_SEC * 2);
    expect(isDug(state, START_COL, DROP_ROW + 1)).toBe(true);
    expect(isDug(state, START_COL, DROP_ROW + 2)).toBe(true);
    expect(state.deepestRow).toBe(DROP_ROW + 2);
    expect(state.cargo).toBe(layerYield(0) * 2);
  });

  it('rides the shaft back up and hands the cargo over', () => {
    const state = createShift(balance, 1, { startRow: DROP_ROW });
    digCell(state, START_COL, DROP_ROW + 1);
    const carried = state.cargo;
    expect(carried).toBe(layerYield(0));

    // The road home is the whole shaft: the drill is one row below the drop.
    const road = timeToBank(state);
    expect(road).toBeCloseTo(travelSec(DROP_ROW + 1), 2);
    expect(state.drill.row).toBe(ENTRANCE_ROW);

    step(state, balance.shift.elevator_bank_sec + 0.01);
    expect(state.banked).toBe(carried);
    expect(state.cargo).toBe(0);
    expect(state.drill.mode).toBe('idle');
  });

  it('ascends the shaft on the timer with everything mined', () => {
    const state = createShift(
      balanceWith({ cargoCapacity: layerYield(0), firstWaveSec: QUIET_WAVES }),
      1,
      { startRow: DROP_ROW },
    );
    digCell(state, START_COL, DROP_ROW + 1);
    const carried = state.cargo;

    runTimerOut(state);
    expect(state.phase).toBe('ending');
    step(state, travelSec(DROP_ROW + 1) + balance.shift.elevator_bank_sec + 0.01);
    expect(state.phase).toBe('finished');
    expect(state.endReason).toBe('timer');
    expect(state.banked).toBe(carried);

    const report = shiftReport(state);
    expect(report.deepestRow).toBe(DROP_ROW + 1);
    expect(report.mined).toBe(carried);
  });
});

describe('the conveyor hands the scrap over by itself', () => {
  /** Enemies too tough for the turret: the test is about the dome, not the aim. */
  const UNKILLABLE = 1e6;

  /** Dome damage of the enemy the first layer sends. */
  const ABERRATION_DAMAGE = balance.enemies['aberration']?.dome_damage ?? 0;

  it('banks every dug cell at once and leaves the cargo empty', () => {
    const state = createShift(balanceWith({ firstWaveSec: QUIET_WAVES }), 1, { autoBank: true });
    expect(state.autoBank).toBe(true);
    expect(aimDrill(state, START_COL, 1)).toBe(true);

    step(state, PER_CELL_SEC * 3);
    expect(state.banked).toBe(layerYield(0) * 3);
    expect(state.cargo).toBe(0);
    expect(state.mined).toBe(state.banked);
    expect(isDug(state, START_COL, 3)).toBe(true);
  });

  it('never stops the drill on a full cargo, however small the cargo is', () => {
    // One cell of the first layer is the whole backpack: without the conveyor
    // the drill would stand still after the very first cell.
    const state = createShift(
      balanceWith({ cargoCapacity: layerYield(0), durationSec: 1e6, firstWaveSec: QUIET_WAVES }),
      1,
      { autoBank: true },
    );
    expect(aimDrill(state, START_COL, 1)).toBe(true);

    for (let guard = 0; guard < 100000; guard += 1) {
      if (state.deepestRow >= balance.shift.grid_depth) {
        break;
      }
      step(state, 0.25);
      expect(isCargoBlocked(state)).toBe(false);
      expect(state.cargo).toBe(0);
    }
    expect(state.deepestRow).toBe(balance.shift.grid_depth);
    expect(state.banked).toBe(state.mined);
    expect(state.banked).toBeGreaterThan(cargoCapacity(state));
  });

  it('refuses the elevator: there is never anything to carry up', () => {
    const state = createShift(balanceWith({ firstWaveSec: QUIET_WAVES }), 1, { autoBank: true });
    digCell(state, START_COL, 1);
    expect(state.banked).toBe(layerYield(0));

    expect(callElevator(state)).toBe(false);
    expect(state.drill.mode).not.toBe('banking');
    expect(state.drill.row).toBe(1);

    // The drill goes on taking dig orders where it stands.
    expect(aimDrill(state, START_COL, 2)).toBe(true);
  });

  it('ends the shift on the timer at once, without the road home', () => {
    const state = createShift(
      balanceWith({ cargoCapacity: 1e6, firstWaveSec: QUIET_WAVES }),
      1,
      { autoBank: true },
    );
    // Dug to the left wall, so the drill is standing still with a known load.
    digCell(state, START_COL, 1);
    expect(aimDrill(state, START_COL - 1, 1)).toBe(true);
    step(state, PER_CELL_SEC * (START_COL + 1));
    expect(state.drill.mode).toBe('idle');
    const banked = state.banked;
    expect(banked).toBe(layerYield(0) * (START_COL + 1));
    const deepRow = state.deepestRow;

    runTimerOut(state);
    expect(state.phase).toBe('finished');
    expect(state.endReason).toBe('timer');
    expect(state.drill.mode).toBe('idle');
    expect(state.drill.target).toBeNull();
    expect(state.drill.path).toEqual([]);
    // No trip up, no hand-over time: the shift is simply over.
    expect(state.drill.row).toBe(1);
    expect(state.banked).toBe(banked);
    expect(state.cargo).toBe(0);

    const report = shiftReport(state);
    expect(report.banked).toBe(banked);
    expect(report.mined).toBe(banked);
    expect(report.deepestRow).toBe(deepRow);

    // Nothing is left to resolve: a finished shift takes no more orders.
    step(state, 60);
    expect(aimDrill(state, START_COL, deepRow + 1)).toBe(false);
    expect(callElevator(state)).toBe(false);
    expect(state.banked).toBe(banked);
  });

  it('loses nothing when the dome falls: there was nothing in the cargo', () => {
    const state = createShift(
      balanceWith({
        domeHp: ABERRATION_DAMAGE,
        // The wave comes out after the first cell is in the bank. How long a
        // cell takes is a balance number and it is now longer than an enemy's
        // walk, so the wave is timed off the cell instead of off a written-in 1.
        firstWaveSec: PER_CELL_SEC + 1,
        enemyHpBase: UNKILLABLE,
        cargoCapacity: 1e6,
      }),
      1,
      { autoBank: true },
    );
    expect(aimDrill(state, START_COL, 1)).toBe(true);
    step(state, PER_CELL_SEC + 0.01);
    const banked = state.banked;
    expect(banked).toBeGreaterThan(0);

    // The first arrival takes the dome down: an emergency ascent right now.
    step(state, 1 + balance.waves.enemy_travel_sec);
    expect(state.phase).toBe('finished');
    expect(state.endReason).toBe('breach');
    expect(state.cargo).toBe(0);
    // Everything dug up to the breach is already handed over (PLAN_V1 §2.1).
    expect(state.banked).toBeGreaterThanOrEqual(banked);
    expect(state.banked).toBe(state.mined);

    const report = shiftReport(state);
    expect(report.mined - report.banked).toBe(0);
  });

  it('digs from a checkpoint with the conveyor on and still never ascends', () => {
    const dropRow = balance.shift.checkpoint_every_rows;
    const state = createShift(balanceWith({ firstWaveSec: QUIET_WAVES }), 1, {
      startRow: dropRow,
      autoBank: true,
    });
    expect(state.startRow).toBe(dropRow);
    expect(state.autoBank).toBe(true);

    digCell(state, START_COL, dropRow + 1);
    expect(state.banked).toBe(layerYield(0));
    expect(state.cargo).toBe(0);
    expect(callElevator(state)).toBe(false);
    expect(state.drill.row).toBe(dropRow + 1);
  });
});
