import type { Balance, LayerBalance } from './balance.js';

/**
 * Pure mining math. No graphics, no Math.random: same input, same output.
 * All numbers come from content/balance.json through the passed balance.
 */

/** Index in `layers` of the layer a row belongs to, using inclusive `rows` ranges. */
export function layerIndexForRow(layers: readonly LayerBalance[], row: number): number {
  if (!Number.isInteger(row)) {
    throw new RangeError(`row must be an integer, got ${row}`);
  }
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    if (!layer) {
      continue;
    }
    const [from, to] = layer.rows;
    if (row >= from && row <= to) {
      return index;
    }
  }
  throw new RangeError(`row ${row} is outside every layer in balance.layers`);
}

/** Layer a row belongs to, using the inclusive `rows` ranges from balance. */
export function layerForRow(layers: readonly LayerBalance[], row: number): LayerBalance {
  const layer = layers[layerIndexForRow(layers, row)];
  if (!layer) {
    throw new RangeError(`row ${row} is outside every layer in balance.layers`);
  }
  return layer;
}

/**
 * Seconds to dig one cell: layer hardness divided by drill speed.
 * `drillSpeed` is the current speed (balance.drill.speed_base plus upgrades).
 */
export function digTimeSec(layers: readonly LayerBalance[], row: number, drillSpeed: number): number {
  if (!(drillSpeed > 0)) {
    throw new RangeError(`drillSpeed must be positive, got ${drillSpeed}`);
  }
  return layerForRow(layers, row).hardness_sec / drillSpeed;
}

/** Dig time at the base drill speed from balance. */
export function baseDigTimeSec(balance: Balance, row: number): number {
  return digTimeSec(balance.layers, row, balance.drill.speed_base);
}

/** Scrap one dug cell of this row drops. */
export function cellYield(layers: readonly LayerBalance[], row: number): number {
  return layerForRow(layers, row).yield;
}

/** Chance in [0, 1] that a dug cell of this row drops one crystal. */
export function crystalChance(layers: readonly LayerBalance[], row: number): number {
  return layerForRow(layers, row).crystal_chance;
}

/**
 * Seconds the drill spends travelling `cells` cells. The road is the main price
 * of depth (PLAN_V1 §4), so it is timed like everything else.
 */
export function travelTimeSec(cells: number, moveRowsPerSec: number): number {
  if (!(moveRowsPerSec > 0)) {
    throw new RangeError(`moveRowsPerSec must be positive, got ${moveRowsPerSec}`);
  }
  if (!(cells >= 0)) {
    throw new RangeError(`cells must be non-negative, got ${cells}`);
  }
  return cells / moveRowsPerSec;
}
