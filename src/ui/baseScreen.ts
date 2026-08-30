import Phaser from 'phaser';
import { ART, hasArt } from '../game/artTextures.js';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';
import { SFX } from '../game/sfx.js';
import { fitInside } from './formPage.js';
import { artImage } from './plate.js';
import { makeTapTarget } from './tapTarget.js';
import {
  BASE_TITLE,
  DEPTH_TITLE,
  branchEffectLine,
  branchNameLine,
  buyBox,
  buyLine,
  buyX,
  chipBox,
  fullBox,
  hangarBarLine,
  muteBox,
  muteLine,
  muteX,
  planLeftBox,
  planNumberLine,
  planRightBox,
  quotaLine,
  rowTextBox,
  rowTextX,
  startBox,
  startLine,
  titleBox,
  titleX,
  walletLine,
  type Box,
} from './baseText.js';
import type { Balance } from '../sim/balance.js';
import {
  canBuyUpgrade,
  checkpointRows,
  deepestOpenCheckpoint,
  isCheckpointOpen,
  nextUpgrade,
  resourceIds,
  upgradeIds,
  walletAmount,
  type HangarHarvest,
  type Profile,
} from '../sim/progress.js';

/**
 * The base between shifts (PLAN_V1 §7): the wallet, every upgrade branch with
 * its price, the elevator checkpoint the next shift starts at (PLAN_V1 §4) and
 * the plan the shift will be measured against.
 *
 * Built once and updated in place: a purchase only changes texts and colours,
 * so no Phaser object is created or dropped per tap. Every part is pinned with
 * scrollFactor 0 and put on one depth, the same way the HUD is.
 *
 * Taps only, no scrolling and no gestures (PLAN_V1 §3): all eight branches and
 * all seven checkpoints fit one portrait screen as compact rows.
 */
export interface BaseScreen {
  /** Repaints everything from a new profile. Used right after a purchase. */
  readonly update: (profile: Profile, harvest?: HangarHarvest) => void;
  readonly destroy: () => void;
}

export interface BaseScreenOptions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly balance: Balance;
  readonly profile: Profile;
  /**
   * What the hangar holds right now, for the fill bar. The clock is the scene's
   * business, so the reading is handed in; without it the bar shows an empty
   * hangar, which is what a player who just collected has.
   */
  readonly harvest?: HangarHarvest;
  /** One level of a branch. The scene buys it and hands the new profile back. */
  readonly onBuy: (upgradeId: string) => void;
  readonly onStartShift: (startRow: number) => void;
}

/** Anything the screen pins and puts on its own depth. */
type PinnedPart =
  | Phaser.GameObjects.Rectangle
  | Phaser.GameObjects.Text
  | Phaser.GameObjects.Image
  | Phaser.GameObjects.TileSprite;

interface Part {
  readonly parts: readonly PinnedPart[];
  readonly update: (profile: Profile) => void;
}

