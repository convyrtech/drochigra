import { ART } from '../game/artIds.js';
import {
  COLORS,
  PAPER_INK,
  SCREEN_INK,
  VIEW,
  type FormInk,
} from '../game/layout.js';
import { textWidth } from '../game/textMetrics.js';
import type { Balance } from '../sim/balance.js';
import type { HangarHarvest, Profile, ShiftOutcome } from '../sim/progress.js';
import {
  resourceIds,
  resourceName,
  scrapId,
  upgradeIds,
  upgradeLevel,
  walletAmount,
} from '../sim/progress.js';
import type { ShiftReport } from '../sim/shift.js';

/**
 * Where every word of the three form screens goes, worked out without a Phaser
 * scene anywhere in sight.
 *
 * The report, the closed five-year plan and the hangar receipt are three pages
 * of one file: the same blank at the same size, the same printed masthead with
 * the same badge, the same ruled rows, the same rubber stamp. This module builds
 * that page as plain data — a list of lines, rules, pictures and one button —
 * and `src/ui/formPage.ts` is the only thing that turns it into Phaser objects.
 *
 * The split is not tidiness. Three lines had walked off the paper by the time
 * anyone looked at these screens with a ruler, and nothing could have caught it:
 * the positions lived inside `scene.add.text(...)` calls that a unit test cannot
 * run. Now every line carries the box it must stay inside, `textMetrics.ts` says
 * how wide it will be, and `tests/textFit.test.ts` holds the two against each
 * other for every state the screens have — a two-digit five-year plan, a
 * six-figure record, a thousand-percent plan, a breached dome.
 *
 * `hasArt` is handed in rather than asked of a scene for the same reason: the
 * pages differ between «the sprites are there» and «they are not» — the ink
 * flips from light-on-dark to dark-on-paper, the badge appears and the masthead
 * moves — so both states are built, and both are measured.
 */

/** Which end of the line `x` refers to. Phaser's origin, spelt out. */
export type OriginX = 0 | 0.5 | 1;

/** One line of type on the page. */
export interface FormText {
  /** Stable name, so a screen can find the one part it animates. */
  readonly id: string;
  readonly text: string;
  /** A `VIEW.font` size, as the CSS string Phaser is handed. */
  readonly fontSize: string;
  readonly color: number;
  readonly x: number;
  readonly y: number;
  readonly originX: OriginX;
  readonly originY: 0 | 0.5;
  /**
   * The span of screen this line may occupy, `[left, right]`. Everything the
   * page promises about not running off the paper is written here.
   */
  readonly box: readonly [number, number];
  /** A dark outline, for a figure written over a picture. */
  readonly stroke?: { readonly color: number; readonly width: number };
}

/** A ruled line, a header band, a crease: anything that is a flat rectangle. */
export interface FormRule {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: number;
  readonly alpha?: number;
}

