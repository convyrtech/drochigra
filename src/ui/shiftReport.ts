import Phaser from 'phaser';
import { ART } from '../game/artTextures.js';
import {
  COLORS,
  cssColor,
  FONT_FAMILY,
  PAPER_INK,
  SCREEN_INK,
  VIEW,
} from '../game/layout.js';
import type { ShiftOutcome } from '../sim/progress.js';
import type { ShiftReport } from '../sim/shift.js';
import { artImage, artImageCentred, faceButtonRect } from './plate.js';
import { makeTapTarget } from './tapTarget.js';

/**
 * End of shift screen: what the shift produced, what it did to the profile, and
 * one button back to the base (src/ui/baseScreen.ts), where the earnings are
 * spent. Everything shown here is already saved — the plan, the premium and the
 * new checkpoints come from the ShiftOutcome the base wrote to the profile.
 *
 * It is laid out as the paper form the station would file: a header band with the
 * form code and the five-year plan, the plan percent as the headline, and one
 * ruled row per figure — what it is on the left, the number on the right. The
 * numbers and the rules behind them are untouched, only the shape is a form.
 *
 * Once the `paper` sprite exists the form stops being *laid out as* a blank and
 * becomes one: a yellowed sheet under a printed masthead, with the badge of the
 * station in it and a rubber stamp in the corner. That flips the ground from
 * dark to near white, so every figure takes its colour from a `FormInk` chosen
 * by whether the sheet is there — light text on a white sheet is an unreadable
 * screen, and the fallback has to be a whole screen, not a missing picture.
 *
 * Every part is pinned to the screen with scrollFactor 0, the same way the HUD
 * is: that keeps the button's hit area under the button while the shaft is
 * scrolled away from the origin.
 */
export interface ShiftReportOptions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly maxDepthRow: number;
  /** What the shift added to the profile. Already applied and saved. */
  readonly outcome: ShiftOutcome;
  readonly onBack: () => void;
}

/** One ruled row of the form: the caption, the figure, and the figure's colour. */
type FormRow = readonly [string, string, number];

