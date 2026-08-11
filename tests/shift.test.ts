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

/** Balance variant. Tests bend single numbers, they never invent new ones. */
function balanceWith(patch: {
  cargoCapacity?: number;
  durationSec?: number;
  bankSec?: number;
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

/** Digs one cell to the end, one order at a time, and returns the time spent. */
function digCell(state: ShiftState, col: number, row: number): number {
  expect(aimDrill(state, col, row)).toBe(true);
  let spent = 0;
  const limit = 1000;
  for (let guard = 0; guard < limit; guard += 1) {
    if (isDug(state, col, row) || state.phase !== 'running') {
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
    // (START_COL + 1, 2) touches the dug (START_COL, 1) only by a corner.
    expect(canDig(state, START_COL + 1, 2)).toBe(false);
    expect(aimDrill(state, START_COL + 1, 2)).toBe(false);
    expect(state.drill.target).toBeNull();
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
  it('spends one row of road before the drill starts digging', () => {
    const state = createShift(balance, 1);
    expect(aimDrill(state, START_COL, 1)).toBe(true);

    step(state, travelSec(1) - 0.001);
    expect(state.drill.mode).toBe('moving');
    expect(state.drill.row).toBeLessThan(1);
    expect(digProgress(state)).toBe(0);

    step(state, 0.002);
    expect(state.drill.mode).toBe('digging');
    expect(state.drill.row).toBeCloseTo(1, 10);
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

describe('dig time by layer', () => {
  it('takes the hardness of the first layer on row 1', () => {
    const state = createShift(balance, 1);
    expect(aimDrill(state, START_COL, 1)).toBe(true);
    step(state, travelSec(1));
    expect(state.drill.mode).toBe('digging');

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
    step(state, travelSec(1) + digSec(0) / 2);
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

    // Third cell does not fit: the drill drives there and stands still.
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
  it('counts down and never goes below zero', () => {
    const state = createShift(balance, 1);
    step(state, 10);
    expect(state.timeLeftSec).toBeCloseTo(balance.shift.duration_sec - 10, 6);
    step(state, balance.shift.duration_sec);
    expect(state.timeLeftSec).toBe(0);
  });

  it('ascends automatically when the time is out and banks everything', () => {
    const state = createShift(balance, 1);
    digDownTo(state, START_COL, 3);
    const carried = state.cargo;
    expect(carried).toBeGreaterThan(0);

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
    const state = createShift(balance, 1);
    digDownTo(state, START_COL, 3);
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
    const state = createShift(balance, 1);
    step(state, balance.shift.duration_sec + balance.shift.elevator_bank_sec + 1);
    expect(state.phase).toBe('finished');
    expect(aimDrill(state, START_COL, 1)).toBe(false);
    expect(callElevator(state)).toBe(false);

    const before = { ...state.drill };
    step(state, 60);
    expect(state.drill).toEqual(before);
    expect(state.timeLeftSec).toBe(0);
  });

  it('reports what the shift produced', () => {
    const state = createShift(balance, 1);
    digDownTo(state, START_COL, 4);
    step(state, balance.shift.duration_sec + travelSec(4) + balance.shift.elevator_bank_sec + 0.01);

    const report = shiftReport(state);
    expect(report.deepestRow).toBe(4);
    expect(report.mined).toBe(layerYield(0) * 4);
    expect(report.banked).toBe(report.mined);
    expect(report.crystals).toBe(state.crystals);
  });
});

describe('crystals', () => {
  const deepBalance = balanceWith({ cargoCapacity: 1e6, durationSec: 1e6 });

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
    const state = createShift(deepBalance, 99);
    digDownTo(state, START_COL, 12);
    const crystals = state.crystals;
    const cargo = state.cargo;
    expect(cargo).toBe(layerYield(0) * 9 + layerYield(1) * 3);

    step(state, deepBalance.shift.duration_sec + 100);
    expect(state.phase).toBe('finished');
    expect(state.crystals).toBe(crystals);
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
