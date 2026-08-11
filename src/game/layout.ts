/**
 * Screen layout only: proportions and colours from PLAN_V1 §3.
 * These are view numbers, not game numbers — every gameplay value stays in
 * content/balance.json.
 */
export const VIEW = {
  /** Design resolution, portrait. Phaser scales it to any screen. */
  width: 720,
  height: 1280,
  /** Top share of the screen taken by the dome zone; the rest is the shaft. */
  domeHeightShare: 0.3,
} as const;

export const COLORS = {
  dome: 0x16283f,
  shaft: 0x0a0f18,
  text: 0xe6ecff,
  textDim: 0x8fa3c8,
} as const;
