/**
 * Screen layout only: proportions, fonts and colours from PLAN_V1 §3.
 * These are view numbers, not game numbers — every gameplay value stays in
 * content/balance.json.
 */
export const VIEW = {
  /** Design resolution, portrait. Phaser scales it to any screen. */
  width: 720,
  height: 1280,
  /**
   * Top share of the screen taken by the dome zone; the rest is the shaft.
   * PLAN_V1 §3 asks for about a third: the zone has to hold the timer, the
   * enemy corridor, the dome, two bars and two buttons.
   */
  domeHeightShare: 0.32,

  /** Gap between cells, in pixels. */
  cellGap: 3,
  /** Where the surface label sits inside the entrance row, as a share of a cell. */
  surfaceLabelYShare: 0.28,
  /** Drill size as a share of a cell. */
  drillSizeShare: 0.62,
  /** Height of the dig progress bar as a share of a cell. */
  digBarHeightShare: 0.16,

  /** Rows of the dome zone, top to bottom. All values are pixels from its top. */
  hud: {
    margin: 24,
    /** Banked scrap and crystals on the left, depth on the right. */
    statsY: 6,
    /** The shift timer, centred. Wave labels sit beside it, so it is not huge. */
    timerY: 40,
    /** Wave number on the left, countdown to the next wave on the right. */
    sideY: 54,
    /** Dome health and cargo share one row: the zone has no space to stack them. */
    barTop: 268,
    barHeight: 32,
    barGap: 24,
    statusY: 306,
    buttonTop: 346,
    buttonHeight: 56,
    buttonGap: 24,
  },

  /** The dome shell, the corridor the enemies walk down and the alarm frame. */
  dome: {
    corridorTop: 100,
    corridorBottom: 204,
    /** Rows enemies of one wave are spread over, so they do not stack up. */
    lanes: 3,
    /** Each further row of a side starts this much of the way further back. */
    rankShift: 0.1,
    /** Turret muzzle: the top of the shell and the point every beam starts at. */
    apexY: 210,
    /** Where the shell meets the ground on both sides. */
    baseY: 264,
    halfWidth: 210,
    /** Segments the shell arc is drawn with. */
    arcSteps: 24,
    turretWidth: 18,
    turretHeight: 14,
    /** Enemy walk: from this far off the edge to this far from the centre. */
    edgeMargin: 26,
    centerGap: 18,
    enemyBarWidth: 26,
    enemyBarHeight: 4,
    enemyBarOffset: 16,
    targetRingRadius: 20,
    /** Taps this close to an enemy count as an order for the turret. */
    pickRadius: 40,
    beamWidth: 3,
    frameWidth: 10,
    /** One full pulse of the alarm frame, in seconds. */
    framePulseSec: 1.1,
  },

  /**
   * The end-of-shift report, laid out as the paper form the station would file:
   * a header band with the form code, the plan percent as the headline, then one
   * ruled line per figure — label on the left, number on the right.
   */
  report: {
    panelWidth: 600,
    panelHeight: 980,
    pad: 28,
    headerHeight: 104,
    titleTop: 18,
    formCodeTop: 62,
    /** «ПЛАН ВЫПОЛНЕН НА N%» — the line the whole form is about. */
    percentTop: 124,
    stampTop: 178,
    rowsTop: 224,
    rowHeight: 50,
    /** The ruled line under every row of the form. */
    ruleHeight: 1,
    /** Signature line above the button, measured from the panel bottom. */
    signatureBottom: 196,
    buttonWidth: 360,
    buttonHeight: 104,
    buttonBottom: 60,
  },

  /**
   * The base screen between shifts. One row per upgrade branch, one chip per
   * elevator checkpoint, no scrolling and no gestures (PLAN_V1 §3), so the rows
   * are compact: two lines of text on the left, the price button on the right.
   */
  base: {
    margin: 24,
    /** Header band holding the title, the wallet and the plan. */
    headerHeight: 160,
    titleY: 20,
    walletY: 80,
    planY: 126,
    /** Top of the upgrade list. Everything below it is measured from the rows. */
    listTop: 168,
    rowHeight: 86,
    rowGap: 6,
    rowPad: 18,
    /** Text baselines inside a row, from its top. */
    rowNameY: 12,
    rowEffectY: 48,
    buyWidth: 210,
    buyHeight: 62,
    /** Gap between the upgrade list and the depth picker. */
    sectionGap: 12,
    sectionTitleHeight: 38,
    chipHeight: 74,
    chipGap: 6,
    /** The start button is pinned to the bottom of the screen. */
    startHeight: 116,
    startBottom: 84,
    /**
     * The hangar bar, the last strip of the screen: it sits under the start
     * button in the space left below it, so no existing row moves.
     */
    hangarHeight: 44,
    hangarBottom: 26,
  },

  /**
   * The hangar collection screen shown on coming back. One big number, two lines
   * of explanation and one wide button, so the whole thing reads at a glance.
   */
  hangar: {
    panelWidth: 600,
    panelHeight: 660,
    titleTop: 44,
    stampTop: 96,
    /** The pile itself: the number the player came back for. */
    amountTop: 176,
    /** Below the unit under the number, so «ЛОМ» is not stepped on. */
    linesTop: 330,
    lineHeight: 40,
    buttonWidth: 420,
    buttonHeight: 112,
    buttonBottom: 52,
    /** The number breathes while it waits to be taken. */
    idlePulseMs: 900,
    idlePulseScale: 1.06,
    /** Taking it: the number flies up and fades while the panel shakes. */
    collectRiseMs: 460,
    collectRise: 130,
    shakeMs: 70,
    shakeOffset: 9,
    /** Left on screen after the flight, so the last frame is seen. */
    collectHoldMs: 120,
  },

  /**
   * The banner that announces a new layer during a shift. It sits just under the
   * dome zone, over the shaft, so it never covers the timer or the buttons, and
   * it leaves on its own: crossing a border is an event, not a screen.
   */
  layerBanner: {
    panelWidth: 560,
    panelHeight: 104,
    /** Gap between the bottom of the dome zone and the top of the banner. */
    topGap: 26,
    titleTop: 16,
    detailTop: 62,
    panelAlpha: 0.94,
    /** It floats up into place, holds long enough to be read, then fades out. */
    rise: 42,
    riseMs: 300,
    holdMs: 1600,
    fadeMs: 420,
  },

  /**
   * The victory screen: the bottom of the Abyss on row 30 and the next five-year
   * plan. Same station paper as the report, one line per promise, one wide button.
   */
  victory: {
    panelWidth: 620,
    panelHeight: 900,
    pad: 30,
    titleTop: 40,
    stampTop: 104,
    /** The row the whole thing is about, in the biggest type the panel takes. */
    depthTop: 168,
    depthUnitTop: 250,
    /** Figures of the closed plan, one ruled row each. */
    rowsTop: 322,
    rowHeight: 48,
    ruleHeight: 1,
    /** What the next plan changes, as a list under the figures. */
    promisesTop: 542,
    promiseHeight: 40,
    buttonWidth: 480,
    buttonHeight: 116,
    buttonBottom: 48,
    /** The row number breathes while the screen waits to be closed. */
    idlePulseMs: 1000,
    idlePulseScale: 1.05,
    /** Opening: the paper drops in and the number lands after it. */
    enterMs: 320,
    enterRise: 60,
    /** Closing: the panel flashes once and the new plan begins. */
    startFadeMs: 360,
  },

  font: {
    huge: '58px',
    large: '44px',
    medium: '32px',
    small: '26px',
    tiny: '22px',
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
  buttonOff: 0x121d2e,
  panel: 0x0d1524,
} as const;

/** Shapes an enemy can be drawn as. Only the view cares. */
export type EnemyShape = 'circle' | 'square' | 'triangle';

export interface EnemyStyle {
  readonly shape: EnemyShape;
  /** Half the size of the figure, in pixels. */
  readonly size: number;
  readonly color: number;
}

/**
 * How each enemy of content/balance.json looks. Keys are the enemy keys of the
 * balance; a type without a style here still gets drawn, just plainly.
 */
export const ENEMY_STYLE: Record<string, EnemyStyle> = {
  aberration: { shape: 'circle', size: 11, color: 0xff9a6b },
  drowned: { shape: 'square', size: 13, color: 0x7fb0ff },
  moth: { shape: 'triangle', size: 10, color: 0xd9a6ff },
};

export const ENEMY_STYLE_FALLBACK: EnemyStyle = { shape: 'circle', size: 11, color: 0xe6ecff };

/** Phaser text styles need a CSS colour, the shapes need the number. */
export function cssColor(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}
