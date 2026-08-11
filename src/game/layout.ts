/**
 * Screen layout only: proportions, fonts and colours from PLAN_V1 §3.
 * These are view numbers, not game numbers — every gameplay value stays in
 * content/balance.json.
 */
export const VIEW = {
  /** Design resolution, portrait. Phaser scales it to any screen. */
  width: 720,
  height: 1280,
  /** Top share of the screen taken by the dome zone; the rest is the shaft. */
  domeHeightShare: 0.3,

  /** Gap between cells, in pixels. */
  cellGap: 3,
  /** Where the surface label sits inside the entrance row, as a share of a cell. */
  surfaceLabelYShare: 0.28,
  /** Drill size as a share of a cell. */
  drillSizeShare: 0.62,
  /** Height of the dig progress bar as a share of a cell. */
  digBarHeightShare: 0.16,

  hud: {
    margin: 28,
    timerY: 52,
    statsTop: 128,
    statsLine: 46,
    cargoTop: 268,
    cargoBarWidth: 430,
    cargoBarHeight: 26,
    statusY: 344,
    bankButtonWidth: 190,
    bankButtonHeight: 136,
    bankButtonTop: 112,
  },

  report: {
    panelWidth: 600,
    panelHeight: 660,
    titleTop: 60,
    linesTop: 190,
    lineHeight: 66,
    buttonWidth: 360,
    buttonHeight: 104,
    buttonBottom: 60,
  },

  font: {
    huge: '58px',
    large: '44px',
    medium: '32px',
    small: '26px',
  },
} as const;

export const FONT_FAMILY = 'system-ui, sans-serif';

export const COLORS = {
  dome: 0x16283f,
  domeEdge: 0x4d7ba8,
  shaft: 0x0a0f18,
  text: 0xe6ecff,
  textDim: 0x8fa3c8,
  /** Rock colour per layer, in the order of balance.layers. */
  rockByLayer: [0x2a4058, 0x354168, 0x473a6b],
  dug: 0x080c14,
  dugEdge: 0x141d2c,
  surface: 0x3c5f86,
  drill: 0xffc94d,
  drillStuck: 0xff6b6b,
  target: 0x7fd4ff,
  progress: 0x7fd4ff,
  scrap: 0xffd98a,
  crystal: 0x8ef0ff,
  warning: 0xff6b6b,
  button: 0x27577f,
  buttonEdge: 0x7fd4ff,
  panel: 0x0d1524,
} as const;

/** Phaser text styles need a CSS colour, the shapes need the number. */
export function cssColor(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}
