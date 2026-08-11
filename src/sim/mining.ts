import type { Balance, LayerBalance } from './balance.js';

/**
 * Pure mining math. No graphics, no Math.random: same input, same output.
 * All numbers come from content/balance.json through the passed balance.
 */

/** Layer a row belongs to, using the inclusive `rows` ranges from balance. */
export function layerForRow(layers: readonly LayerBalance[], row: number): LayerBalance {
  if (!Number.isInteger(row)) {
    throw new RangeError(`row must be an integer, got ${row}`);
  }
  for (const layer of layers) {
    const [from, to] = layer.rows;
    if (row >= from && row <= to) {
      return layer;
    }
  }
  throw new RangeError(`row ${row} is outside every layer in balance.layers`);
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