export function createBaseScreen(scene: Phaser.Scene, options: BaseScreenOptions): BaseScreen {
  const { width, height, depth, balance, onBuy, onStartShift } = options;
  const { base, font } = VIEW;
  const rowWidth = width - base.margin * 2;

  let profile = options.profile;
  let harvest = options.harvest ?? null;
  let selectedRow = deepestOpenCheckpoint(balance, profile);

  // The polar night the station stands in, or the flat dark field it replaces.
  // It is the backdrop of the whole screen, so it shows in the margins and in
  // the gaps between the rows — which is the whole of the base that is not a
  // plate, and the whole difference between «a game» and «a debug view».
  const sky = artImage(scene, ART.baseSky, 0, 0, width, height);
  const backdrop = sky ?? scene.add.rectangle(0, 0, width, height, COLORS.shaft).setOrigin(0, 0);
  // The night, sunk behind the screen. Without the picture there is nothing to
  // sink and no scrim is added at all.
  const skyScrim = sky
    ? scene.add.rectangle(0, 0, width, height, COLORS.shaft, base.skyScrimAlpha).setOrigin(0, 0)
    : null;
  // Over a picture the header band is a scrim, not a field: the sky keeps
  // showing through it and the three lines of text keep their contrast.
  const header = scene.add
    .rectangle(0, 0, width, base.headerHeight, COLORS.dome, sky ? base.headerScrimAlpha : 1)
    .setOrigin(0, 0);
  const headerEdge = scene.add
    .rectangle(0, base.headerHeight - 2, width, 2, COLORS.domeEdge)
    .setOrigin(0, 0);

  // The badge at the head of the title line, and the title beside it. Without
  // the badge the title simply starts at the margin: nothing else moves.
  const emblem = artImage(
    scene,
    ART.emblem,
    base.titleX,
    base.emblemY,
    base.emblemSize,
    base.emblemSize,
  );
  const title = leftText(
    scene,
    titleX(emblem !== null),
    base.titleY,
    BASE_TITLE,
    font.small,
    COLORS.text,
  );
  fitInside(title, boxWidth(titleBox(width, emblem !== null)));
  const wallet = centerText(scene, width / 2, base.walletY, '', font.medium, COLORS.scrap);
  // The plan row is split the way the HUD splits its rows: which five-year plan
  // the station is in on the left, the quota that plan hands out on the right.
  // Both are short, so nothing has to move to fit them on one line.
  const planNumber = leftText(scene, base.margin, base.planY, '', font.small, COLORS.buttonEdge);
  const plan = rightText(scene, width - base.margin, base.planY, '', font.small, COLORS.textDim);

  // Sound toggle in the top-right corner of the header: it flips the Web Audio
  // master and remembers the choice in its own localStorage key.
  const mute = scene.add
    .rectangle(muteX(width), base.muteY, base.muteWidth, base.muteHeight, COLORS.panel)
    .setOrigin(0, 0)
    .setStrokeStyle(2, COLORS.buttonEdge);
  const muteLabel = scene.add
    .text(
      muteX(width) + base.muteWidth / 2,
      base.muteY + base.muteHeight / 2,
      '',
      { fontFamily: FONT_FAMILY, fontSize: font.tiny, color: cssColor(COLORS.text) },
    )
    .setOrigin(0.5, 0.5);
  const paintMute = (): void => {
    const muted = SFX.isMuted();
    muteLabel.setText(muteLine(muted));
    fitInside(muteLabel, boxWidth(muteBox(width)));
    muteLabel.setColor(cssColor(muted ? COLORS.textDim : COLORS.text));
  };
  makeTapTarget(mute, () => {
    SFX.setMuted(!SFX.isMuted());
    SFX.unlock();
    paintMute();
  });
  paintMute();

  // Both or neither, the way the HUD treats its stat icons: a list where seven
  // rows start with a machine and the eighth starts with a word reads as a bug.
  const branchIcons = upgradeIds(balance).every((id) =>
    hasArt(scene, ART.upgradeIconById[id] ?? ''),
  );

  const upgradeRows = upgradeIds(balance).map((id, index) =>
    createUpgradeRow(scene, {
      balance,
      upgradeId: id,
      x: base.margin,
      y: base.listTop + (base.rowHeight + base.rowGap) * index,
      rowWidth,
      icon: branchIcons,
      onBuy,
    }),
  );

  const listBottom = base.listTop + (base.rowHeight + base.rowGap) * upgradeRows.length;
  const depthTitleY = listBottom + base.sectionGap;
  const chipsY = depthTitleY + base.sectionTitleHeight;

  const depthTitle = centerText(scene, width / 2, depthTitleY, DEPTH_TITLE, font.small, COLORS.textDim);
  fitInside(depthTitle, boxWidth(fullBox(width)));

  const rows = checkpointRows(balance);
  const chipWidth = (rowWidth - base.chipGap * (rows.length - 1)) / rows.length;
  const chips = rows.map((row, index) =>
    createChip(scene, {
      row,
      x: base.margin + (chipWidth + base.chipGap) * index,
      y: chipsY,
      chipWidth,
      onPick: (picked) => {
        if (!isCheckpointOpen(profile, picked)) {
          return;
        }
        selectedRow = picked;
        repaint();
      },
    }),
  );

  const startY = height - base.startBottom - base.startHeight;
  const start = scene.add
    .rectangle(base.margin, startY, rowWidth, base.startHeight, COLORS.button)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge);
  makeTapTarget(start, () => {
    onStartShift(selectedRow);
  });
  const startLabel = centerText(
    scene,
    width / 2,
    startY + base.startHeight / 2,
    '',
    font.large,
    COLORS.text,
  ).setOrigin(0.5, 0.5);

  // The hangar bar goes into the strip left below the start button: how full the
  // hangar is and what an hour away is worth, in one line (PLAN_V1 §7).
  const hangarY = height - base.hangarBottom - base.hangarHeight;
  const hangarBack = scene.add
    .rectangle(base.margin, hangarY, rowWidth, base.hangarHeight, COLORS.buttonOff)
    .setOrigin(0, 0)
    .setStrokeStyle(2, COLORS.dugEdge);
  const hangarFill = scene.add
    .rectangle(base.margin, hangarY, 0, base.hangarHeight, COLORS.scrap, 0.35)
    .setOrigin(0, 0);
  const hangarLabel = centerText(
    scene,
    width / 2,
    hangarY + base.hangarHeight / 2,
    '',
    font.tiny,
    COLORS.scrap,
  ).setOrigin(0.5, 0.5);

  const parts: PinnedPart[] = [
    backdrop,
    ...(skyScrim ? [skyScrim] : []),
    header,
    headerEdge,
    ...(emblem ? [emblem] : []),
    title,
    wallet,
    planNumber,
    plan,
    mute,
    muteLabel,
    ...upgradeRows.flatMap((row) => [...row.parts]),
    depthTitle,
    ...chips.flatMap((chip) => [...chip.parts]),
    start,
    startLabel,
    hangarBack,
    hangarFill,
    hangarLabel,
  ];
  for (const part of parts) {
    part.setScrollFactor(0).setDepth(depth);
  }

  // The wallet counts from what is on the label to the new figure, so a buy (or
  // a bank) visibly runs toward its value instead of snapping. Only the label
  // moves; the profile the rest of the screen reads is already the final one.
  const resourceList = resourceIds(balance);
  let displayed = new Map(resourceList.map((id) => [id, walletAmount(profile, id)]));
  const WALLET_COUNT_MS = 600;

  const walletSpan = boxWidth(fullBox(width));

  function walletLineFrom(amounts: Map<string, number>): string {
    return walletLine(balance, amounts);
  }

  function animateWallet(target: Profile): void {
    const to = resourceList.map((id) => walletAmount(target, id));
    const from = resourceList.map((id) => displayed.get(id) ?? 0);
    const start = scene.time.now;
    const step = (): void => {
      const t = Math.min(1, (scene.time.now - start) / WALLET_COUNT_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      resourceList.forEach((id, i) => {
        const fromValue = from[i] ?? 0;
        const toValue = to[i] ?? 0;
        displayed.set(id, Math.round(fromValue + (toValue - fromValue) * eased));
      });
      wallet.setText(walletLineFrom(displayed));
      fitInside(wallet, walletSpan);
      if (t < 1) {
        scene.time.delayedCall(16, step);
      }
    };
    step();
  }

  function repaint(): void {
    animateWallet(profile);
    const planLeft = planNumberLine(profile);
    const planRight = quotaLine(balance, profile);
    planNumber.setText(planLeft);
    fitInside(planNumber, boxWidth(planLeftBox(width, planRight)));
    plan.setText(planRight);
    fitInside(plan, boxWidth(planRightBox(width, planLeft)));
    for (const row of upgradeRows) {
      row.update(profile);
    }
    for (const chip of chips) {
      chip.update(profile);
    }
    chips.forEach((chip, index) => {
      chip.setSelected(rows[index] === selectedRow);
    });
    startLabel.setText(startLine(selectedRow));
    fitInside(startLabel, boxWidth(startBox(width)));
    repaintHangar();
  }

  function repaintHangar(): void {
    const share = Math.min(1, Math.max(0, harvest?.fillShare ?? 0));
    hangarFill.width = rowWidth * share;
    hangarLabel.setText(hangarBarLine(balance, profile, share));
    fitInside(hangarLabel, boxWidth(startBox(width)));
  }

  repaint();

  return {
    update(next: Profile, nextHarvest?: HangarHarvest): void {
      profile = next;
      if (nextHarvest !== undefined) {
        harvest = nextHarvest;
      }
      // A new shift may have opened deeper checkpoints; the pick stays where the
      // player put it as long as it is still open.
      if (!isCheckpointOpen(profile, selectedRow)) {
        selectedRow = deepestOpenCheckpoint(balance, profile);
      }
      repaint();
    },
    destroy(): void {
      for (const part of parts) {
        part.destroy();
      }
    },
  };
}

