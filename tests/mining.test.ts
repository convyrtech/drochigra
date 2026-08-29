import { describe, expect, it } from 'vitest';
import balanceJson from '../content/balance.json' with { type: 'json' };
import type { Balance } from '../src/sim/balance.js';
import { baseDigTimeSec, digTimeSec, layerForRow } from '../src/sim/mining.js';

const balance = balanceJson as unknown as Balance;
const layers = balance.layers;

/**
 * The layers as data, so these tests check the rule and not a copy of the
 * numbers: where the boundary is and which layer is harder is balance.json's
 * business, and a balance edit must not have to be repeated here.
 */
function layerAt(index: number) {
  const layer = layers[index];
  if (!layer) {
    throw new Error(`no layer ${index} in balance.layers`);
  }
  return layer;
}

/** Last row of a layer and the first row of the next one. */
function boundaries(): { readonly index: number; readonly last: number; readonly next: number }[] {
  const list: { index: number; last: number; next: number }[] = [];
  for (let index = 0; index + 1 < layers.length; index += 1) {
    list.push({ index, last: layerAt(index).rows[1], next: layerAt(index + 1).rows[0] });
  }
  return list;
}

describe('layerForRow', () => {
  it('picks the first layer for the top row', () => {
    expect(layerForRow(layers, 0).id).toBe('L1');
  });

  it('keeps the last row of a layer in it and gives the next row to the next layer', () => {
    for (const { index, last, next } of boundaries()) {
      expect(next).toBe(last + 1);
      expect(layerForRow(layers, last).id).toBe(layerAt(index).id);
      expect(layerForRow(layers, next).id).toBe(layerAt(index + 1).id);
    }
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
    for (let index = 0; index < layers.length; index += 1) {
      const layer = layerAt(index);
      expect(digTimeSec(layers, layer.rows[0], 1)).toBeCloseTo(layer.hardness_sec, 10);
    }
  });

  it('scales with drill speed', () => {
    const deepest = layerAt(layers.length - 1).rows[0];
    const slow = digTimeSec(layers, deepest, 1);
    const fast = digTimeSec(layers, deepest, 2);
    expect(fast).toBeCloseTo(slow / 2, 10);
  });

  it('changes exactly at the layer boundaries', () => {
    for (const { index, last, next } of boundaries()) {
      expect(digTimeSec(layers, last, 1)).toBeCloseTo(digTimeSec(layers, layerAt(index).rows[0], 1), 10);
      expect(digTimeSec(layers, next, 1)).toBeGreaterThan(digTimeSec(layers, last, 1));
    }
  });

  it('gets slower with every deeper layer', () => {
    for (const { last, next } of boundaries()) {
      expect(digTimeSec(layers, last, 1)).toBeLessThan(digTimeSec(layers, next, 1));
    }
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
