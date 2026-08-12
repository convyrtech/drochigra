import type { Balance, UpgradeItemBalance } from './balance.js';
import { ENTRANCE_ROW, type ShiftReport } from './shift.js';

/**
 * The base between shifts, as pure data: the wallet, the upgrade levels, the
 * depth reached and the best shift. No graphics, no localStorage, no clock —
 * src/game/saveStorage.ts does the storing, this module only computes.
 *
 * Upgrades stay data: every number comes from balance.upgrades.items, and the
 * only thing the code knows is *which* number a branch bends —
 * `effectiveBalance` turns levels into a balance the shift can be created with.
 * The simulation itself never hears the word "upgrade".
 */

/** Schema version of the saved profile. Not a game number. */
export const SAVE_VERSION = 1;

/** How much of each resource the player owns, keyed by resource id. */
export type Wallet = Readonly<Record<string, number>>;

/** Level bought in each upgrade branch, keyed by the branch id. */
export type UpgradeLevels = Readonly<Record<string, number>>;

export interface Profile {
  readonly wallet: Wallet;
  readonly upgrades: UpgradeLevels;
  /** Deepest row ever reached. It opens the elevator checkpoints. */
  readonly deepestRow: number;
  /** Scrap handed over in the best shift so far: the quota is a share of it. */
  readonly bestShiftScrap: number;
  /** Five-year plan number. Grows on victory (task #5); stored from now on. */
  readonly fiveYearPlan: number;
}

/** The saved file: a profile plus the schema version it was written with. */
export interface SavedProfile extends Profile {
  readonly version: number;
}

/**
 * Branch ids of balance.upgrades.items this module has to recognise by name:
 * an id is a name, not a number, and something has to know that the drill
 * branch bends the drill speed. The steps themselves stay in balance.json.
 */
const DRILL_ID = 'drill';
const TURRET_ID = 'turret';
const DOME_ID = 'dome';
const CARGO_ID = 'cargo';
const SALVO_ID = 'salvo';
const ELEVATOR_ID = 'elevator';
const CONVEYOR_ID = 'conveyor';

/* ---------------------------------------------------------------- resources */

/** Every resource id, in the order balance.json lists them. */
export function resourceIds(balance: Balance): string[] {
  return Object.keys(balance.resources);
}

/** Russian name of a resource, for the screen. Unknown ids show their id. */
export function resourceName(balance: Balance, id: string): string {
  return balance.resources[id]?.name ?? id;
}

/**
 * The resource digging produces: the first one offline work can also bring.
 * Resources are a list (PLAN_V1 §7), so the pair is resolved from the data
 * instead of being written into the code.
 */
export function scrapId(balance: Balance): string {
  return resourceIds(balance).find((id) => balance.resources[id]?.premium === false) ?? 'scrap';
}

/** The rare resource: the first one offline work never brings. */
export function crystalId(balance: Balance): string {
  return resourceIds(balance).find((id) => balance.resources[id]?.premium === true) ?? 'crystal';
}

/* ------------------------------------------------------------------ profile */

/** A fresh account: nothing bought, nothing earned, surface only. */
export function createProfile(balance: Balance): Profile {
  const wallet: Record<string, number> = {};
  for (const id of resourceIds(balance)) {
    wallet[id] = 0;
  }
  const upgrades: Record<string, number> = {};
  for (const id of Object.keys(balance.upgrades.items)) {
    upgrades[id] = 0;
  }
  return {
    wallet,
    upgrades,
    deepestRow: ENTRANCE_ROW,
    bestShiftScrap: 0,
    fiveYearPlan: 1,
  };
}

export function walletAmount(profile: Profile, resourceId: string): number {
  return profile.wallet[resourceId] ?? 0;
}

export function upgradeLevel(profile: Profile, upgradeId: string): number {
  return profile.upgrades[upgradeId] ?? 0;
}

/* ----------------------------------------------------------------- upgrades */

/** Branch ids in the order balance.json lists them. */
export function upgradeIds(balance: Balance): string[] {
  return Object.keys(balance.upgrades.items);
}

