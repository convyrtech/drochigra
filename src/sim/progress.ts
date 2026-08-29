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
export const SAVE_VERSION = 2;

/**
 * Older schema versions this module still reads and migrates forward. A format
 * change must never cost the player what was already handed over (PLAN_V1 §2),
 * so version 1 — the one without the hangar visit stamp — is taken as is.
 */
const MIGRATABLE_VERSIONS: readonly number[] = [1];

/**
 * Units, not game numbers: the hangar is paid per hour and the clock outside
 * counts milliseconds. The numbers the hangar earns are in balance.offline.
 */
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;

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
  /** Five-year plan number. Grows when the bottom is reached; sets `planBalance`. */
  readonly fiveYearPlan: number;
  /**
   * When the player was last seen, in milliseconds since the epoch. The hangar
   * is paid for the stretch between this stamp and the next visit. src/sim never
   * reads a clock, so the value always arrives from outside as a parameter.
   */
  readonly lastVisitMs: number;
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
const HANGAR_ID = 'hangar';

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

/**
 * A fresh account: nothing bought, nothing earned, surface only. `nowMs` is the
 * moment the account is created, used as the first hangar stamp; it defaults to
 * zero because a fresh account has no depth, and without depth the hangar pays
 * nothing whatever the stamp says.
 */
export function createProfile(balance: Balance, nowMs = 0): Profile {
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
    lastVisitMs: Math.max(0, Math.floor(nowMs)),
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
 * fed to `createShift`), and the hangar pays offline only, which the shift never
 * sees — `hangarHarvest` applies its level between shifts.
 */