interface UpgradeRowOptions {
  readonly balance: Balance;
  readonly upgradeId: string;
  readonly x: number;
  readonly y: number;
  readonly rowWidth: number;
  /** Is there a machine to put at the head of the row? */
  readonly icon: boolean;
  readonly onBuy: (upgradeId: string) => void;
}

/**
 * One branch: name with the level bought, what it does, and the price of the
 * next level as the button. A bought-out branch shows as bought and does nothing.
 */
function createUpgradeRow(scene: Phaser.Scene, options: UpgradeRowOptions): Part {
  const { balance, upgradeId, x, y, rowWidth, icon, onBuy } = options;
  const { base, font } = VIEW;

  // The riveted plate the row is written on, under everything else. With no
  // plate the rectangle keeps its own dark fill and the row is what it was.
  const plate = artImage(scene, ART.panelPlate, x, y, rowWidth, base.rowHeight);
  plate?.setTint(VIEW.plate.plateTint);
  const back = scene.add
    .rectangle(x, y, rowWidth, base.rowHeight, COLORS.panel)
    .setOrigin(0, 0)
    .setStrokeStyle(2, COLORS.dugEdge);
  if (plate) {
    // Not a colour trick: the fill is switched off, so the plate is the row and
    // the rectangle is only the frame around it.
    back.setFillStyle();
  }

  const branch = icon
    ? artImage(
        scene,
        ART.upgradeIconById[upgradeId] ?? '',
        x + base.rowPad,
        y + (base.rowHeight - base.rowIconSize) / 2,
        base.rowIconSize,
        base.rowIconSize,
      )
    : null;
  const textSpan = boxWidth(rowTextBox(x, rowWidth, branch !== null));
  const textX = rowTextX(x, branch !== null);

  const name = leftText(scene, textX, y + base.rowNameY, '', font.medium, COLORS.text);
  const effect = leftText(
    scene,
    textX,
    y + base.rowEffectY,
    branchEffectLine(balance, upgradeId),
    font.tiny,
    COLORS.textDim,
  );
  fitInside(effect, textSpan);

  const left = buyX(x, rowWidth);
  const buyY = y + (base.rowHeight - base.buyHeight) / 2;
  const buy = scene.add
    .rectangle(left, buyY, base.buyWidth, base.buyHeight, COLORS.buttonOff)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge);
  const buySpan = boxWidth(buyBox(x, rowWidth));
  const buyLabel = centerText(
    scene,
    left + base.buyWidth / 2,
    buyY + base.buyHeight / 2,
    '',
    font.small,
    COLORS.text,
  ).setOrigin(0.5, 0.5);

  let current: Profile | null = null;
  makeTapTarget(buy, () => {
    if (current && canBuyUpgrade(balance, current, upgradeId)) {
      onBuy(upgradeId);
    }
  });

  return {
    parts: [
      ...(plate ? [plate] : []),
      back,
      ...(branch ? [branch] : []),
      name,
      effect,
      buy,
      buyLabel,
    ],
    update(profile: Profile): void {
      current = profile;
      name.setText(branchNameLine(balance, profile, upgradeId));
      fitInside(name, textSpan);

      const bought = nextUpgrade(balance, profile, upgradeId) === null;
      const affordable = !bought && canBuyUpgrade(balance, profile, upgradeId);
      buy.fillColor = affordable ? COLORS.button : COLORS.buttonOff;
      buy.setStrokeStyle(3, affordable ? COLORS.buttonEdge : COLORS.dugEdge);
      buyLabel.setText(buyLine(balance, profile, upgradeId, buySpan));
      fitInside(buyLabel, buySpan);
      buyLabel.setColor(cssColor(affordable ? COLORS.text : COLORS.textDim));
    },
  };
}

