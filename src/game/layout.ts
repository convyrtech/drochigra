/**
 * Screen layout only: proportions, fonts and colours from PLAN_V1 §3.
 * These are view numbers, not game numbers — every gameplay value stays in
 * content/balance.json.
 */

/** Design resolution, portrait. Phaser scales it to any screen (Scale.FIT). */
const DESIGN_WIDTH = 720;
const DESIGN_HEIGHT = 1280;

/**
 * Issue #8, the minimum touch target — the one number every tappable thing is
 * measured against.
 *
 * Apple (44) and Google (48) both give it in **screen** pixels, and the game is
 * not drawn in those: `createGame.ts` runs Scale.FIT over a 720×1280 design
 * canvas, so on a phone 393 CSS pixels wide every design pixel is only about
 * 393/720 ≈ 0.55 of a CSS one. A zone «48 pixels» wide in design space would
 * land on the glass at ~26 — half the norm. So the minimum is written down in
 * CSS pixels and converted here, once.
 */
export const MIN_TOUCH_CSS = 48;

/**
 * The screen the conversion is done for, in CSS pixels of width. FIT scale is
 * min(cssWidth/720, cssHeight/1280) and phones are narrower than 9:16, so width
 * is what decides it; the narrower the screen, the more design pixels one CSS
 * pixel costs. 393 is the width of the phone the game is laid out and
 * screenshotted on (Motorola Edge 60s class).
 *
 * Honest caveat, so nobody reads more into the number than it holds: on a
 * 360-CSS-pixel phone (Infinix X6833B class) the scale is 0.5 and the same zone
 * measures 44 CSS pixels, not 48. Lifting it there means 96 design pixels, and
 * eight upgrade rows plus seven checkpoint chips no longer fit one portrait
 * screen — that is a base-screen redesign, not a constant.
 */
export const TOUCH_REFERENCE_SCREEN_CSS = 393;

/**
 * The minimum touch target in design pixels: 88. Everything tappable is at
 * least this wide and this tall — the buttons themselves where the screen has
 * room for it, and the zone the finger is tested against where it does not
 * (`src/ui/tapTarget.ts` grows the hit area around a smaller drawn button).
 * If you add a new tappable thing, run it past this number.
 */
export const MIN_TOUCH = Math.ceil((MIN_TOUCH_CSS * DESIGN_WIDTH) / TOUCH_REFERENCE_SCREEN_CSS);

