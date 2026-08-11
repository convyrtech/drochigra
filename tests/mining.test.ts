import { describe, expect, it } from 'vitest';
import balanceJson from '../content/balance.json' with { type: 'json' };
import type { Balance } from '../src/sim/balance.js';
import { baseDigTimeSec, digTimeSec, layerForRow } from '../src/sim/mining.js';

const balance = balanceJson as unknown as Balance;
const layers = balance.layers;

describe('layerForRow', () => {
  it('picks the first layer for the top row', () => {
    expect(layerForRow(layers, 0).id).toBe('L1');
  });

  it('keeps row 9 in the first layer and moves row 10 to the second', () => {
    expect(layerForRow(layers, 9).id).toBe('L1');
    expect(layerForRow(layers, 10).id).toBe('L2');
  });

  it('keeps row 19 in the second layer and moves row 20 to the third', () => {
    expect(layerForRow(layers, 19).id).toBe('L2');
    expect(layerForRow(layers, 20).id).toBe('L3');
  });

  it('puts the bottom row in the last layer', () => {
    expect(layerForRow(layers, balance.shift.grid_depth).id).toBe('L3');
  });

  it('covers every row of the shaft without gaps', () => {
    for (let row = 0; row <= balance.shift.grid_depth; row += 1) {
      expect(() => layerForRow(layers, row)).not.toThrow();
    }
  });

  it('rejects rows outside the shaft', () => {
    expect(() => layerForRow(layers, -1)).toThrow(RangeError);
    expect(() => layerForRow(layers, balance.shift.grid_depth + 1)).toThrow(RangeError);
  });

  it('rejects non-integer rows', () => {
    expect(() => layerForRow(layers, 1.5)).toThrow(RangeError);
  });
});

describe('digTimeSec', () => {
  it('is layer hardness divided by drill speed', () => {
    expect(digTimeSec(layers, 0, 1)).toBeCloseTo(0.6, 10);
    expect(digTimeSec(layers, 10, 1)).toBeCloseTo(1.2, 10);
    expect(digTimeSec(layers, 20, 1)).toBeCloseTo(2, 10);
  });

  it('scales with drill speed', () => {
    const slow = digTimeSec(layers, 20, 1);
    const fast = digTimeSec(layers, 20, 2);
    expect(fast).toBeCloseTo(slow / 2, 10);
  });

  it('changes exactly at the layer boundaries', () => {
    expect(digTimeSec(layers, 9, 1)).toBeCloseTo(digTimeSec(layers, 0, 1), 10);
    expect(digTimeSec(layers, 10, 1)).toBeGreaterThan(digTimeSec(layers, 9, 1));
    expect(digTimeSec(layers, 19, 1)).toBeCloseTo(digTimeSec(layers, 10, 1), 10);
    expect(digTimeSec(layers, 20, 1)).toBeGreaterThan(digTimeSec(layers, 19, 1));
  });

  it('gets slower with every deeper layer', () => {
    expect(digTimeSec(layers, 0, 1)).toBeLessThan(digTimeSec(layers, 10, 1));
    expect(digTimeSec(layers, 10, 1)).toBeLessThan(digTimeSec(layers, 20, 1));
  });

  it('rejects a non-positive drill speed', () => {
    expect(() => digTimeSec(layers, 0, 0)).toThrow(RangeError);
    expect(() => digTimeSec(layers, 0, -1)).toThrow(RangeError);
  });

  it('uses the base drill speed from balance by default', () => {
    expect(baseDigTimeSec(balance, 0)).toBeCloseTo(
      digTimeSec(layers, 0, balance.drill.speed_base),
      10,
    );
  });
});