interface ChipPart extends Part {
  readonly setSelected: (selected: boolean) => void;
}

interface ChipOptions {
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly chipWidth: number;
  readonly onPick: (row: number) => void;
}

/**
 * One elevator checkpoint. Closed ones are shown dim instead of hidden: the
 * player sees how far the mine goes and what the next shift opens.
 */
function createChip(scene: Phaser.Scene, options: ChipOptions): ChipPart {
  const { row, x, y, chipWidth, onPick } = options;
  const { base, font } = VIEW;

  const back = scene.add
    .rectangle(x, y, chipWidth, base.chipHeight, COLORS.buttonOff)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.dugEdge);
  makeTapTarget(back, () => {
    onPick(row);
  });
  const label = centerText(
    scene,
    x + chipWidth / 2,
    y + base.chipHeight / 2,
    String(row),
    font.small,
    COLORS.text,
  ).setOrigin(0.5, 0.5);
  fitInside(label, boxWidth(chipBox(x, chipWidth)));

  let open = false;
  let selected = false;

  function paint(): void {
    if (!open) {
      back.fillColor = COLORS.buttonOff;
      back.setStrokeStyle(3, COLORS.dugEdge);
      label.setColor(cssColor(COLORS.textDim));
      return;
    }
    back.fillColor = selected ? COLORS.button : COLORS.panel;
    back.setStrokeStyle(3, selected ? COLORS.buttonEdge : COLORS.domeEdge);
    label.setColor(cssColor(COLORS.text));
  }

  return {
    parts: [back, label],
    update(profile: Profile): void {
      open = isCheckpointOpen(profile, row);
      paint();
    },
    setSelected(value: boolean): void {
      selected = value;
      paint();
    },
  };
}

function leftText(
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

function centerText(
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

function rightText(
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

/** The width of a box, which is all anything here ever needs from one. */
function boxWidth(box: Box): number {
  return box[1] - box[0];
}