export function effectiveBalance(balance: Balance, upgrades: UpgradeLevels): Balance {
  const level = (id: string): number => clampLevel(balance, id, upgrades[id] ?? 0);
  const step = (id: string): number => upgradeItem(balance, id)?.step ?? 0;

  return {
    ...balance,
    drill: {
      ...balance.drill,
      speed_base: scaled(balance.drill.speed_base, step(DRILL_ID), level(DRILL_ID)),
      // The drill is one machine: a level of it makes the same motor dig and
      // drive faster. This is not decoration — it is what keeps «глубже
      // выгоднее» true at every drill level.
      //
      // A trip is `digging + road`, and the road grows with depth while the
      // digging does not. Speed up the digging alone and every trip converges
      // on its road, so the shallow layer — the one with almost no road — wins
      // on scrap per minute as soon as the drill is fast enough. Measured: at
      // twenty drill levels the first layer overtook the second. Scaling both
      // halves of the trip by the same number makes the ratio between layers
      // independent of the drill entirely.
      //
      // The elevator branch still tilts it, and in the right direction: it
      // shortens the road only, so it helps the deep layers most.
      move_rows_per_sec: scaled(
        scaled(balance.drill.move_rows_per_sec, step(ELEVATOR_ID), level(ELEVATOR_ID)),
        step(DRILL_ID),
        level(DRILL_ID),
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
    // The cargo branch moves the backpack and the ore it carries by the same
    // share, and that is the whole point of it (PLAN_V1 §7).
    //
    // How many cells fit one trip is `floor(capacity / yield)`, and a trip is
    // two decisions with one long silence between them (PLAN_V1 §2.6). Move the
    // capacity alone and that floor steps up — two cells become three — while
    // the drill only ever gets a few percent faster per level, so one purchase
    // stretches the silence by half and re-opens the hole this rule exists to
    // close. It is not a number that can be tuned away: the count of cells is an
    // integer and the drill's speed is a percentage.
    //
    // Moving both by the same share keeps `capacity / yield` where it was, so
    // the trip stays the same length at every level of the branch and the
    // upgrade pays in scrap instead of in the player's attention. It also makes
    // the hard wall of §5 — «карго не меньше самой дорогой клетки» —
    // self-enforcing at every level rather than at level zero only.
    //
    // «At every level» is the exact claim, and it is not «never»: this function
    // is handed the balance of a five-year plan, and a plan multiplies the ore
    // too (PLAN_V1 §5). The quotient survives that only because `planBalance`
    // scales the backpack by the very same factor — it did not, once, and the
    // second plan met the player with a mine that could not be dug at all.
    // Whatever bends the yield has to bend the cargo with it; this branch is one
    // such place and the plan is the other.
    //
    // The yield is rounded, not floored: it has to stay a whole number so the
    // HUD never prints «КАРГО: 70.125 / 102», and rounding keeps the ratio
    // closest to the one balance.json chose. That the ratio stays put — that
    // `floor(capacity / yield)` is the same at every level of the branch, in
    // every five-year plan — is not left to arithmetic goodwill: `npm run
    // measure` walks the levels inside several plans and checks it.
    layers: balance.layers.map((layer) => ({
      ...layer,
      yield: Math.round(scaled(layer.yield, step(CARGO_ID), level(CARGO_ID))),
    })),
  };
}

/** The conveyor: mined scrap goes straight to the bank, the drill never ascends. */
export function hasConveyor(profile: Profile): boolean {
  return upgradeLevel(profile, CONVEYOR_ID) > 0;
}

/* ------------------------------------------------------------ five-year plan */

/**
 * Tier of a five-year plan: how many times the bottom has been reached. The
 * first plan is tier 0 and multiplies nothing, so the balance measured in
 * PLAN_V1 §6 is exactly the balance of a new account.
 */
export function planTier(fiveYearPlan: number): number {
  if (!Number.isFinite(fiveYearPlan)) {
    return 0;
  }
  return Math.max(0, Math.floor(fiveYearPlan) - 1);
}

/**
 * The balance of a five-year plan (PLAN_V1 §5): every plan after the first one
 * pays `prestige.yield_mult_per_tier` more scrap per cell and sends waves
 * `prestige.wave_hp_mult_per_tier` tougher, both compounding per tier.
 *
 * Three numbers are bent, and each of them is one the plan is a promise about:
 * the yield of every layer, the cargo that carries it, and the base health of an
 * enemy. Hardness, crystal chance, wave timing and prices stay as they are — a
 * new plan is the same mine paying better against a heavier siege, not a
 * different game.
 *
 * The cargo rides with the yield for the same reason the cargo branch does
 * (`effectiveBalance` above): a trip is `floor(capacity / yield)` cells, and the
 * whole rhythm of §2.6 hangs off that integer. Double the ore and leave the
 * backpack alone, and the quotient collapses instead of drifting — at the
 * measured numbers the second plan takes the third layer from one cell a trip to
 * *zero*, which is not a slower game but a dead one: a cell that does not fit an
 * empty cargo can never be started, so the drill stands still for ever and the
 * reward for reaching the bottom is an unplayable mine. Scaling both by the same
 * factor keeps every trip exactly the length it was in the first plan and keeps
 * the hard wall of §5 — «карго не меньше самой дорогой клетки» — standing in
 * every plan, not only the first.
 *
 * Neither number is rounded here on purpose: the two are multiplied by one and
 * the same factor, so `capacity / yield` survives as exact arithmetic whatever
 * `yield_mult_per_tier` the owner puts in balance.json. The rounding that keeps
 * the HUD free of «КАРГО: 70.125 / 102» happens once, in `effectiveBalance`, on
 * top of whatever the plan handed it.
 */
export function planBalance(balance: Balance, fiveYearPlan: number): Balance {
  const tier = planTier(fiveYearPlan);
  if (tier === 0) {
    return balance;
  }
  const yieldMult = balance.prestige.yield_mult_per_tier ** tier;
  const hpMult = balance.prestige.wave_hp_mult_per_tier ** tier;
  return {
    ...balance,
    cargo: { ...balance.cargo, capacity_base: balance.cargo.capacity_base * yieldMult },
    layers: balance.layers.map((layer) => ({ ...layer, yield: layer.yield * yieldMult })),
    waves: { ...balance.waves, enemy_hp_base: balance.waves.enemy_hp_base * hpMult },
  };
}

/**
 * The balance everything about a profile runs on: the numbers of the plan the
 * player is in, bent by the levels bought.
 *
 * The plan goes first and the upgrades on top of it: an upgrade bends the
 * numbers of the plan the player is in, which is also how the base screen reads
 * to the player.
 *
 * The order is fixed rather than free. The two overlap on the backpack and the
 * ore — both scale `cargo.capacity_base` and `layers[].yield` — and scaling
 * commutes, so every number here would come out the same either way but one:
 * the yield is rounded to a whole scrap, and rounding does not commute with
 * multiplication (`round(33 · 1.25) · 2 = 82`, `round(33 · 2 · 1.25) = 83`).
 * Doing the plan first means the rounding happens once, at the end, on the
 * number the player is actually shown.
 */
export function shiftBalance(balance: Balance, profile: Profile): Balance {
  return effectiveBalance(planBalance(balance, profile.fiveYearPlan), profile.upgrades);
}

/** The bottom of the Abyss is dug: row `shift.grid_depth` has been reached. */
export function isBottomReached(balance: Balance, profile: Profile): boolean {
  return profile.deepestRow >= balance.shift.grid_depth;
}

/**
 * The city is found, the plan is closed, the next one starts (PLAN_V1 §5): the
 * mine is sealed back to the surface and everything the player owns stays.
 *
 * `bestShiftScrap` is kept on purpose. It is what the shift quota is a share of,
 * and nothing earned is ever taken away (PLAN_V1 §2.1): dropping it would hand
 * the first shift of a new plan the `quota_min` floor and a free premium, while
 * keeping it means the first shift is measured against real work — and with the
 * doubled yield the record is beaten again within a shift or two anyway.
 */
export function startNextPlan(profile: Profile): Profile {
  return {
    ...profile,
    fiveYearPlan: profile.fiveYearPlan + 1,
    // The shaft is fresh rock again, so the checkpoints close with it: the depth
    // is the whole point of a plan and it is what the new one is played for.
    deepestRow: ENTRANCE_ROW,
  };
}

/* ------------------------------------------------------------------- hangar */

/**
 * The hangar works while the game is closed (PLAN_V1 §7): it pays
 * `offline.scrap_per_hour_per_depth` per hour for every row the player has
 * personally reached, bent by the hangar branch, and it stops paying after
 * `offline.cap_hours`.
 *
 * It pays scrap and nothing else, ever: crystals, depth and open layers are what
 * a played shift is for (PLAN_V1 §2 rule 5). The clock lives outside src/sim, so
 * every function here is handed the current moment as `nowMs`.
 */
export interface HangarHarvest {
  /** Whole scrap waiting in the hangar. Zero when there is nothing to take. */
  readonly scrap: number;
  /** Hours the payment covers: the offline stretch cut down to `cap_hours`. */
  readonly hours: number;
  /** How full the hangar is, 0..1 — the bar on the base screen. */
  readonly fillShare: number;
}

/** What one hour of offline work is worth to this profile. */
export function hangarScrapPerHour(balance: Balance, profile: Profile): number {
  const level = clampLevel(balance, HANGAR_ID, upgradeLevel(profile, HANGAR_ID));
  const step = upgradeItem(balance, HANGAR_ID)?.step ?? 0;
  const depth = Math.max(0, profile.deepestRow);
  return scaled(balance.offline.scrap_per_hour_per_depth * depth, step, level);
}

/**
 * Hours the hangar is paid for. A stretch longer than the ceiling pays the
 * ceiling, and a clock moved backwards pays nothing instead of taking scrap away.
 */
function payableHours(balance: Balance, profile: Profile, nowMs: number): number {
  const cap = Math.max(0, balance.offline.cap_hours);
  const elapsedMs = nowMs - profile.lastVisitMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 0;
  }
  return Math.min(cap, elapsedMs / (MS_PER_SECOND * SECONDS_PER_HOUR));
}

/** What the hangar has waiting right now. Nothing is spent or moved by asking. */
export function hangarHarvest(balance: Balance, profile: Profile, nowMs: number): HangarHarvest {
  const cap = Math.max(0, balance.offline.cap_hours);
  const hours = payableHours(balance, profile, nowMs);
  return {
    // Rounded down: the hangar never hands over a fraction of a scrap.
    scrap: Math.floor(hangarScrapPerHour(balance, profile) * hours),
    hours,
    fillShare: cap > 0 ? Math.min(1, hours / cap) : 0,
  };
}

/** Marks the player as seen now, so the hangar is not paid for time spent playing. */
export function touchVisit(profile: Profile, nowMs: number): Profile {
  const stamp = Number.isFinite(nowMs) ? Math.max(0, Math.floor(nowMs)) : profile.lastVisitMs;
  return { ...profile, lastVisitMs: stamp };
}

/**
 * Takes what the hangar made: the scrap goes into the wallet and the visit stamp
 * moves to now, so the same hours are never paid twice. Only scrap is touched —
 * the crystal count and the depth reached come out exactly as they went in.
 */
export function collectHangar(
  balance: Balance,
  profile: Profile,
  nowMs: number,
): { readonly profile: Profile; readonly harvest: HangarHarvest } {
  const harvest = hangarHarvest(balance, profile, nowMs);
  const scrap = scrapId(balance);
  const collected = touchVisit(profile, nowMs);
  return {
    profile: {
      ...collected,
      wallet: { ...collected.wallet, [scrap]: walletAmount(collected, scrap) + harvest.scrap },
    },
    harvest,
  };
}

/* -------------------------------------------------------------- checkpoints */

/**
 * Every elevator checkpoint of the mine, shallowest first. Row 0 is the surface.
 *
 * Two ways to say it, and the second one exists for a reason. `checkpoint_rows`
 * lists the rows outright; `checkpoint_every_rows` spaces them evenly and is the
 * fallback when the list is absent.
 *
 * The list was added because evenly spaced checkpoints are what makes the arc
 * stall. A shift adds `старт + клеток` to the depth record, and the record only
 * moves when the shift out-digs the last one, so the player is pinned to a
 * checkpoint until the drill grows enough to cover the whole gap to the next.
 * How many cells a shift digs is not the same in every layer — deep cells are
 * dug one to a trip and shallow ones two — so one spacing cannot fit all three
 * layers, and whichever layer it fits worst becomes a plateau ten shifts long.
 * The screen holds seven chips (`src/ui/baseScreen.ts`), and it never cared
 * whether they were evenly spaced.
 */
export function checkpointRows(balance: Balance): number[] {
  const listed = balance.shift.checkpoint_rows;
  if (listed && listed.length > 0) {
    return listedCheckpoints(listed, balance.shift.grid_depth);
  }
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

/**
 * `shift.checkpoint_rows` as the rest of the game is allowed to assume it is:
 * whole rows, inside the mine, the surface first, no repeats, deepest last.
 *
 * The list is hand-written in balance.json by the owner of the game, who is
 * promised there («Правь смело») that the numbers are a slider and not a
 * contract, so it is this function's job to take a typo as a typo. Everything
 * downstream reads the result as a sorted ladder: `deepestOpenCheckpoint` takes
 * the last element, the base screen lays the chips left to right, and the
 * elevator drops the drill on the row it is handed. An unsorted list would put
 * the elevator somewhere in the middle of the ladder, a duplicate would draw two
 * identical chips, a negative row is not a row at all, and a row past
 * `grid_depth` is a chip that starts a shift outside the grid — `createShift`
 * throws on it, which reads to the player as a game that will not start.
 *
 * The even-spacing fallback above has always clipped itself to `grid_depth`; the
 * list gets the same treatment rather than a different one.
 *
 * Rows are floored, not dropped, so `24.5` still means the checkpoint the owner
 * was aiming at. The surface is always in: it is where a shift begins.
 */
function listedCheckpoints(listed: readonly number[], gridDepth: number): number[] {
  const kept = new Set<number>([ENTRANCE_ROW]);
  for (const row of listed) {
    if (!Number.isFinite(row)) {
      continue;
    }
    const whole = Math.floor(row);
    if (whole < ENTRANCE_ROW || whole > gridDepth) {
      continue;
    }
    kept.add(whole);
  }
  return [...kept].sort((left, right) => left - right);
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
 * Reads a saved profile. Returns null when there is nothing usable — a version
 * this build cannot read, a truncated file, something that is not an object at
 * all — and the caller starts a clean account. Anything readable is taken and
 * clamped: an unknown resource or branch is dropped, a broken number becomes
 * zero. Never throws, because a bad save must not cost the player the game.
 *
 * Older schemas are migrated instead of thrown away (PLAN_V1 §2 rule 1): a
 * version 1 save has everything but the hangar stamp, and the stamp it gets is
 * `nowMs` — the player is treated as arriving right now, so the format change
 * neither pays the hangar for the past nor takes anything away.
 */
export function profileFromSaved(balance: Balance, raw: unknown, nowMs = 0): Profile | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const version = readNumber(source, 'version', -1);
  if (version !== SAVE_VERSION && !MIGRATABLE_VERSIONS.includes(version)) {
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

  // A save without a usable stamp — version 1, or a version 2 file with a broken
  // or negative one — is stamped now: the hangar starts counting from this visit
  // instead of paying for everything since the epoch.
  const fallbackVisit = Math.max(0, Math.floor(Number.isFinite(nowMs) ? nowMs : 0));
  const savedVisit = Math.floor(readNumber(source, 'lastVisitMs', fallbackVisit));

  return {
    wallet,
    upgrades,
    deepestRow,
    bestShiftScrap: Math.max(0, Math.floor(readNumber(source, 'bestShiftScrap', 0))),
    fiveYearPlan: Math.max(1, Math.floor(readNumber(source, 'fiveYearPlan', 1))),
    lastVisitMs: savedVisit >= 0 ? savedVisit : fallbackVisit,
  };
}