/** One sprite on the page, when the sprite exists at all. */
export interface FormArt {
  readonly id: string;
  /** Top-left corner, or the centre when `centred`. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly centred: boolean;
  readonly rotation?: number;
  readonly alpha?: number;
}

export interface FormButton {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: FormText;
}

/** A whole page, in the order it is drawn. */
export interface FormPage {
  readonly panel: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Dark scrim over whatever the page covers. */
  readonly shadeAlpha: number;
  /** The blank, when there is one; otherwise the page is a dark panel. */
  readonly sheet: FormArt | null;
  readonly panelEdgeColor: number;
  /** The printed ruling of the blank: grid, creases. Drawn under everything. */
  readonly sheetRules: readonly FormRule[];
  /** The masthead band and its edge. */
  readonly headerRules: readonly FormRule[];
  /** Pictures over the sheet: the badge, the heap, the stamp. */
  readonly art: readonly FormArt[];
  readonly rules: readonly FormRule[];
  readonly texts: readonly FormText[];
  readonly button: FormButton;
}

/** What a page needs to know about the world outside it. */
export interface PageContext {
  readonly width: number;
  readonly height: number;
  /** Is this sprite loaded? The pages look different either way, on purpose. */
  readonly hasArt: (id: string) => boolean;
}

// ---------------------------------------------------------------------------
// Shared pieces: the blank, the masthead, the ruled rows, the signature
// ---------------------------------------------------------------------------

/** A box measured in from both sides of the panel. */
function innerBox(panelX: number, panelWidth: number, pad: number): readonly [number, number] {
  return [panelX + pad, panelX + panelWidth - pad] as const;
}

/**
 * The largest of these sizes the line fits in, or the smallest when none of them
 * do. Only used where the text carries a figure nobody can bound — a price, a
 * plan percent — so that a five-digit number shrinks its own line instead of
 * walking off the page.
 */
export function fitFontSize(text: string, sizes: readonly string[], maxWidth: number): string {
  for (const size of sizes) {
    if (textWidth(text, size) <= maxWidth) {
      return size;
    }
  }
  return sizes[sizes.length - 1] ?? VIEW.font.tiny;
}

/**
 * The printed ruling of the blank: a faint grid over the whole sheet and two
 * fold creases across it.
 *
 * Drawn rather than generated. Four generations went on asking PixelLab for a
 * sheet of graph paper at 168 × 244 and all four came back one flat colour —
 * the forced palette and the pixel-art style will paint a material, not a
 * regular pattern. So the sheet supplies the paper and the form supplies its own
 * ruling, which is the right way round anyway: the grid lines up with the rows
 * because both are laid out by the same numbers.
 */
function sheetRuling(
  panelX: number,
  panelY: number,
  width: number,
  height: number,
  headerHeight: number,
  ink: FormInk,
): FormRule[] {
  const rules: FormRule[] = [];
  const step = 48;
  const top = panelY + headerHeight;
  for (let x = panelX + step; x < panelX + width; x += step) {
    rules.push({ x, y: top, width: 1, height: panelY + height - top, color: ink.rule, alpha: 0.45 });
  }
  for (let y = top + step; y < panelY + height; y += step) {
    rules.push({ x: panelX, y, width, height: 1, color: ink.rule, alpha: 0.45 });
  }
  // The two creases a sheet that lived in a folder has.
  rules.push({
    x: panelX,
    y: panelY + Math.round(height / 2),
    width,
    height: 2,
    color: ink.rule,
    alpha: 0.85,
  });
  rules.push({
    x: panelX + Math.round(width / 2),
    y: top,
    width: 2,
    height: panelY + height - top,
    color: ink.rule,
    alpha: 0.55,
  });
  return rules;
}

interface MastheadInput {
  readonly panelX: number;
  readonly panelY: number;
  readonly panelWidth: number;
  readonly pad: number;
  readonly headerHeight: number;
  readonly emblemSize: number;
  readonly emblemY: number;
  readonly emblemGap: number;
  readonly titleTop: number;
  readonly title: string;
  readonly titleSize: string;
  readonly titleColor: number;
  /** The line under the badge, running the full width of the sheet. */
  readonly codeTop?: number;
  readonly code?: string;
  readonly hasEmblem: boolean;
}

interface MastheadOutput {
  readonly art: FormArt[];
  readonly rules: FormRule[];
  readonly texts: FormText[];
}

/**
 * The printed head of the form: a dark band, the badge at its left edge, the
 * title beside the badge and the form code across the full width underneath.
 *
 * The code goes **under** the badge and not beside it because it does not fit
 * beside it: «ФОРМА В-9 · ПЯТИЛЕТКА 1 · СТАНЦИЯ ВОСТОК-9» is wider than the room
 * a 64-pixel badge and its gap leave on any sheet this game can print, and it
 * was hanging over the right edge of the paper on every report ever filed.
 */
function masthead(input: MastheadInput): MastheadOutput {
  const {
    panelX, panelY, panelWidth, pad, headerHeight,
    emblemSize, emblemY, emblemGap, titleTop, title, titleSize, titleColor,
    codeTop, code, hasEmblem,
  } = input;
  const box = innerBox(panelX, panelWidth, pad);
  const art: FormArt[] = [];
  if (hasEmblem) {
    art.push({
      id: ART.emblem,
      x: panelX + pad,
      y: panelY + emblemY,
      width: emblemSize,
      height: emblemSize,
      centred: false,
    });
  }
  const titleX = box[0] + (hasEmblem ? emblemSize + emblemGap : 0);
  const texts: FormText[] = [
    {
      id: 'title',
      text: title,
      fontSize: titleSize,
      color: titleColor,
      x: titleX,
      y: panelY + titleTop,
      originX: 0,
      originY: 0,
      box: [titleX, box[1]],
    },
  ];
  if (code !== undefined && codeTop !== undefined) {
    texts.push({
      id: 'formCode',
      text: code,
      fontSize: VIEW.font.tiny,
      color: COLORS.textDim,
      x: box[0],
      y: panelY + codeTop,
      originX: 0,
      originY: 0,
      box,
    });
  }
  return {
    art,
    rules: [
      { x: panelX, y: panelY, width: panelWidth, height: headerHeight, color: COLORS.dome },
      { x: panelX, y: panelY + headerHeight, width: panelWidth, height: 3, color: COLORS.domeEdge },
    ],
    texts,
  };
}

/** One ruled row of a form: a caption, a figure, and the figure's colour. */
export type FigureRow = readonly [label: string, value: string, color: number];

interface RowsInput {
  readonly panelX: number;
  readonly panelY: number;
  readonly panelWidth: number;
  readonly pad: number;
  readonly top: number;
  readonly rowHeight: number;
  readonly rowGap: number;
  readonly ruleHeight: number;
  readonly ink: FormInk;
  readonly rows: readonly FigureRow[];
}

/**
 * The body of the form: caption left, figure right, a ruled line under each.
 *
 * The two boxes are cut out of one inner width with `rowGap` between them, and
 * the split is decided by the caption — captions are fixed strings, figures are
 * whatever the shift produced. So a long figure eats into the gap and is caught
 * by the test, instead of quietly printing over the words on its left, which is
 * what «Графа 10 · рекорд смены» and a five-digit record used to do.
 */
function figureRows(input: RowsInput): { texts: FormText[]; rules: FormRule[] } {
  const { panelX, panelY, panelWidth, pad, top, rowHeight, rowGap, ruleHeight, ink, rows } = input;
  const [left, right] = innerBox(panelX, panelWidth, pad);
  const texts: FormText[] = [];
  const rules: FormRule[] = [];
  rows.forEach(([label, value, color], index) => {
    const y = panelY + top + rowHeight * index;
    const split = left + textWidth(label, VIEW.font.small);
    texts.push({
      id: `row${index}-label`,
      text: label,
      fontSize: VIEW.font.small,
      color: ink.dim,
      x: left,
      y,
      originX: 0,
      originY: 0,
      box: [left, right - rowGap],
    });
    texts.push({
      id: `row${index}-value`,
      text: value,
      fontSize: VIEW.font.medium,
      color,
      x: right,
      y,
      originX: 1,
      originY: 0,
      box: [split + rowGap, right],
    });
    rules.push({
      x: left,
      y: y + rowHeight - ruleHeight,
      width: right - left,
      height: ruleHeight,
      color: ink.rule,
    });
  });
  return { texts, rules };
}

interface SignatureInput {
  readonly panelX: number;
  readonly panelY: number;
  readonly panelWidth: number;
  readonly pad: number;
  readonly y: number;
  readonly rowGap: number;
  readonly ink: FormInk;
  readonly left: string;
  readonly right: string;
}

/**
 * The line a form is closed with: who signed it on the left, what happened to it
 * on the right.
 *
 * One line and two columns, because there is exactly one line of room between
 * the last figure and the way out — and because as one long sentence it was 681
 * pixels of text in a 536-pixel sheet, which is a hundred and forty-five pixels
 * of «пробитие купола» printed on the shaft behind the paper.
 */
function signature(input: SignatureInput): FormText[] {
  const { panelX, panelY, panelWidth, pad, y, rowGap, ink, left, right } = input;
  const [boxLeft, boxRight] = innerBox(panelX, panelWidth, pad);
  const split = boxLeft + textWidth(left, VIEW.font.tiny);
  return [
    {
      id: 'signature',
      text: left,
      fontSize: VIEW.font.tiny,
      color: ink.dim,
      x: boxLeft,
      y: panelY + y,
      originX: 0,
      originY: 0,
      box: [boxLeft, boxRight - rowGap],
    },
    {
      id: 'signature-note',
      text: right,
      fontSize: VIEW.font.tiny,
      color: ink.dim,
      x: boxRight,
      y: panelY + y,
      originX: 1,
      originY: 0,
      box: [split + rowGap, boxRight],
    },
  ];
}

/** Where the rubber stamp lands, and how far left it reaches. */
function stampArt(
  panelX: number,
  panelY: number,
  box: { panelWidth: number; panelHeight: number; stampSize: number; stampRightPad: number; stampBottom: number },
  rotation: number,
): FormArt {
  return {
    id: ART.stamp,
    x: panelX + box.panelWidth - box.stampRightPad - box.stampSize / 2,
    y: panelY + box.panelHeight - box.stampBottom,
    width: box.stampSize,
    height: box.stampSize,
    centred: true,
    rotation,
  };
}

/** The left edge of that stamp, whether or not the sprite is there. */
function stampLeft(
  panelX: number,
  box: { panelWidth: number; stampSize: number; stampRightPad: number },
): number {
  return panelX + box.panelWidth - box.stampRightPad - box.stampSize;
}

interface ButtonInput {
  readonly width: number;
  readonly panelY: number;
  readonly box: {
    readonly panelHeight: number;
    readonly buttonWidth: number;
    readonly buttonHeight: number;
    readonly buttonBottom: number;
  };
  readonly label: string;
  readonly fontSize: string;
}

function pageButton(input: ButtonInput): FormButton {
  const { width, panelY, box, label, fontSize } = input;
  const x = (width - box.buttonWidth) / 2;
  const y = panelY + box.panelHeight - box.buttonBottom - box.buttonHeight;
  const pad = 16;
  return {
    x,
    y,
    width: box.buttonWidth,
    height: box.buttonHeight,
    label: {
      id: 'button',
      text: label,
      fontSize,
      color: COLORS.text,
      x: x + box.buttonWidth / 2,
      y: y + box.buttonHeight / 2,
      originX: 0.5,
      originY: 0.5,
      box: [x + pad, x + box.buttonWidth - pad],
    },
  };
}

/** The blank itself, plus the ink every figure on it is written in. */
function sheetOf(
  context: PageContext,
  panelX: number,
  panelY: number,
  panelWidth: number,
  panelHeight: number,
): { sheet: FormArt | null; ink: FormInk } {
  const has = context.hasArt(ART.paper);
  return {
    sheet: has
      ? { id: ART.paper, x: panelX, y: panelY, width: panelWidth, height: panelHeight, centred: false }
      : null,
    ink: has ? PAPER_INK : SCREEN_INK,
  };
}

// ---------------------------------------------------------------------------
// The three pages
// ---------------------------------------------------------------------------

export interface ReportPageInput extends PageContext {
  readonly report: ShiftReport;
  readonly outcome: ShiftOutcome;
  readonly maxDepthRow: number;
}

export function reportPage(input: ReportPageInput): FormPage {
  const { width, height, report, outcome, maxDepthRow } = input;
  const box = VIEW.report;
  const font = VIEW.font;
  const panelX = (width - box.panelWidth) / 2;
  const panelY = (height - box.panelHeight) / 2;
  const { sheet, ink } = sheetOf(input, panelX, panelY, box.panelWidth, box.panelHeight);
  const inner = innerBox(panelX, box.panelWidth, box.pad);
  const breach = report.endReason === 'breach';

  const head = masthead({
    panelX, panelY, panelWidth: box.panelWidth, pad: box.pad,
    headerHeight: box.headerHeight,
    emblemSize: box.emblemSize, emblemY: box.emblemY, emblemGap: box.emblemGap,
    titleTop: box.titleTop,
    title: breach ? 'АКТ О СРЫВЕ СМЕНЫ' : 'ОТЧЁТ ПО СМЕНЕ',
    titleSize: font.medium,
    titleColor: breach ? COLORS.warning : COLORS.text,
    codeTop: box.formCodeTop,
    code: `ФОРМА В-9 · ПЯТИЛЕТКА ${outcome.profile.fiveYearPlan} · СТАНЦИЯ ВОСТОК-9`,
    hasEmblem: input.hasArt(ART.emblem),
  });

  // The plan is a share of the best shift so far (PLAN_V1 §4), so the percent is
  // what the player reads to see whether the premium was earned. It says
  // «ВЫПОЛНЕН: 140%» and not «ВЫПОЛНЕН НА 140%» for two words' worth of width:
  // the longer form does not fit the sheet at `font.large` even at one digit.
  const quotaPercent = Math.round((outcome.quota > 0 ? report.banked / outcome.quota : 1) * 100);
  const planMet = report.banked >= outcome.quota;
  const percentText = `ПЛАН ВЫПОЛНЕН: ${quotaPercent}%`;

  const rows: FigureRow[] = [
    ['Графа 1 · норма к сдаче', String(outcome.quota), ink.text],
    ['Графа 2 · добыто лома', String(report.mined), ink.scrap],
    ['Графа 3 · сдано лома', String(report.banked), ink.scrap],
    // A breach is the only way the cargo is ever lost, so this line only shows up then.
    ...(breach
      ? ([['Графа 3а · утрачено в карго', String(report.mined - report.banked), ink.warn]] as FigureRow[])
      : []),
    ...(outcome.bonusScrap > 0
      ? ([['Графа 4 · премия за план', `+${outcome.bonusScrap}`, ink.scrap]] as FigureRow[])
      : []),
    ['Графа 5 · зачислено лома', String(outcome.scrapEarned), ink.scrap],
    ['Графа 6 · глубина забоя', `${report.deepestRow} / ${maxDepthRow}`, ink.text],
    ...(outcome.newCheckpoints > 0
      ? ([[
          'Графа 7 · чекпоинты',
          `${outcome.newCheckpoints} (+${outcome.checkpointCrystals} кр.)`,
          ink.crystal,
        ]] as FigureRow[])
      : []),
    ['Графа 8 · зачислено кристаллов', String(outcome.crystalsEarned), ink.crystal],
    ['Графа 9 · отбито волн', String(report.waves), ink.dim],
    [
      'Графа 10 · рекорд',
      outcome.record ? `${report.banked} — НОВЫЙ` : String(outcome.profile.bestShiftScrap),
      outcome.record ? ink.good : ink.dim,
    ],
  ];
  const body = figureRows({
    panelX, panelY, panelWidth: box.panelWidth, pad: box.pad,
    top: box.rowsTop, rowHeight: box.rowHeight, rowGap: box.rowGap,
    ruleHeight: box.ruleHeight, ink, rows,
  });

  return {
    panel: { x: panelX, y: panelY, width: box.panelWidth, height: box.panelHeight },
    shadeAlpha: 0.86,
    sheet,
    panelEdgeColor: COLORS.domeEdge,
    sheetRules: sheet
      ? sheetRuling(panelX, panelY, box.panelWidth, box.panelHeight, box.headerHeight, ink)
      : [],
    headerRules: head.rules,
    art: [...head.art, ...(input.hasArt(ART.stamp) ? [stampArt(panelX, panelY, box, -0.14)] : [])],
    rules: body.rules,
    texts: [
      ...head.texts,
      {
        id: 'percent',
        text: percentText,
        fontSize: fitFontSize(percentText, [font.large, font.medium], inner[1] - inner[0]),
        color: planMet ? ink.good : ink.warn,
        x: width / 2,
        y: panelY + box.percentTop,
        originX: 0.5,
        originY: 0,
        box: inner,
      },
      {
        id: 'premium',
        text: planMet ? 'ПЛАН ПЕРЕКРЫТ — НАЧИСЛЕНА ПРЕМИЯ' : 'ПЛАН НЕ ЗАКРЫТ — ПРЕМИИ НЕТ',
        fontSize: font.small,
        color: planMet ? ink.good : ink.dim,
        x: width / 2,
        y: panelY + box.stampTop,
        originX: 0.5,
        originY: 0,
        box: inner,
      },
      ...body.texts,
      ...signature({
        panelX, panelY, panelWidth: box.panelWidth, pad: box.pad,
        y: box.panelHeight - box.signatureBottom, rowGap: box.rowGap, ink,
        left: 'Начальник смены: подпись',
        right: breach ? 'пробитие купола' : 'принят к учёту',
      }),
    ],
    button: pageButton({
      width, panelY, box, label: 'НА БАЗУ', fontSize: font.medium,
    }),
  };
}

export interface VictoryPageInput extends PageContext {
  readonly balance: Balance;
  readonly profile: Profile;
}

export function victoryPage(input: VictoryPageInput): FormPage {
  const { width, height, balance, profile } = input;
  const box = VIEW.victory;
  const font = VIEW.font;
  const panelX = (width - box.panelWidth) / 2;
  const panelY = (height - box.panelHeight) / 2;
  const { sheet, ink } = sheetOf(input, panelX, panelY, box.panelWidth, box.panelHeight);
  const inner = innerBox(panelX, box.panelWidth, box.pad);

  const head = masthead({
    panelX, panelY, panelWidth: box.panelWidth, pad: box.pad,
    headerHeight: box.headerHeight,
    emblemSize: box.emblemSize, emblemY: box.emblemY, emblemGap: box.emblemGap,
    titleTop: box.titleTop,
    title: 'ГОРОД НАЙДЕН',
    titleSize: font.large,
    titleColor: COLORS.crystal,
    hasEmblem: input.hasArt(ART.emblem),
  });

  const rows: FigureRow[] = [
    ...resourceIds(balance).map(
      (id): FigureRow => [
        `Итог · ${resourceName(balance, id).toLowerCase()} в кассе`,
        String(walletAmount(profile, id)),
        // The rare currency is the bright one, the way the report colours it.
        balance.resources[id]?.premium === true ? ink.crystal : ink.scrap,
      ],
    ),
    ['Итог · рекорд смены', String(profile.bestShiftScrap), ink.text],
    ['Итог · куплено уровней', String(totalLevels(balance, profile)), ink.text],
  ];
  const body = figureRows({
    panelX, panelY, panelWidth: box.panelWidth, pad: box.pad,
    top: box.rowsTop, rowHeight: box.rowHeight, rowGap: box.rowGap,
    ruleHeight: box.ruleHeight, ink, rows,
  });

  // What the next plan does, in the order the player will feel it. The numbers
  // are the prestige multipliers of balance.json, written out as they are. They
  // are written into the room left of the rubber stamp, which shares the band
  // with them: the sheet has nowhere else to be stamped.
  const promiseRight = stampLeft(panelX, box) - box.promiseStampGap;
  const promises: readonly (readonly [string, number])[] = [
    [`Волны крепче: здоровье ×${balance.prestige.wave_hp_mult_per_tier}`, ink.warn],
    [`Руда богаче: лом с клетки ×${balance.prestige.yield_mult_per_tier}`, ink.scrap],
    ['Прокачка и касса — при тебе', ink.text],
    ['Ствол засыпан: глубина с нуля', ink.dim],
  ];

  return {
    panel: { x: panelX, y: panelY, width: box.panelWidth, height: box.panelHeight },
    shadeAlpha: 0.9,
    sheet,
    panelEdgeColor: COLORS.buttonEdge,
    sheetRules: sheet
      ? sheetRuling(panelX, panelY, box.panelWidth, box.panelHeight, box.headerHeight, ink)
      : [],
    headerRules: head.rules,
    art: [...head.art, ...(input.hasArt(ART.stamp) ? [stampArt(panelX, panelY, box, 0.12)] : [])],
    rules: body.rules,
    texts: [
      ...head.texts,
      {
        id: 'subtitle',
        text: `ПЯТИЛЕТКА ${profile.fiveYearPlan} ЗАКРЫТА · ДНО ВСКРЫТО`,
        fontSize: font.small,
        color: ink.dim,
        x: width / 2,
        y: panelY + box.stampTop,
        originX: 0.5,
        originY: 0,
        box: inner,
      },
      {
        id: 'depth',
        text: String(balance.shift.grid_depth),
        fontSize: font.huge,
        color: ink.good,
        x: width / 2,
        y: panelY + box.depthTop,
        originX: 0.5,
        originY: 0,
        box: inner,
      },
      {
        id: 'depthUnit',
        text: `РЯД · ${lastLayerName(balance)} ПРОЙДЕН НАСКВОЗЬ`,
        fontSize: font.tiny,
        color: ink.dim,
        x: width / 2,
        y: panelY + box.depthUnitTop,
        originX: 0.5,
        originY: 0,
        box: inner,
      },
      ...body.texts,
      ...promises.map(([text, color], index): FormText => ({
        id: `promise${index}`,
        text,
        fontSize: font.small,
        color,
        x: inner[0],
        y: panelY + box.promisesTop + box.promiseHeight * index,
        originX: 0,
        originY: 0,
        box: [inner[0], promiseRight],
      })),
    ],
    button: pageButton({
      width, panelY, box,
      label: `НАЧАТЬ ПЯТИЛЕТКУ ${profile.fiveYearPlan + 1}`,
      fontSize: font.medium,
    }),
  };
}

export interface HangarPageInput extends PageContext {
  readonly balance: Balance;
  readonly harvest: HangarHarvest;
}

export function hangarPage(input: HangarPageInput): FormPage {
  const { width, height, balance, harvest } = input;
  const box = VIEW.hangar;
  const font = VIEW.font;
  const panelX = (width - box.panelWidth) / 2;
  const panelY = (height - box.panelHeight) / 2;
  const { sheet, ink } = sheetOf(input, panelX, panelY, box.panelWidth, box.panelHeight);
  const inner = innerBox(panelX, box.panelWidth, box.pad);
  const hasPile = input.hasArt(ART.hangarPile);

  const head = masthead({
    panelX, panelY, panelWidth: box.panelWidth, pad: box.pad,
    headerHeight: box.headerHeight,
    emblemSize: box.emblemSize, emblemY: box.emblemY, emblemGap: box.emblemGap,
    titleTop: box.titleTop,
    title: 'АНГАР РАБОТАЛ БЕЗ ТЕБЯ',
    titleSize: font.medium,
    titleColor: COLORS.text,
    codeTop: box.formCodeTop,
    code: 'ФОРМА В-9а · СМЕНА В ОТСУТСТВИЕ',
    hasEmblem: input.hasArt(ART.emblem),
  });

  const rows: FigureRow[] = [
    ['Графа 1 · часы без тебя', formatHours(harvest.hours), ink.text],
    ['Графа 2 · заполнение ангара', `${Math.round(harvest.fillShare * 100)}%`, ink.text],
    ['Графа 3 · потолок простоя', formatHours(balance.offline.cap_hours), ink.dim],
  ];
  const body = figureRows({
    panelX, panelY, panelWidth: box.panelWidth, pad: box.pad,
    top: box.rowsTop, rowHeight: box.rowHeight, rowGap: box.rowGap,
    ruleHeight: box.ruleHeight, ink, rows,
  });

  // A gold number over dark scrap is a gold number over noise, and over the pale
  // blank it is a gold number over nothing — so it keeps the same dark outline
  // whichever ground it lands on, and keeps its own bright colour rather than
  // taking the ink of the page.
  const outline = { color: COLORS.shaft, width: 8 } as const;

  return {
    panel: { x: panelX, y: panelY, width: box.panelWidth, height: box.panelHeight },
    shadeAlpha: 0.9,
    sheet,
    panelEdgeColor: COLORS.domeEdge,
    sheetRules: sheet
      ? sheetRuling(panelX, panelY, box.panelWidth, box.panelHeight, box.headerHeight, ink)
      : [],
    headerRules: head.rules,
    art: [
      ...head.art,
      ...(hasPile
        ? [{
            id: ART.hangarPile,
            x: width / 2,
            y: panelY + box.pileCenterTop,
            width: box.pileSize,
            height: box.pileSize,
            centred: true,
            alpha: box.pileAlpha,
          } as FormArt]
        : []),
      ...(input.hasArt(ART.stamp) ? [stampArt(panelX, panelY, box, 0.1)] : []),
    ],
    rules: body.rules,
    texts: [
      ...head.texts,
      {
        id: 'amount',
        text: `+${harvest.scrap}`,
        fontSize: font.huge,
        color: COLORS.scrap,
        x: width / 2,
        y: panelY + box.amountTop,
        originX: 0.5,
        originY: 0,
        box: inner,
        stroke: outline,
      },
      {
        id: 'amountUnit',
        text: resourceName(balance, scrapId(balance)).toUpperCase(),
        fontSize: font.medium,
        color: COLORS.scrap,
        x: width / 2,
        y: panelY + box.amountUnitTop,
        originX: 0.5,
        originY: 0,
        box: inner,
        stroke: { color: COLORS.shaft, width: 6 },
      },
      ...body.texts,
      {
        id: 'note',
        text: 'Ангар не копает глубже — только лом',
        fontSize: font.small,
        color: ink.dim,
        x: width / 2,
        y: panelY + box.noteTop,
        originX: 0.5,
        originY: 0,
        box: inner,
      },
      ...signature({
        panelX, panelY, panelWidth: box.panelWidth, pad: box.pad,
        y: box.panelHeight - box.signatureBottom, rowGap: box.rowGap, ink,
        left: 'Кладовщик: подпись',
        right: 'принято на склад',
      }),
    ],
    button: pageButton({
      width, panelY, box, label: 'ЗАБРАТЬ', fontSize: font.large,
    }),
  };
}

/** Levels bought across every branch: one figure for the whole upgrade sheet. */
function totalLevels(balance: Balance, profile: Profile): number {
  return upgradeIds(balance).reduce((sum, id) => sum + upgradeLevel(profile, id), 0);
}

/** Name of the deepest layer of balance.layers: the one the bottom belongs to. */
function lastLayerName(balance: Balance): string {
  const layer = balance.layers[balance.layers.length - 1];
  return (layer?.name ?? '').toUpperCase();
}

/** «4 ч 30 мин» — hours the way a form would write them, minutes never lost. */
export function formatHours(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (wholeHours <= 0) {
    return `${minutes} мин`;
  }
  if (minutes === 0) {
    return `${wholeHours} ч`;
  }
  return `${wholeHours} ч ${minutes} мин`;
}
