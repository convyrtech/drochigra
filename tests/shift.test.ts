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

/**
 * Digs one cell to the end and returns the time spent. Waits until the drill
 * has driven into the fresh cell, which is where the next order starts from.
 */
function digCell(state: ShiftState, col: number, row: number): number {
  expect(aimDrill(state, col, row)).toBe(true);
  let spent = 0;
  const limit = 2000;
  for (let guard = 0; guard < limit; guard += 1) {
    if (state.phase !== 'running') {
      return spent;
    }
    if (isDug(state, col, row) && state.drill.col === col && state.drill.row === row) {
      return spent;
    }
    step(state, 0.05);
    spent += 0.05;
  }
  throw new Error(`cell ${col},${row} was not dug in ${limit} steps`);
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
    const state = createShift(balanceWith({ cargoCapacity: 1e6 }), 1);
    expect(aimDrill(state, START_COL, 1)).toBe(true);

    step(state, 60);
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

    step(state, 20);
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
    step(state, 20);
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

  it('changes hardness exactly at the 9/10 boundary', () => {
    const state = createShift(balanceWith({ cargoCapacity: 1e6 }), 1);
    digDownTo(state, START_COL, 8);

    const row9 = digCell(state, START_COL, 9);
    const row10 = digCell(state, START_COL, 10);
    const road = travelSec(1);

    expect(row9).toBeGreaterThanOrEqual(digSec(0) + road);
    expect(row9).toBeLessThan(digSec(1) + road);
    expect(row10).toBeGreaterThanOrEqual(digSec(1) + road);
    expect(row10).toBeLessThan(digSec(2) + road);
  });

  it('changes hardness exactly at the 19/20 boundary', () => {
    const state = createShift(balanceWith({ cargoCapacity: 1e6, durationSec: 1e6 }), 1);
    digDownTo(state, START_COL, 18);

    const row19 = digCell(state, START_COL, 19);
    const row20 = digCell(state, START_COL, 20);
    const road = travelSec(1);

    expect(row19).toBeGreaterThanOrEqual(digSec(1) + road);
    expect(row19).toBeLessThan(digSec(2) + road);
    expect(row20).toBeGreaterThanOrEqual(digSec(2) + road);
  });

  it('drops the scrap of the layer it dug', () => {
    const state = createShift(balanceWith({ cargoCapacity: 1e6, durationSec: 1e6 }), 1);
    digCell(state, START_COL, 1);
    expect(state.cargo).toBe(layerYield(0));

    digDownTo(state, START_COL, 10);
    expect(state.cargo).toBe(layerYield(0) * 9 + layerYield(1));
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
    const load = layerYield(0) * 9 + layerYield(1) * 3;
    const state = createShift(
      balanceWith({ cargoCapacity: load, durationSec: 1e6, firstWaveSec: QUIET_WAVES }),
      99,
    );
    digDownTo(state, START_COL, 12);
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

    for (let guard = 0; guard < 400; guard += 1) {
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
        firstWaveSec: 1,
        enemyHpBase: UNKILLABLE,
        cargoCapacity: 1e6,
      }),
      1,
      { autoBank: true },
    );
    expect(aimDrill(state, START_COL, 1)).toBe(true);
    step(state, 10);
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
