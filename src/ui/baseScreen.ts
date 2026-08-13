import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';
import type { Balance } from '../sim/balance.js';
import {
  canBuyUpgrade,
  checkpointRows,
  deepestOpenCheckpoint,
  hangarScrapPerHour,
  isCheckpointOpen,
  nextUpgrade,
  resourceIds,
  resourceName,
  scrapId,
  shiftQuota,
  upgradeIds,
  upgradeItem,
  upgradeLevel,
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
type PinnedPart = Phaser.GameObjects.Rectangle | Phaser.GameObjects.Text;

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

  const backdrop = scene.add.rectangle(0, 0, width, height, COLORS.shaft).setOrigin(0, 0);
  const header = scene.add.rectangle(0, 0, width, base.headerHeight, COLORS.dome).setOrigin(0, 0);
  const headerEdge = scene.add
    .rectangle(0, base.headerHeight - 2, width, 2, COLORS.domeEdge)
    .setOrigin(0, 0);

  const title = centerText(scene, width / 2, base.titleY, 'БАЗА · МЕЖДУ СМЕНАМИ', font.large, COLORS.text);
  const wallet = centerText(scene, width / 2, base.walletY, '', font.medium, COLORS.scrap);
  const plan = centerText(scene, width / 2, base.planY, '', font.small, COLORS.textDim);

  const upgradeRows = upgradeIds(balance).map((id, index) =>
    createUpgradeRow(scene, {
      balance,
      upgradeId: id,
      x: base.margin,
      y: base.listTop + (base.rowHeight + base.rowGap) * index,
      rowWidth,
      onBuy,
    }),
  );

  const listBottom = base.listTop + (base.rowHeight + base.rowGap) * upgradeRows.length;
  const depthTitleY = listBottom + base.sectionGap;
  const chipsY = depthTitleY + base.sectionTitleHeight;

  const depthTitle = centerText(
    scene,
    width / 2,
    depthTitleY,
    'ЛИФТ СПУСКАЕТ НА РЯД',
    font.small,
    COLORS.textDim,
  );

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
    .setStrokeStyle(3, COLORS.buttonEdge)
    .setInteractive({ useHandCursor: true });
  start.on(Phaser.Input.Events.POINTER_DOWN, () => {
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
    header,
    headerEdge,
    title,
    wallet,
    plan,
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

  function repaint(): void {
    wallet.setText(walletLine(balance, profile));
    plan.setText(`ПЛАН НА СМЕНУ: СДАТЬ ${shiftQuota(balance, profile)}`);
    for (const row of upgradeRows) {
      row.update(profile);
    }
    for (const chip of chips) {
      chip.update(profile);
    }
    chips.forEach((chip, index) => {
      chip.setSelected(rows[index] === selectedRow);
    });
    startLabel.setText(`НАЧАТЬ СМЕНУ · РЯД ${selectedRow}`);
    repaintHangar();
  }

  function repaintHangar(): void {
    const share = Math.min(1, Math.max(0, harvest?.fillShare ?? 0));
    hangarFill.width = rowWidth * share;
    const perHour = Math.round(hangarScrapPerHour(balance, profile));
    const scrapLabel = resourceName(balance, scrapId(balance)).toUpperCase();
    hangarLabel.setText(
      `АНГАР: ${Math.round(share * 100)}% · ${perHour} ${scrapLabel}/Ч`,
    );
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

/** «ЛОМ: 1200 · КРИСТАЛЛ: 4» — resource names come from balance.json. */
function walletLine(balance: Balance, profile: Profile): string {
  return resourceIds(balance)
    .map((id) => `${resourceName(balance, id).toUpperCase()}: ${walletAmount(profile, id)}`)
    .join(' · ');
}

interface UpgradeRowOptions {
  readonly balance: Balance;
  readonly upgradeId: string;
  readonly x: number;
  readonly y: number;
  readonly rowWidth: number;
  readonly onBuy: (upgradeId: string) => void;
}

/**
 * One branch: name with the level bought, what it does, and the price of the
 * next level as the button. A bought-out branch shows as bought and does nothing.
 */
function createUpgradeRow(scene: Phaser.Scene, options: UpgradeRowOptions): Part {
  const { balance, upgradeId, x, y, rowWidth, onBuy } = options;
  const { base, font } = VIEW;
  const item = upgradeItem(balance, upgradeId);

  const back = scene.add
    .rectangle(x, y, rowWidth, base.rowHeight, COLORS.panel)
    .setOrigin(0, 0)
    .setStrokeStyle(2, COLORS.dugEdge);

  const name = leftText(scene, x + base.rowPad, y + base.rowNameY, '', font.medium, COLORS.text);
  const effect = leftText(
    scene,
    x + base.rowPad,
    y + base.rowEffectY,
    item?.effect ?? '',
    font.tiny,
    COLORS.textDim,
  );

  const buyX = x + rowWidth - base.rowPad - base.buyWidth;
  const buyY = y + (base.rowHeight - base.buyHeight) / 2;
  const buy = scene.add
    .rectangle(buyX, buyY, base.buyWidth, base.buyHeight, COLORS.buttonOff)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge)
    .setInteractive({ useHandCursor: true });
  const buyLabel = centerText(
    scene,
    buyX + base.buyWidth / 2,
    buyY + base.buyHeight / 2,
    '',
    font.small,
    COLORS.text,
  ).setOrigin(0.5, 0.5);

  let current: Profile | null = null;
  buy.on(Phaser.Input.Events.POINTER_DOWN, () => {
    if (current && canBuyUpgrade(balance, current, upgradeId)) {
      onBuy(upgradeId);
    }
  });

  return {
    parts: [back, name, effect, buy, buyLabel],
    update(profile: Profile): void {
      current = profile;
      const level = upgradeLevel(profile, upgradeId);
      const label = (item?.name ?? upgradeId).toUpperCase();
      name.setText(level > 0 ? `${label} · УР. ${level}` : label);

      const next = nextUpgrade(balance, profile, upgradeId);
      if (!next) {
        buy.fillColor = COLORS.buttonOff;
        buy.setStrokeStyle(3, COLORS.dugEdge);
        buyLabel.setText('КУПЛЕНО');
        buyLabel.setColor(cssColor(COLORS.textDim));
        return;
      }
      const affordable = canBuyUpgrade(balance, profile, upgradeId);
      buy.fillColor = affordable ? COLORS.button : COLORS.buttonOff;
      buy.setStrokeStyle(3, affordable ? COLORS.buttonEdge : COLORS.dugEdge);
      buyLabel.setText(`${next.cost} ${resourceName(balance, next.currency).toUpperCase()}`);
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
    .setStrokeStyle(3, COLORS.dugEdge)
    .setInteractive({ useHandCursor: true });
  back.on(Phaser.Input.Events.POINTER_DOWN, () => {
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