export function upgradeItem(balance: Balance, upgradeId: string): UpgradeItemBalance | null {
  return balance.upgrades.items[upgradeId] ?? null;
}

/** Levels a branch can be bought to. Infinite when balance sets no `max_level`. */
export function upgradeMaxLevel(balance: Balance, upgradeId: string): number {
  const item = upgradeItem(balance, upgradeId);
  if (!item || item.max_level === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, item.max_level);
}

/** Levels above `max_level` never act, however a save got them. */
function clampLevel(balance: Balance, upgradeId: string, level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }
  return Math.min(upgradeMaxLevel(balance, upgradeId), Math.max(0, Math.floor(level)));
}

/**
 * Price of the next level from `level`: `cost_base * growth^level`, rounded.
 * The branch may carry its own `cost_growth` (the elevator does); the rest use
 * the shared `upgrades.cost_growth`.
 */
export function upgradeCost(balance: Balance, upgradeId: string, level: number): number {
  const item = upgradeItem(balance, upgradeId);
  if (!item) {
    return 0;
  }
  const growth = item.cost_growth ?? balance.upgrades.cost_growth;
  return Math.round(item.cost_base * growth ** Math.max(0, level));
}

export function isUpgradeMaxed(balance: Balance, profile: Profile, upgradeId: string): boolean {
  return upgradeLevel(profile, upgradeId) >= upgradeMaxLevel(balance, upgradeId);
}

/** What the next level of a branch costs, or null when it is bought out. */
export function nextUpgrade(
  balance: Balance,
  profile: Profile,
  upgradeId: string,
): { readonly currency: string; readonly cost: number } | null {
  const item = upgradeItem(balance, upgradeId);
  if (!item || isUpgradeMaxed(balance, profile, upgradeId)) {
    return null;
  }
  return { currency: item.currency, cost: upgradeCost(balance, upgradeId, upgradeLevel(profile, upgradeId)) };
}

export function canBuyUpgrade(balance: Balance, profile: Profile, upgradeId: string): boolean {
  const next = nextUpgrade(balance, profile, upgradeId);
  return next !== null && walletAmount(profile, next.currency) >= next.cost;
}

/**
 * Buys one level. Returns the profile to keep, or null when the branch is
 * bought out, unknown, or the wallet is short — the caller then changes nothing.
 */
export function buyUpgrade(balance: Balance, profile: Profile, upgradeId: string): Profile | null {
  const next = nextUpgrade(balance, profile, upgradeId);
  if (!next || walletAmount(profile, next.currency) < next.cost) {
    return null;
  }
  return {
    ...profile,
    wallet: { ...profile.wallet, [next.currency]: walletAmount(profile, next.currency) - next.cost },
    upgrades: { ...profile.upgrades, [upgradeId]: upgradeLevel(profile, upgradeId) + 1 },
  };
}

/** Cheapest level on offer right now, whatever branch and currency it is in. */
export function cheapestUpgrade(
  balance: Balance,
  profile: Profile,
): { readonly id: string; readonly currency: string; readonly cost: number } | null {
  let best: { id: string; currency: string; cost: number } | null = null;
  for (const id of upgradeIds(balance)) {
    const next = nextUpgrade(balance, profile, id);
    if (!next) {
      continue;
    }
    if (!best || next.cost < best.cost) {
      best = { id, currency: next.currency, cost: next.cost };
    }
  }
  return best;
}

/* -------------------------------------------------------- effective balance */

function scaled(base: number, step: number, level: number): number {
  return base * (1 + step * level);
}

function added(base: number, step: number, level: number): number {
  return base + step * level;
}

/**
 * The balance a shift actually runs on: the numbers of balance.json bent by the
 * levels bought. `step` of each branch is the game number; whether it is a
 * share added to one or a flat addition is a rule of that branch, and rules
 * live in code.
 *
 * Two branches change no number here: the conveyor is a rule (`hasConveyor`,
 * fed to `createShift`), and the hangar only pays offline, which does not exist
 * yet — its level is stored and applied in task #5.
 */
