import { VIEW } from '../game/layout.js';
import { textWidth } from '../game/textMetrics.js';
import type { Balance } from '../sim/balance.js';
import {
  hangarScrapPerHour,
  nextUpgrade,
  resourceIds,
  resourceName,
  scrapId,
  shiftQuota,
  upgradeItem,
  upgradeLevel,
  type Profile,
} from '../sim/progress.js';

/**
 * Every word the base screen writes, and the width of screen each one has to fit
 * inside. No Phaser, so `tests/textFit.test.ts` can hold the two against each
 * other for a profile with three-digit levels and a seven-figure wallet.
 *
 * The base is the screen with the most words on it — a header, eight branch rows
 * of two lines each, eight prices, seven chips and two bars — and it is the
 * first thing anyone ever sees of this game. Two of its lines were already
 * touching: the title filled the room the sound toggle left to the last pixel,
 * and «123456 КРИСТАЛЛ» is sixty pixels wider than the price button it is
 * written in.
 */

/** The clear span a line may occupy, `[left, right]` in design pixels. */
export type Box = readonly [number, number];

export const BASE_TITLE = 'БАЗА · МЕЖДУ СМЕНАМИ';
export const DEPTH_TITLE = 'ЛИФТ СПУСКАЕТ НА РЯД';

/** «ЛОМ: 1240 · КРИСТАЛЛ: 8», the whole purse on one line. */
export function walletLine(balance: Balance, amounts: ReadonlyMap<string, number>): string {
  return resourceIds(balance)
    .map((id) => `${resourceName(balance, id).toUpperCase()}: ${amounts.get(id) ?? 0}`)
    .join(' · ');
}

export function planNumberLine(profile: Profile): string {
  return `ПЯТИЛЕТКА ${profile.fiveYearPlan}`;
}

export function quotaLine(balance: Balance, profile: Profile): string {
  return `НОРМА СМЕНЫ: ${shiftQuota(balance, profile)}`;
}

/**
 * The sound toggle. «ЗВУК ВЫКЛ» and not «ЗВУК: ВЫКЛ»: the colon cost seven
 * pixels the header did not have, and the toggle is what stops the title
 * fitting.
 */
export function muteLine(muted: boolean): string {
  return muted ? 'ЗВУК ВЫКЛ' : 'ЗВУК ВКЛ';
}

export function branchNameLine(balance: Balance, profile: Profile, id: string): string {
  const label = (upgradeItem(balance, id)?.name ?? id).toUpperCase();
  const level = upgradeLevel(profile, id);
  return level > 0 ? `${label} · УР. ${level}` : label;
}

export function branchEffectLine(balance: Balance, id: string): string {
  return upgradeItem(balance, id)?.effect ?? '';
}

/**
 * The price on a branch's button, or «КУПЛЕНО» when the branch is bought out.
 *
 * The currency is spelt out where it fits and cut to two letters and a stop
 * where it does not — «1240 ЛОМ», but «3400 КР.». The report already writes
 * «кр.» in Графа 7, and eight letters of «КРИСТАЛЛ» simply do not go into a
 * 210-pixel button beside a five-figure price at any font size the row has room
 * for.
 */
export function buyLine(
  balance: Balance,
  profile: Profile,
  id: string,
  maxWidth: number,
): string {
  const next = nextUpgrade(balance, profile, id);
  if (!next) {
    return 'КУПЛЕНО';
  }
  const name = resourceName(balance, next.currency);
  const full = `${next.cost} ${name.toUpperCase()}`;
  if (textWidth(full, VIEW.font.small) <= maxWidth) {
    return full;
  }
  return `${next.cost} ${name.slice(0, 2).toUpperCase()}.`;
}

export function startLine(row: number): string {
  return `НАЧАТЬ СМЕНУ · РЯД ${row}`;
}

export function hangarBarLine(balance: Balance, profile: Profile, fillShare: number): string {
  const perHour = Math.round(hangarScrapPerHour(balance, profile));
  const label = resourceName(balance, scrapId(balance)).toUpperCase();
  return `АНГАР: ${Math.round(Math.min(1, Math.max(0, fillShare)) * 100)}% · ${perHour} ${label}/Ч`;
}

// ---------------------------------------------------------------------------
// The boxes those lines live in. One source for the screen and for the test.
// ---------------------------------------------------------------------------

/** The sound toggle's own plate, at the right of the header. */
export function muteX(width: number): number {
  return width - VIEW.base.margin - VIEW.base.muteWidth;
}

/** The title, between the badge and the sound toggle. */
export function titleX(hasEmblem: boolean): number {
  const base = VIEW.base;
  return hasEmblem ? base.titleX + base.emblemSize + base.emblemGap : base.titleX;
}

export function titleBox(width: number, hasEmblem: boolean): Box {
  return [titleX(hasEmblem), muteX(width) - VIEW.base.titleGap];
}

export function muteBox(width: number): Box {
  const pad = VIEW.base.buyPad;
  return [muteX(width) + pad, muteX(width) + VIEW.base.muteWidth - pad];
}

/** The wallet, the whole width of the screen less its margins. */
export function fullBox(width: number): Box {
  return [VIEW.base.margin, width - VIEW.base.margin];
}

/** The five-year plan on the left of its row, the quota on the right. */
export function planLeftBox(width: number, right: string): Box {
  return [VIEW.base.margin, width - VIEW.base.margin - textWidth(right, VIEW.font.small) - VIEW.base.rowTextGap];
}

export function planRightBox(width: number, left: string): Box {
  return [
    VIEW.base.margin + textWidth(left, VIEW.font.small) + VIEW.base.rowTextGap,
    width - VIEW.base.margin,
  ];
}

/** Where the two lines of a branch row start, after the machine at its head. */
export function rowTextX(x: number, hasIcon: boolean): number {
  const base = VIEW.base;
  return hasIcon ? x + base.rowPad + base.rowIconSize + base.rowIconGap : x + base.rowPad;
}

/** The room those two lines have before the price button on their right. */
export function rowTextBox(x: number, rowWidth: number, hasIcon: boolean): Box {
  const base = VIEW.base;
  return [rowTextX(x, hasIcon), buyX(x, rowWidth) - base.rowTextGap];
}

export function buyX(x: number, rowWidth: number): number {
  const base = VIEW.base;
  return x + rowWidth - base.rowPad - base.buyWidth;
}

export function buyBox(x: number, rowWidth: number): Box {
  const base = VIEW.base;
  const left = buyX(x, rowWidth);
  return [left + base.buyPad, left + base.buyWidth - base.buyPad];
}

export function chipBox(x: number, chipWidth: number): Box {
  const pad = VIEW.base.buyPad;
  return [x + pad, x + chipWidth - pad];
}

export function startBox(width: number): Box {
  const base = VIEW.base;
  return [base.margin + base.rowPad, width - base.margin - base.rowPad];
}