export function createShiftReport(
  scene: Phaser.Scene,
  report: ShiftReport,
  options: ShiftReportOptions,
): void {
  const { width, height, depth, maxDepthRow, outcome, onBack } = options;
  const { report: box, font } = VIEW;

  const shade = scene.add.rectangle(0, 0, width, height, COLORS.shaft, 0.86).setOrigin(0, 0);

  const panelX = (width - box.panelWidth) / 2;
  const panelY = (height - box.panelHeight) / 2;
  // The blank itself, or the dark panel it was before there was one.
  const sheet = artImage(scene, ART.paper, panelX, panelY, box.panelWidth, box.panelHeight);
  const panel =
    sheet ??
    scene.add
      .rectangle(panelX, panelY, box.panelWidth, box.panelHeight, COLORS.panel)
      .setOrigin(0, 0)
      .setStrokeStyle(3, COLORS.domeEdge);
  // Ink on paper, or light text on the dark panel. One choice, six roles.
  const ink = sheet ? PAPER_INK : SCREEN_INK;

  const breach = report.endReason === 'breach';

  // The header band of the form, the way a station blank would print it. It
  // stays dark on the paper too — that is what a printed masthead looks like —
  // so the title above it keeps the light colours it always had.
  const headerBand = scene.add
    .rectangle(panelX, panelY, box.panelWidth, box.headerHeight, COLORS.dome)
    .setOrigin(0, 0);
  const headerEdge = scene.add
    .rectangle(panelX, panelY + box.headerHeight, box.panelWidth, box.ruleHeight, COLORS.domeEdge)
    .setOrigin(0, 0);
  const emblem = artImage(
    scene,
    ART.emblem,
    panelX + box.pad,
    panelY + box.emblemY,
    box.emblemSize,
    box.emblemSize,
  );

  // Set beside the badge rather than centred on the sheet: a centred
  // «АКТ О СРЫВЕ СМЕНЫ» runs straight into it. With no badge the masthead text
  // simply starts at the margin, which is where it started before.
  const mastheadX = panelX + box.pad + (emblem ? box.emblemSize + box.emblemGap : 0);
  const title = left(
    scene,
    mastheadX,
    panelY + box.titleTop,
    breach ? 'АКТ О СРЫВЕ СМЕНЫ' : 'ОТЧЁТ ПО СМЕНЕ',
    font.medium,
    breach ? COLORS.warning : COLORS.text,
  );
  const formCode = left(
    scene,
    mastheadX,
    panelY + box.formCodeTop,
    `ФОРМА В-9 · ПЯТИЛЕТКА ${outcome.profile.fiveYearPlan} · СТАНЦИЯ ВОСТОК-9`,
    font.tiny,
    COLORS.textDim,
  );

  // The plan is a share of the best shift so far (PLAN_V1 §4), so the percent is
  // what the player reads to see whether the premium was earned.
  const quotaPercent = Math.round((outcome.quota > 0 ? report.banked / outcome.quota : 1) * 100);
  const planMet = report.banked >= outcome.quota;

  const percent = centered(
    scene,
    width / 2,
    panelY + box.percentTop,
    `ПЛАН ВЫПОЛНЕН НА ${quotaPercent}%`,
    font.large,
    planMet ? ink.good : ink.warn,
  );
  const stampLine = centered(
    scene,
    width / 2,
    panelY + box.stampTop,
    planMet ? 'ПЛАН ПЕРЕКРЫТ — НАЧИСЛЕНА ПРЕМИЯ' : 'ПЛАН НЕ ЗАКРЫТ — ПРЕМИЯ НЕ НАЧИСЛЕНА',
    font.small,
    planMet ? ink.good : ink.dim,
  );

  const rows: readonly FormRow[] = [
    ['Графа 1 · норма к сдаче', String(outcome.quota), ink.text],
    ['Графа 2 · добыто лома', String(report.mined), ink.scrap],
    ['Графа 3 · сдано лома', String(report.banked), ink.scrap],
    // A breach is the only way the cargo is ever lost, so this line only shows up then.
    ...(breach
      ? ([['Графа 3а · утрачено в карго', String(report.mined - report.banked), ink.warn]] as const)
      : []),
    ...(outcome.bonusScrap > 0
      ? ([['Графа 4 · премия за перекрытие', `+${outcome.bonusScrap}`, ink.scrap]] as const)
      : []),
    ['Графа 5 · зачислено лома', String(outcome.scrapEarned), ink.scrap],
    [
      'Графа 6 · достигнутая глубина',
      `${report.deepestRow} / ${maxDepthRow}`,
      ink.text,
    ],
    ...(outcome.newCheckpoints > 0
      ? ([
          [
            'Графа 7 · вскрыто чекпоинтов',
            `${outcome.newCheckpoints} (+${outcome.checkpointCrystals} кр.)`,
            ink.crystal,
          ],
        ] as const)
      : []),
    ['Графа 8 · зачислено кристаллов', String(outcome.crystalsEarned), ink.crystal],
    ['Графа 9 · отбито волн', String(report.waves), ink.dim],
    [
      'Графа 10 · рекорд смены',
      outcome.record ? `${report.banked} — НОВЫЙ` : String(outcome.profile.bestShiftScrap),
      outcome.record ? ink.good : ink.dim,
    ],
  ];

  const rowParts: (Phaser.GameObjects.Rectangle | Phaser.GameObjects.Text)[] = [];
  rows.forEach(([label, value, color], index) => {
    const rowY = panelY + box.rowsTop + box.rowHeight * index;
    rowParts.push(
      left(scene, panelX + box.pad, rowY, label, font.small, ink.dim),
      right(scene, panelX + box.panelWidth - box.pad, rowY, value, font.medium, color),
      // The ruled line every blank has under a filled figure.
      scene.add
        .rectangle(
          panelX + box.pad,
          rowY + box.rowHeight - box.ruleHeight,
          box.panelWidth - box.pad * 2,
          box.ruleHeight,
          ink.rule,
        )
        .setOrigin(0, 0),
    );
  });

  const signatureY = panelY + box.panelHeight - box.signatureBottom;
  const signature = left(
    scene,
    panelX + box.pad,
    signatureY,
    breach
      ? 'Начальник смены: подпись · причина срыва: пробитие купола'
      : 'Начальник смены: подпись · отчёт принят к учёту',
    font.tiny,
    ink.dim,
  );

  // The rubber stamp goes on after the signature, in the corner beside the way
  // out — a form is stamped when it is done, not across a figure.
  const stampArt = artImageCentred(
    scene,
    ART.stamp,
    panelX + box.panelWidth - box.stampRightPad - box.stampSize / 2,
    panelY + box.panelHeight - box.stampBottom,
    box.stampSize,
    box.stampSize,
  );
  stampArt?.setRotation(-0.14);

  const buttonX = (width - box.buttonWidth) / 2;
  const buttonY = panelY + box.panelHeight - box.buttonBottom - box.buttonHeight;
  const button = scene.add
    .rectangle(buttonX, buttonY, box.buttonWidth, box.buttonHeight, COLORS.button)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge);
  const buttonFace = faceButtonRect(scene, button);
  makeTapTarget(button, onBack);

  const buttonText = scene.add
    .text(buttonX + box.buttonWidth / 2, buttonY + box.buttonHeight / 2, 'НА БАЗУ', {
      fontFamily: FONT_FAMILY,
      fontSize: font.medium,
      color: cssColor(COLORS.text),
    })
    .setOrigin(0.5);

  const parts = [
    shade,
    panel,
    headerBand,
    headerEdge,
    ...(emblem ? [emblem] : []),
    title,
    formCode,
    percent,
    stampLine,
    ...rowParts,
    signature,
    ...(stampArt ? [stampArt] : []),
    button,
    ...(buttonFace ? [buttonFace] : []),
    buttonText,
  ];
  for (const part of parts) {
    part.setScrollFactor(0).setDepth(depth);
  }
}

function centered(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  fontSize: string,
  color: number,
): Phaser.GameObjects.Text {
  return scene.add
    .text(x, y, text, { fontFamily: FONT_FAMILY, fontSize, color: cssColor(color) })
    .setOrigin(0.5, 0);
}

function left(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  fontSize: string,
  color: number,
): Phaser.GameObjects.Text {
  return scene.add
    .text(x, y, text, { fontFamily: FONT_FAMILY, fontSize, color: cssColor(color) })
    .setOrigin(0, 0);
}

function right(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  fontSize: string,
  color: number,
): Phaser.GameObjects.Text {
  return scene.add
    .text(x, y, text, { fontFamily: FONT_FAMILY, fontSize, color: cssColor(color) })
    .setOrigin(1, 0);
}