export const VIEW = {
  /** Design resolution, portrait. Phaser scales it to any screen. */
  width: DESIGN_WIDTH,
  height: DESIGN_HEIGHT,
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
  /** Drill size as a share of a cell, as the plain rectangle. */
  drillSizeShare: 0.62,
  /**
   * Drill size as a share of a cell once there is a sprite to draw. A
   * machine needs more room than a marker: the rectangle only had to be
   * seen, the drill has to be recognised.
   */
  drillArtSizeShare: 0.88,
  /** Height of the dig progress bar as a share of a cell. */
  digBarHeightShare: 0.16,
  /**
   * Shaft scrolling (issue #10, PLAN_V1 §3): a finger that travels this far on
   * either axis is a swipe, not a tap. It is a view number, not a game one —
   * it decides how a gesture is read, never what the mine is worth. Keep it
   * well over the browser's own touch slop: at FIT scale on a 393 px screen
   * these 24 design pixels are about 13 CSS pixels, so a thumb that wobbles
   * while pressing still orders the cell instead of silently scrolling.
   */
  dragThreshold: 24,
  /**
   * The «К ЗАБОЮ» button in the bottom-right corner of the shaft zone (issue
   * #10). It shows up only while the face — the deepest cell dug this shift — is
   * off screen, so there is always a tap-sized way back to the work and the
   * player never has to guess that the shaft can be swiped. Its height is the
   * minimum touch target itself: it was the first zone measured in CSS pixels
   * (issue #8) and now it takes the number from the same place as everyone else.
   */
  faceButton: {
    width: 232,
    height: MIN_TOUCH,
    margin: 20,
  },

  /** Rows of the dome zone, top to bottom. All values are pixels from its top. */
  hud: {
    margin: 24,
    /** Banked scrap and crystals on the left, depth on the right. */
    statsY: 6,
    /**
     * The scrap and crystal icons of that line, when they exist. Two pictures
     * and two numbers say what «СДАНО: 115 · КРИСТАЛЛЫ: 1» says, in half the
     * width of a phone screen; with no icons the words come back.
     */
    statIconSize: 28,
    statIconGap: 8,
    /**
     * Two dark bands laid over the sky sprite, so the text keeps its contrast
     * whatever the generator painted up there. Only the top strip (stats,
     * timer, wave) and the bottom strip (bars, status line, buttons) are
     * covered — the middle, where the corridor and the shell are, stays open.
     * With no sky sprite the panel is a flat field already and no band is drawn.
     */
    skyScrimAlpha: 0.62,
    skyScrimTopHeight: 92,
    skyScrimBottomTop: 256,
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
    /**
     * «СДАТЬ» and «ЗАЛП» as they are drawn. The dome zone is full — timer,
     * corridor, shell, two bars and the status line all sit above them — so the
     * drawn button cannot grow to MIN_TOUCH without pushing the shell out of the
     * zone. The zone the finger is tested against does grow (see `hud.ts`): it
     * is MIN_TOUCH tall, pushed up so it stays inside the dome panel and never
     * steals taps from the shaft below it.
     */
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
    /**
     * Taps this close to an enemy count as an order for the turret — a radius,
     * so the zone measures 2 × 48 = 96 design pixels across, comfortably over
     * the MIN_TOUCH of 88 (≈ 52 CSS pixels on the reference screen). It is left
     * where it is: growing it further would start stealing taps between the
     * three lanes of the corridor, which are only ~35 design pixels apart.
     */
    pickRadius: 48,
    beamWidth: 3,
    frameWidth: 10,
    /**
     * The shell sprite, when there is one: as wide as the drawn arc and
     * anchored bottom-centre on `baseY`, so it stands exactly where the arc
     * stood. Without the sprite none of these three are read at all and the arc
     * is drawn as before.
     */
    artHeight: 88,
    /** The turret sprite: square, centred here on the crown of the shell. */
    turretArtSize: 56,
    turretArtY: 182,
    /**
     * Where a beam starts once the turret is a sprite — its muzzle, which is
     * higher than the apex of the bare arc. The arc keeps `apexY`.
     */
    muzzleY: 164,
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
    /**
     * The sound toggle, tucked into the top-right corner of the header where no
     * text reaches: the title is centred, the plan row is lower down.
     *
     * It stays 54 tall on purpose: a MIN_TOUCH-tall plate would run into the
     * wallet line under it. Its hit zone is grown instead (`tapTarget.ts`), and
     * it may spread over the wallet text freely — text is not tappable.
     */
    muteWidth: 160,
    muteHeight: 54,
    muteY: 14,
    /** One upgrade row: as tall as the price button inside it (issue #8). */
    rowHeight: MIN_TOUCH,
    rowGap: 6,
    rowPad: 18,
    /** Text baselines inside a row, from its top. */
    rowNameY: 12,
    rowEffectY: 48,
    buyWidth: 210,
    /** The price button fills the row: it is the tap target of the base. */
    buyHeight: MIN_TOUCH,
    /** Gap between the upgrade list and the depth picker. */
    sectionGap: 12,
    sectionTitleHeight: 38,
    /** One checkpoint chip. Seven of them fit the width at ~91 each. */
    chipHeight: MIN_TOUCH,
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

  /**
   * Chip particles on a dig (issue #8 performance): a small object pool so a
   * busy dig never allocates and destroys rectangles per frame. `poolSize` is
   * the total rectangles created once; `burstCount` is how many fly out of one
   * broken cell. If the whole pool is busy the burst is simply skipped — the
   * pool is a hard cap, so 60 fps never has to pay for new objects.
   */
  particles: {
    poolSize: 28,
    burstCount: 6,
  },

  /**
   * Floating «+scrap» / «+1 crystal» numbers (issue #8 performance). A small
   * pool of pre-created texts is cycled, so digging never adds or destroys text
   * objects and the number of numbers on screen at once is bounded by poolSize.
   */
  floatText: {
    poolSize: 6,
  },
} as const;

/** A hit zone in the local coordinates of the thing it belongs to. */
export interface HitArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A drawn rectangle grown to the minimum touch target, centred on it. Something
 * already big enough keeps exactly its own size, so nothing that meets the
 * guideline starts stealing taps from its neighbours. Used by
 * `src/ui/tapTarget.ts` for every button that carries its own Phaser input.
 */
export function touchHitArea(width: number, height: number, minTouch = MIN_TOUCH): HitArea {
  const grownWidth = Math.max(width, minTouch);
  const grownHeight = Math.max(height, minTouch);
  return {
    x: (width - grownWidth) / 2,
    y: (height - grownHeight) / 2,
    width: grownWidth,
    height: grownHeight,
  };
}

/**
 * The vertical zone «СДАТЬ» and «ЗАЛП» answer in. The drawn plate is only
 * `hud.buttonHeight` tall — the dome zone is full — so the zone is MIN_TOUCH
 * tall and pushed up until it fits inside the panel: a tap below the dome edge
 * belongs to the shaft, and must never spend the salvo.
 */
export function hudButtonHitZone(domeHeight: number): { top: number; height: number } {
  const height = Math.max(VIEW.hud.buttonHeight, MIN_TOUCH);
  const top = Math.min(
    VIEW.hud.buttonTop - (height - VIEW.hud.buttonHeight) / 2,
    domeHeight - height,
  );
  return { top, height };
}

/**
 * How tall the band that hands the cargo over is — the lift row of the shaft.
 * One cell is 80 design pixels, just under the minimum touch target, so the band
 * is grown; the few pixels it borrows are the very top of the first row of rock,
 * which stays tappable across the whole of the rest of its height.
 */
export function elevatorBandHeight(cellSize: number): number {
  return Math.max(cellSize, MIN_TOUCH);
}

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
  /**
   * Side of the sprite, in pixels, when the enemy has one. Bigger than twice
   * `size`: a shape only had to be told apart from two other shapes, a creature
   * has to be looked at. Kept under the ~35 pixels between corridor lanes plus a
   * little, so a wave reads as a crowd and not as a smear.
   */
  readonly spriteSize: number;
}

/**
 * How each enemy of content/balance.json looks. Keys are the enemy keys of the
 * balance; a type without a style here still gets drawn, just plainly.
 */
export const ENEMY_STYLE: Record<string, EnemyStyle> = {
  aberration: { shape: 'circle', size: 11, color: 0xff9a6b, spriteSize: 34 },
  drowned: { shape: 'square', size: 13, color: 0x7fb0ff, spriteSize: 40 },
  moth: { shape: 'triangle', size: 10, color: 0xd9a6ff, spriteSize: 36 },
};

export const ENEMY_STYLE_FALLBACK: EnemyStyle = {
  shape: 'circle',
  size: 11,
  color: 0xe6ecff,
  spriteSize: 34,
};

/**
 * Where the health bar of an enemy sits under it. The bar has to clear whatever
 * is drawn above it, and a sprite is taller than the shape it replaces.
 */
export function enemyBarOffset(style: EnemyStyle, hasSprite: boolean): number {
  return hasSprite ? Math.round(style.spriteSize / 2) + 4 : VIEW.dome.enemyBarOffset;
}

/** Phaser text styles need a CSS colour, the shapes need the number. */
export function cssColor(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}