export function effectiveBalance(balance: Balance, upgrades: UpgradeLevels): Balance {
  const level = (id: string): number => clampLevel(balance, id, upgrades[id] ?? 0);
  const step = (id: string): number => upgradeItem(balance, id)?.step ?? 0;

  return {
    ...balance,
    drill: {
      ...balance.drill,
      speed_base: scaled(balance.drill.speed_base, step(DRILL_ID), level(DRILL_ID)),
      move_rows_per_sec: scaled(
        balance.drill.move_rows_per_sec,
        step(ELEVATOR_ID),
        level(ELEVATOR_ID),
      ),
    },
    turret: {
      ...balance.turret,
      dps_base: scaled(balance.turret.dps_base, step(TURRET_ID), level(TURRET_ID)),
      // The salvo step is negative: every level cuts a second off the cooldown.
      // `max_level` of the branch is what bounds it; zero is only a sanity floor.
      salvo_cooldown_sec: Math.max(
        0,
        added(balance.turret.salvo_cooldown_sec, step(SALVO_ID), level(SALVO_ID)),
      ),
    },
    dome: {
      ...balance.dome,
      hp_base: added(balance.dome.hp_base, step(DOME_ID), level(DOME_ID)),
    },
    cargo: {
      ...balance.cargo,
      capacity_base: scaled(balance.cargo.capacity_base, step(CARGO_ID), level(CARGO_ID)),
    },
  };
}

/** The conveyor: mined scrap goes straight to the bank, the drill never ascends. */
export function hasConveyor(profile: Profile): boolean {
  return upgradeLevel(profile, CONVEYOR_ID) > 0;
}

/* -------------------------------------------------------------- checkpoints */

/** Every elevator checkpoint of the mine, shallowest first. Row 0 is the surface. */
export function checkpointRows(balance: Balance): number[] {
  const every = balance.shift.checkpoint_every_rows;
  const rows: number[] = [ENTRANCE_ROW];
  if (!(every > 0)) {
    return rows;
  }
  for (let row = ENTRANCE_ROW + every; row <= balance.shift.grid_depth; row += every) {
    rows.push(row);
  }
  return rows;
}

/** A checkpoint is open once the player has dug that deep at least once. */
export function isCheckpointOpen(profile: Profile, row: number): boolean {
  return row <= profile.deepestRow;
}

export function openCheckpointRows(balance: Balance, profile: Profile): number[] {
  return checkpointRows(balance).filter((row) => isCheckpointOpen(profile, row));
}

/** Deepest checkpoint the elevator can drop the drill at. */
export function deepestOpenCheckpoint(balance: Balance, profile: Profile): number {
  const open = openCheckpointRows(balance, profile);
  return open[open.length - 1] ?? ENTRANCE_ROW;
}

function checkpointsOpenAt(balance: Balance, deepestRow: number): number {
  return checkpointRows(balance).filter((row) => row <= deepestRow).length;
}

/* ------------------------------------------------------------------- quota */

/**
 * The plan for a shift: a share of the best shift so far, never below
 * `quota_min` (PLAN_V1 §4). Beating it pays `quota_bonus` of what was handed over.
 */
export function shiftQuota(balance: Balance, profile: Profile): number {
  const fromBest = Math.round(profile.bestShiftScrap * balance.shift.quota_share_of_best);
  return Math.max(balance.shift.quota_min, fromBest);
}

/** Share of the quota a shift covered, 0..1 and beyond. */
export function quotaShare(banked: number, quota: number): number {
  if (!(quota > 0)) {
    return 1;
  }
  return Math.max(0, banked / quota);
}

/** Premium for beating the plan. Zero when the plan was not met. */
export function quotaBonusScrap(balance: Balance, banked: number, quota: number): number {
  if (banked < quota) {
    return 0;
  }
  return Math.round(banked * balance.shift.quota_bonus);
}

/* ------------------------------------------------------------ shift results */

