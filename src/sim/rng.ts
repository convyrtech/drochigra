/**
 * Seeded randomness for src/sim. Math.random is forbidden here (AGENTS.md):
 * the same seed must always produce the same shift.
 *
 * mulberry32 — one 32-bit word of state, one round per draw. The state is a
 * single number, so it travels inside the shift state and stays serialisable.
 */

/** One draw: the value in [0, 1) and the state to keep for the next draw. */
export interface RandomDraw {
  readonly value: number;
  readonly state: number;
}

/** Turns any finite number into a valid 32-bit generator state. */
export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    throw new RangeError(`seed must be a finite number, got ${seed}`);
  }
  return Math.trunc(seed) >>> 0;
}

/** Pure step of mulberry32: state in, value plus next state out. */
export function nextRandom(state: number): RandomDraw {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  return { value, state: next };
}