/** What one shift did to the profile, in the words the report screen needs. */
export interface ShiftOutcome {
  readonly profile: Profile;
  /** The plan this shift was measured against. */
  readonly quota: number;
  /** Scrap the plan paid on top of what was handed over. */
  readonly bonusScrap: number;
  /** Scrap that went into the wallet: banked plus the premium. */
  readonly scrapEarned: number;
  /** Checkpoints opened for the first time by this shift. */
  readonly newCheckpoints: number;
  /** Crystals those new checkpoints paid. */
  readonly checkpointCrystals: number;
  /** Crystals that went into the wallet: mined plus the checkpoint ones. */
  readonly crystalsEarned: number;
  /** True when this shift is the new best. */
  readonly record: boolean;
}

/**
 * Folds a finished shift into the profile: scrap and crystals into the wallet,
 * the depth reached into the checkpoints, the shift into the record. Nothing is
 * ever taken away — a breached shift simply brings less (PLAN_V1 §2).
 *
 * Every checkpoint pays its crystals once: they are counted from the depth that
 * was already open, so going down the same shaft again pays nothing.
 */
export function applyShiftResult(
  balance: Balance,
  profile: Profile,
  report: ShiftReport,
): ShiftOutcome {
  const quota = shiftQuota(balance, profile);
  const bonusScrap = quotaBonusScrap(balance, report.banked, quota);
  const scrapEarned = report.banked + bonusScrap;

  const deepestRow = Math.max(profile.deepestRow, report.deepestRow);
  const newCheckpoints = Math.max(
    0,
    checkpointsOpenAt(balance, deepestRow) - checkpointsOpenAt(balance, profile.deepestRow),
  );
  const checkpointCrystals = newCheckpoints * balance.shift.crystals_per_new_checkpoint;
  const crystalsEarned = report.crystals + checkpointCrystals;

  const scrap = scrapId(balance);
  const crystal = crystalId(balance);
  const wallet: Record<string, number> = { ...profile.wallet };
  wallet[scrap] = (wallet[scrap] ?? 0) + scrapEarned;
  wallet[crystal] = (wallet[crystal] ?? 0) + crystalsEarned;

  return {
    profile: {
      ...profile,
      wallet,
      deepestRow,
      // The record is what the shift handed over, without its own premium:
      // otherwise the plan would keep raising itself on the bonus it just paid.
      bestShiftScrap: Math.max(profile.bestShiftScrap, report.banked),
    },
    quota,
    bonusScrap,
    scrapEarned,
    newCheckpoints,
    checkpointCrystals,
    crystalsEarned,
    record: report.banked > profile.bestShiftScrap,
  };
}

/* --------------------------------------------------------------- save shape */

export function profileToSaved(profile: Profile): SavedProfile {
  return { version: SAVE_VERSION, ...profile };
}

function readNumber(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Reads a saved profile. Returns null when there is nothing usable — a foreign
 * version, a truncated file, something that is not an object at all — and the
 * caller starts a clean account. Anything readable is taken and clamped: an
 * unknown resource or branch is dropped, a broken number becomes zero. Never
 * throws, because a bad save must not cost the player the game.
 */
export function profileFromSaved(balance: Balance, raw: unknown): Profile | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  if (readNumber(source, 'version', -1) !== SAVE_VERSION) {
    return null;
  }

  const savedWallet = asRecord(source['wallet']);
  const wallet: Record<string, number> = {};
  for (const id of resourceIds(balance)) {
    wallet[id] = Math.max(0, Math.floor(readNumber(savedWallet, id, 0)));
  }

  const savedUpgrades = asRecord(source['upgrades']);
  const upgrades: Record<string, number> = {};
  for (const id of upgradeIds(balance)) {
    upgrades[id] = clampLevel(balance, id, readNumber(savedUpgrades, id, 0));
  }

  const deepestRow = Math.min(
    balance.shift.grid_depth,
    Math.max(ENTRANCE_ROW, Math.floor(readNumber(source, 'deepestRow', ENTRANCE_ROW))),
  );

  return {
    wallet,
    upgrades,
    deepestRow,
    bestShiftScrap: Math.max(0, Math.floor(readNumber(source, 'bestShiftScrap', 0))),
    fiveYearPlan: Math.max(1, Math.floor(readNumber(source, 'fiveYearPlan', 1))),
  };
}
