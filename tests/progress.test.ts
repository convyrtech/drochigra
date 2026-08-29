import { describe, expect, it } from 'vitest';
import balanceJson from '../content/balance.json' with { type: 'json' };
import type { Balance, UpgradeItemBalance } from '../src/sim/balance.js';
import {
  applyShiftResult,
  buyUpgrade,
  canBuyUpgrade,
  cheapestUpgrade,
  checkpointRows,
  collectHangar,
  createProfile,
  crystalId,
  deepestOpenCheckpoint,
  effectiveBalance,
  hangarHarvest,
  hangarScrapPerHour,
  hasConveyor,
  isCheckpointOpen,
  isBottomReached,
  isUpgradeMaxed,
  nextUpgrade,
  openCheckpointRows,
  planBalance,
  planTier,
  profileFromSaved,
  profileToSaved,
  quotaBonusScrap,
  quotaShare,
  resourceIds,
  SAVE_VERSION,
  scrapId,
  shiftBalance,
  shiftQuota,
  startNextPlan,
  touchVisit,
  upgradeCost,
  upgradeIds,
  upgradeLevel,
  upgradeMaxLevel,
  walletAmount,
  type Profile,
} from '../src/sim/progress.js';
import {
  aimDrill,
  canDig,
  createShift,
  ENTRANCE_ROW,
  step as stepShift,
  type ShiftEndReason,
  type ShiftReport,
} from '../src/sim/shift.js';

const balance = balanceJson as unknown as Balance;

/** The two currencies of the game, resolved from balance like the code does. */
const SCRAP = scrapId(balance);
const CRYSTAL = crystalId(balance);

/** Branch ids of balance.upgrades.items the rules below are about. */
const DRILL = 'drill';
const TURRET = 'turret';
const DOME = 'dome';
const CARGO = 'cargo';
const HANGAR = 'hangar';
const SALVO = 'salvo';
const ELEVATOR = 'elevator';
const CONVEYOR = 'conveyor';

/** One upgrade branch of balance.json. Tests read its numbers, never invent them. */
function item(id: string): UpgradeItemBalance {
  const found = balance.upgrades.items[id];
  if (!found) {
    throw new Error(`no upgrade "${id}" in balance`);
  }
  return found;
}

/** Balance variant. Tests bend single numbers, they never invent new ones. */
function balanceWith(patch: {
  checkpointEveryRows?: number;
  checkpointRows?: readonly number[];
  gridDepth?: number;
}): Balance {
  const rows = patch.checkpointRows ?? balance.shift.checkpoint_rows;
  return {
    ...balance,
    shift: {
      ...balance.shift,
      checkpoint_every_rows: patch.checkpointEveryRows ?? balance.shift.checkpoint_every_rows,
      ...(rows === undefined ? {} : { checkpoint_rows: rows }),
      grid_depth: patch.gridDepth ?? balance.shift.grid_depth,
    },
  };
}

/** A profile with a filled wallet and bought levels, built from a fresh one. */
function profileWith(patch: {
  wallet?: Record<string, number>;
  upgrades?: Record<string, number>;
  deepestRow?: number;
  bestShiftScrap?: number;
  fiveYearPlan?: number;
  lastVisitMs?: number;
}): Profile {
  const fresh = createProfile(balance);
  return {
    ...fresh,
    wallet: { ...fresh.wallet, ...patch.wallet },
    upgrades: { ...fresh.upgrades, ...patch.upgrades },
    deepestRow: patch.deepestRow ?? fresh.deepestRow,
    bestShiftScrap: patch.bestShiftScrap ?? fresh.bestShiftScrap,
    fiveYearPlan: patch.fiveYearPlan ?? fresh.fiveYearPlan,
    lastVisitMs: patch.lastVisitMs ?? fresh.lastVisitMs,
  };
}

/** A shift report, as src/sim/shift.ts hands it over. */
function report(patch: {
  mined?: number;
  banked?: number;
  deepestRow?: number;
  crystals?: number;
  endReason?: ShiftEndReason;
  waves?: number;
}): ShiftReport {
  const banked = patch.banked ?? 0;
  return {
    mined: patch.mined ?? banked,
    banked,
    deepestRow: patch.deepestRow ?? ENTRANCE_ROW,
    crystals: patch.crystals ?? 0,
    endReason: patch.endReason ?? 'timer',
    waves: patch.waves ?? 0,
  };
}

/** Buys a branch level with the wallet topped up to exactly the price. */
function buyOnce(profile: Profile, id: string): Profile {
  const next = nextUpgrade(balance, profile, id);
  expect(next).not.toBeNull();
  const funded = profileWith({
    wallet: { ...profile.wallet, [next?.currency ?? '']: next?.cost ?? 0 },
    upgrades: { ...profile.upgrades },
    deepestRow: profile.deepestRow,
    bestShiftScrap: profile.bestShiftScrap,
    fiveYearPlan: profile.fiveYearPlan,
  });
  const bought = buyUpgrade(balance, funded, id);
  if (!bought) {
    throw new Error(`could not buy "${id}"`);
  }
  return bought;
}

describe('resources', () => {
  it('takes the currency list from balance, scrap first and crystals premium', () => {
    expect(resourceIds(balance)).toEqual(Object.keys(balance.resources));
    expect(balance.resources[SCRAP]?.premium).toBe(false);
    expect(balance.resources[CRYSTAL]?.premium).toBe(true);
    expect(SCRAP).not.toBe(CRYSTAL);
  });
});

describe('createProfile', () => {
  it('opens an empty account with every resource and every branch at zero', () => {
    const profile = createProfile(balance);
    for (const id of resourceIds(balance)) {
      expect(walletAmount(profile, id)).toBe(0);
    }
    for (const id of upgradeIds(balance)) {
      expect(upgradeLevel(profile, id)).toBe(0);
    }
    expect(profile.deepestRow).toBe(ENTRANCE_ROW);
    expect(profile.bestShiftScrap).toBe(0);
    expect(profile.fiveYearPlan).toBe(1);
    expect(hasConveyor(profile)).toBe(false);
  });

  it('reads nothing for a resource or a branch balance does not list', () => {
    const profile = createProfile(balance);
    expect(walletAmount(profile, 'kraken')).toBe(0);
    expect(upgradeLevel(profile, 'kraken')).toBe(0);
  });
});

describe('upgrade prices', () => {
  it('charges cost_base for the first level of every branch', () => {
    const profile = createProfile(balance);
    for (const id of upgradeIds(balance)) {
      expect(upgradeCost(balance, id, 0)).toBe(item(id).cost_base);
      expect(nextUpgrade(balance, profile, id)).toEqual({
        currency: item(id).currency,
        cost: item(id).cost_base,
      });
    }
  });

  it('grows the price as cost_base * growth^level, rounded', () => {
    const growth = balance.upgrades.cost_growth;
    const base = item(DRILL).cost_base;
    for (const level of [0, 1, 2, 5, 10]) {
      expect(upgradeCost(balance, DRILL, level)).toBe(Math.round(base * growth ** level));
    }
    expect(upgradeCost(balance, DRILL, 1)).toBeGreaterThan(upgradeCost(balance, DRILL, 0));
  });

  it('lets the elevator carry its own cost_growth', () => {
    const own = item(ELEVATOR).cost_growth;
    expect(own).toBeDefined();
    expect(own).not.toBe(balance.upgrades.cost_growth);
    for (const level of [0, 1, 2, 4]) {
      expect(upgradeCost(balance, ELEVATOR, level)).toBe(
        Math.round(item(ELEVATOR).cost_base * (own ?? 1) ** level),
      );
    }
    // The rare branch climbs faster than a scrap one, that is what its growth is for.
    expect(upgradeCost(balance, ELEVATOR, 3) / item(ELEVATOR).cost_base).toBeGreaterThan(
      upgradeCost(balance, DRILL, 3) / item(DRILL).cost_base,
    );
  });

  it('asks nothing for a branch balance does not list', () => {
    expect(upgradeCost(balance, 'kraken', 0)).toBe(0);
    expect(nextUpgrade(balance, createProfile(balance), 'kraken')).toBeNull();
    expect(buyUpgrade(balance, createProfile(balance), 'kraken')).toBeNull();
  });

  it('bounds only the branches balance gives a max_level', () => {
    expect(upgradeMaxLevel(balance, SALVO)).toBe(item(SALVO).max_level);
    expect(upgradeMaxLevel(balance, CONVEYOR)).toBe(item(CONVEYOR).max_level);
    expect(upgradeMaxLevel(balance, DRILL)).toBe(Number.POSITIVE_INFINITY);
    expect(upgradeMaxLevel(balance, 'kraken')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('buying an upgrade', () => {
  it('takes the price out of the branch currency and leaves the other one alone', () => {
    const cost = upgradeCost(balance, DRILL, 0);
    const profile = profileWith({ wallet: { [SCRAP]: cost * 2, [CRYSTAL]: 7 } });
    expect(canBuyUpgrade(balance, profile, DRILL)).toBe(true);

    const bought = buyUpgrade(balance, profile, DRILL);
    expect(bought).not.toBeNull();
    expect(walletAmount(bought as Profile, SCRAP)).toBe(cost * 2 - cost);
    expect(walletAmount(bought as Profile, CRYSTAL)).toBe(7);
    expect(upgradeLevel(bought as Profile, DRILL)).toBe(1);
    // The profile handed in is not touched: the caller decides what to keep.
    expect(upgradeLevel(profile, DRILL)).toBe(0);
    expect(walletAmount(profile, SCRAP)).toBe(cost * 2);
  });

  it('pays the crystal branches with crystals, not with scrap', () => {
    const cost = upgradeCost(balance, ELEVATOR, 0);
    const scrapOnly = profileWith({ wallet: { [SCRAP]: cost * 1000 } });
    expect(canBuyUpgrade(balance, scrapOnly, ELEVATOR)).toBe(false);
    expect(buyUpgrade(balance, scrapOnly, ELEVATOR)).toBeNull();

    const withCrystals = profileWith({ wallet: { [CRYSTAL]: cost } });
    const bought = buyUpgrade(balance, withCrystals, ELEVATOR);
    expect(bought).not.toBeNull();
    expect(walletAmount(bought as Profile, CRYSTAL)).toBe(0);
    expect(walletAmount(bought as Profile, SCRAP)).toBe(0);
  });

  it('refuses when the wallet is one short and sells at exactly the price', () => {
    const cost = upgradeCost(balance, CARGO, 0);
    const short = profileWith({ wallet: { [SCRAP]: cost - 1 } });
    expect(canBuyUpgrade(balance, short, CARGO)).toBe(false);
    expect(buyUpgrade(balance, short, CARGO)).toBeNull();

    const exact = profileWith({ wallet: { [SCRAP]: cost } });
    expect(canBuyUpgrade(balance, exact, CARGO)).toBe(true);
    const bought = buyUpgrade(balance, exact, CARGO);
    expect(walletAmount(bought as Profile, SCRAP)).toBe(0);
    expect(upgradeLevel(bought as Profile, CARGO)).toBe(1);
  });

  it('charges the price of the level it is on, not the first one', () => {
    let profile = createProfile(balance);
    for (let level = 0; level < 3; level += 1) {
      expect(nextUpgrade(balance, profile, DRILL)?.cost).toBe(upgradeCost(balance, DRILL, level));
      profile = buyOnce(profile, DRILL);
      expect(upgradeLevel(profile, DRILL)).toBe(level + 1);
      expect(walletAmount(profile, SCRAP)).toBe(0);
    }
  });

  it('sells a bought-out branch nothing more, however full the wallet is', () => {
    const maxLevel = item(CONVEYOR).max_level ?? 0;
    const maxed = profileWith({
      wallet: { [CRYSTAL]: upgradeCost(balance, CONVEYOR, maxLevel) * 10 },
      upgrades: { [CONVEYOR]: maxLevel },
    });
    expect(isUpgradeMaxed(balance, maxed, CONVEYOR)).toBe(true);
    expect(nextUpgrade(balance, maxed, CONVEYOR)).toBeNull();
    expect(canBuyUpgrade(balance, maxed, CONVEYOR)).toBe(false);
    expect(buyUpgrade(balance, maxed, CONVEYOR)).toBeNull();
    // The conveyor is bought once and it works: the rule stays, only the price stops.
    expect(hasConveyor(maxed)).toBe(true);
  });

  it('stops the salvo branch on its max_level and no earlier', () => {
    const maxLevel = item(SALVO).max_level ?? 0;
    const lastOne = profileWith({ upgrades: { [SALVO]: maxLevel - 1 } });
    expect(isUpgradeMaxed(balance, lastOne, SALVO)).toBe(false);
    expect(nextUpgrade(balance, lastOne, SALVO)).not.toBeNull();

    const bought = buyOnce(lastOne, SALVO);
    expect(upgradeLevel(bought, SALVO)).toBe(maxLevel);
    expect(isUpgradeMaxed(balance, bought, SALVO)).toBe(true);
    expect(nextUpgrade(balance, bought, SALVO)).toBeNull();
  });
});

describe('the next purchase is always close (PLAN_V1 §2.4)', () => {
  it('offers something on a fresh profile, and it is the cheapest of the branches', () => {
    const profile = createProfile(balance);
    const cheapest = cheapestUpgrade(balance, profile);
    expect(cheapest).not.toBeNull();

    const costs = upgradeIds(balance).map((id) => nextUpgrade(balance, profile, id)?.cost ?? 0);
    expect(cheapest?.cost).toBe(Math.min(...costs));
    expect(cheapest?.currency).toBe(item(cheapest?.id ?? '').currency);
    // Six scrap branches keep something cheap on offer at any level.
    expect(costs.length).toBe(upgradeIds(balance).length);
  });

  it('goes on offering something after the cheapest branch has been bought', () => {
    let profile = createProfile(balance);
    for (let step = 0; step < 10; step += 1) {
      const cheapest = cheapestUpgrade(balance, profile);
      expect(cheapest).not.toBeNull();
      profile = buyOnce(profile, cheapest?.id ?? '');
    }
    expect(cheapestUpgrade(balance, profile)).not.toBeNull();
  });

  it('skips a bought-out branch and offers the next cheapest one', () => {
    const conveyorCost = upgradeCost(balance, CONVEYOR, 0);
    const maxed = profileWith({ upgrades: { [CONVEYOR]: item(CONVEYOR).max_level ?? 0 } });
    const cheapest = cheapestUpgrade(balance, maxed);
    expect(cheapest?.id).not.toBe(CONVEYOR);
    expect(cheapest?.cost).toBeLessThanOrEqual(conveyorCost);
  });

  it('offers nothing when every branch balance lists is bought out', () => {
    const capped: Balance = {
      ...balance,
      upgrades: {
        ...balance.upgrades,
        items: { [SALVO]: item(SALVO), [CONVEYOR]: item(CONVEYOR) },
      },
    };
    const maxed = profileWith({
      upgrades: {
        [SALVO]: item(SALVO).max_level ?? 0,
        [CONVEYOR]: item(CONVEYOR).max_level ?? 0,
      },
    });
    expect(cheapestUpgrade(capped, maxed)).toBeNull();
  });
});

describe('effectiveBalance', () => {
  it('changes nothing on a fresh profile', () => {
    const fresh = effectiveBalance(balance, createProfile(balance).upgrades);
    expect(fresh.drill.speed_base).toBeCloseTo(balance.drill.speed_base, 10);
    expect(fresh.drill.move_rows_per_sec).toBeCloseTo(balance.drill.move_rows_per_sec, 10);
    expect(fresh.turret.dps_base).toBeCloseTo(balance.turret.dps_base, 10);
    expect(fresh.turret.salvo_cooldown_sec).toBeCloseTo(balance.turret.salvo_cooldown_sec, 10);
    expect(fresh.dome.hp_base).toBeCloseTo(balance.dome.hp_base, 10);
    expect(fresh.cargo.capacity_base).toBeCloseTo(balance.cargo.capacity_base, 10);
    // Everything the levels do not touch is the balance that was passed in.
    // The layers are rebuilt, not passed through — the cargo branch moves the
    // yield with the capacity (see effectiveBalance) — so they are compared by
    // value, and at level zero the value has to be the same.
    expect(fresh.layers).toEqual(balance.layers);
    expect(fresh.shift).toBe(balance.shift);
    expect(fresh.waves).toBe(balance.waves);
    expect(fresh.upgrades).toBe(balance.upgrades);
  });

  it('bends both halves of the drill — digging and driving — by the drill step', () => {
    // One machine, one number: a drill level speeds the digging and the road by
    // the same share. Without that, a fast drill quietly makes the shallow layer
    // the richest one, because only the shallow layer has almost no road — see
    // the comment in effectiveBalance.
    const step = item(DRILL).step;
    for (const level of [1, 3, 7]) {
      const bent = effectiveBalance(balance, { [DRILL]: level });
      expect(bent.drill.speed_base).toBeCloseTo(balance.drill.speed_base * (1 + step * level), 10);
      expect(bent.drill.move_rows_per_sec).toBeCloseTo(
        balance.drill.move_rows_per_sec * (1 + step * level),
        10,
      );
      expect(bent.cargo.capacity_base).toBeCloseTo(balance.cargo.capacity_base, 10);
      expect(bent.turret.dps_base).toBeCloseTo(balance.turret.dps_base, 10);
      // The ore is the cargo branch's business, not the drill's.
      expect(bent.layers).toEqual(balance.layers);
    }
  });

  it('bends the ore with the backpack: the cargo branch moves both', () => {
    // The rule PLAN_V1 §2.6 rests on: how many cells fit one trip is
    // `floor(capacity / yield)`, and a purchase that changes it changes the
    // silence between two decisions by a whole cell.
    const step = item(CARGO).step;
    for (const level of [1, 5, 17]) {
      const bent = effectiveBalance(balance, { [CARGO]: level });
      const share = 1 + step * level;
      expect(bent.cargo.capacity_base).toBeCloseTo(balance.cargo.capacity_base * share, 10);
      bent.layers.forEach((layer, index) => {
        const base = balance.layers[index]?.yield ?? 0;
        expect(layer.yield).toBe(Math.round(base * share));
        expect(Math.floor(bent.cargo.capacity_base / layer.yield)).toBe(
          Math.floor(balance.cargo.capacity_base / base),
        );
      });
    }
  });

  it('bends the turret damage by the turret step', () => {
    const step = item(TURRET).step;
    const bent = effectiveBalance(balance, { [TURRET]: 4 });
    expect(bent.turret.dps_base).toBeCloseTo(balance.turret.dps_base * (1 + step * 4), 10);
    expect(bent.turret.salvo_cooldown_sec).toBeCloseTo(balance.turret.salvo_cooldown_sec, 10);
    expect(bent.dome.hp_base).toBeCloseTo(balance.dome.hp_base, 10);
  });

  it('adds the dome step to the dome health flat, not as a share', () => {
    const step = item(DOME).step;
    const bent = effectiveBalance(balance, { [DOME]: 3 });
    expect(bent.dome.hp_base).toBeCloseTo(balance.dome.hp_base + step * 3, 10);
  });

  it('bends the cargo capacity by the cargo step', () => {
    const step = item(CARGO).step;
    const bent = effectiveBalance(balance, { [CARGO]: 2 });
    expect(bent.cargo.capacity_base).toBeCloseTo(balance.cargo.capacity_base * (1 + step * 2), 10);
  });

  it('bends the travel speed of the drill by the elevator step, not the dig speed', () => {
    const step = item(ELEVATOR).step;
    const bent = effectiveBalance(balance, { [ELEVATOR]: 2 });
    expect(bent.drill.move_rows_per_sec).toBeCloseTo(
      balance.drill.move_rows_per_sec * (1 + step * 2),
      10,
    );
    expect(bent.drill.speed_base).toBeCloseTo(balance.drill.speed_base, 10);
  });

  it('cuts the salvo cooldown by a negative step and never goes below zero', () => {
    const step = item(SALVO).step;
    expect(step).toBeLessThan(0);
    const maxLevel = item(SALVO).max_level ?? 0;

    const bent = effectiveBalance(balance, { [SALVO]: maxLevel });
    expect(bent.turret.salvo_cooldown_sec).toBeCloseTo(
      balance.turret.salvo_cooldown_sec + step * maxLevel,
      10,
    );
    expect(bent.turret.salvo_cooldown_sec).toBeLessThan(balance.turret.salvo_cooldown_sec);

    // A cheap enough cooldown would go negative on the step alone: it stops at zero.
    const shortCooldown: Balance = {
      ...balance,
      turret: { ...balance.turret, salvo_cooldown_sec: 1 },
    };
    expect(effectiveBalance(shortCooldown, { [SALVO]: maxLevel }).turret.salvo_cooldown_sec).toBe(0);
  });

  it('leaves every number alone for the hangar and the conveyor', () => {
    const fresh = effectiveBalance(balance, {});
    for (const id of [HANGAR, CONVEYOR]) {
      const bent = effectiveBalance(balance, { [id]: item(id).max_level ?? 5 });
      expect(bent.drill).toEqual(fresh.drill);
      expect(bent.turret).toEqual(fresh.turret);
      expect(bent.dome).toEqual(fresh.dome);
      expect(bent.cargo).toEqual(fresh.cargo);
    }
  });

  it('ignores levels above max_level, broken numbers and unknown branches', () => {
    const maxLevel = item(SALVO).max_level ?? 0;
    const overMax = effectiveBalance(balance, { [SALVO]: maxLevel + 100 });
    expect(overMax.turret.salvo_cooldown_sec).toBeCloseTo(
      effectiveBalance(balance, { [SALVO]: maxLevel }).turret.salvo_cooldown_sec,
      10,
    );

    const fresh = effectiveBalance(balance, {});
    for (const level of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const broken = effectiveBalance(balance, { [DRILL]: level, [CARGO]: level });
      expect(broken.drill.speed_base).toBeCloseTo(fresh.drill.speed_base, 10);
      expect(broken.cargo.capacity_base).toBeCloseTo(fresh.cargo.capacity_base, 10);
    }
    expect(effectiveBalance(balance, { kraken: 9 }).drill).toEqual(fresh.drill);
  });
});

describe('hasConveyor', () => {
  it('is off until the branch is bought and on from the first level', () => {
    expect(hasConveyor(createProfile(balance))).toBe(false);
    expect(hasConveyor(profileWith({ upgrades: { [CONVEYOR]: 1 } }))).toBe(true);
  });
});

/** The same balance with the explicit checkpoint list dropped, so the even
 *  spacing of `checkpoint_every_rows` is what answers. */
function withoutCheckpointList(from: Balance): Balance {
  const { checkpoint_rows: _dropped, ...shift } = from.shift;
  return { ...from, shift };
}

describe('checkpoints', () => {
  it('starts on the surface, climbs down in order and never leaves the grid', () => {
    // The rows themselves are a balance decision — evenly spaced or listed one
    // by one (`shift.checkpoint_rows`), whichever fits the layers — so the test
    // holds the shape and not the spacing.
    const rows = checkpointRows(balance);
    expect(rows[0]).toBe(ENTRANCE_ROW);
    expect(rows.length).toBeGreaterThan(1);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index]).toBeGreaterThan(rows[index - 1] ?? 0);
    }
    expect(rows[rows.length - 1]).toBeLessThanOrEqual(balance.shift.grid_depth);
  });

  it('takes a hand-written list as it comes: sorted, deduplicated, inside the mine', () => {
    // balance.json is edited by hand and promises «правь смело», so the list is
    // taken as an intent and not as a contract. Everything downstream reads the
    // result as a ladder — the elevator drops on the last row, the base screen
    // draws the chips in order — so a typo has to be repaired here or it becomes
    // a game that starts a shift outside the grid.
    expect(checkpointRows(balanceWith({ checkpointRows: [-5, 0, 24] }))).toEqual([0, 24]);
    expect(checkpointRows(balanceWith({ checkpointRows: [24, 0, 12, 24] }))).toEqual([0, 12, 24]);
    expect(checkpointRows(balanceWith({ checkpointRows: [12, 24] }))).toEqual([0, 12, 24]);
    // Deeper than the grid is a chip that cannot be started, so it is clipped —
    // exactly what the even-spacing branch below has always done.
    const shallow = balanceWith({ checkpointRows: [0, 24, 999], gridDepth: 48 });
    expect(checkpointRows(shallow)).toEqual([0, 24]);
    // A fractional row still means the row the owner was aiming at.
    expect(checkpointRows(balanceWith({ checkpointRows: [24.5, 24] }))).toEqual([0, 24]);
    // Nothing usable in the list still leaves a mine that can be entered.
    expect(checkpointRows(balanceWith({ checkpointRows: [-1, Number.NaN] }))).toEqual([0]);
  });

  it('spaces them evenly when balance gives a step instead of a list', () => {
    const every = 7;
    const even = balanceWith({ checkpointEveryRows: every });
    const rows = checkpointRows(withoutCheckpointList(even));
    expect(rows[0]).toBe(ENTRANCE_ROW);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index]).toBe(ENTRANCE_ROW + every * index);
    }
    expect((rows[rows.length - 1] ?? 0) + every).toBeGreaterThan(even.shift.grid_depth);
  });

  it('keeps the surface only when balance switches the checkpoints off', () => {
    const off = balanceWith({ checkpointEveryRows: 0 });
    expect(checkpointRows(withoutCheckpointList(off))).toEqual([ENTRANCE_ROW]);
  });

  it('opens a checkpoint only once the player has dug that deep', () => {
    const every = checkpointRows(balance)[1] ?? 0;
    const shallow = profileWith({ deepestRow: every - 1 });
    expect(isCheckpointOpen(shallow, ENTRANCE_ROW)).toBe(true);
    expect(isCheckpointOpen(shallow, every)).toBe(false);
    expect(openCheckpointRows(balance, shallow)).toEqual([ENTRANCE_ROW]);
    expect(deepestOpenCheckpoint(balance, shallow)).toBe(ENTRANCE_ROW);

    // Standing exactly on the checkpoint row is enough to open it.
    const reached = profileWith({ deepestRow: every });
    expect(isCheckpointOpen(reached, every)).toBe(true);
    expect(openCheckpointRows(balance, reached)).toEqual([ENTRANCE_ROW, every]);
    expect(deepestOpenCheckpoint(balance, reached)).toBe(every);
  });

  it('opens every checkpoint above the depth reached, not just the deepest one', () => {
    const ladder = checkpointRows(balance);
    const deep = profileWith({ deepestRow: (ladder[3] ?? 0) + 1 });
    expect(openCheckpointRows(balance, deep)).toEqual([
      ENTRANCE_ROW,
      ladder[1] ?? 0,
      ladder[2] ?? 0,
      ladder[3] ?? 0,
    ]);
    expect(deepestOpenCheckpoint(balance, deep)).toBe(ladder[3] ?? 0);
  });

  it('opens the bottom checkpoint for a profile that reached the bottom', () => {
    const bottom = profileWith({ deepestRow: balance.shift.grid_depth });
    expect(openCheckpointRows(balance, bottom)).toEqual(checkpointRows(balance));
    expect(deepestOpenCheckpoint(balance, bottom)).toBe(
      checkpointRows(balance)[checkpointRows(balance).length - 1],
    );
  });
});

describe('the shift quota', () => {
  it('never asks for less than quota_min', () => {
    expect(shiftQuota(balance, createProfile(balance))).toBe(balance.shift.quota_min);
    const tiny = profileWith({ bestShiftScrap: 1 });
    expect(shiftQuota(balance, tiny)).toBe(balance.shift.quota_min);
  });

  it('asks for a share of the best shift once that share is the bigger number', () => {
    const share = balance.shift.quota_share_of_best;
    const best = Math.ceil(balance.shift.quota_min / share) * 4;
    const profile = profileWith({ bestShiftScrap: best });
    expect(shiftQuota(balance, profile)).toBe(Math.round(best * share));
    expect(shiftQuota(balance, profile)).toBeGreaterThan(balance.shift.quota_min);
  });

  it('measures the share of the plan a shift covered', () => {
    const quota = balance.shift.quota_min;
    expect(quotaShare(0, quota)).toBe(0);
    expect(quotaShare(quota / 2, quota)).toBeCloseTo(0.5, 10);
    expect(quotaShare(quota, quota)).toBe(1);
    expect(quotaShare(quota * 2, quota)).toBe(2);
    // No plan means the plan is done: the report never shows a division by zero.
    expect(quotaShare(0, 0)).toBe(1);
  });

  it('pays the premium only for meeting the plan', () => {
    const bonus = balance.shift.quota_bonus;
    const quota = balance.shift.quota_min;
    expect(quotaBonusScrap(balance, quota - 1, quota)).toBe(0);
    expect(quotaBonusScrap(balance, quota, quota)).toBe(Math.round(quota * bonus));
    expect(quotaBonusScrap(balance, quota * 3, quota)).toBe(Math.round(quota * 3 * bonus));
  });
});

describe('applyShiftResult', () => {
  it('puts what was handed over plus the premium into the wallet', () => {
    const profile = createProfile(balance);
    const quota = shiftQuota(balance, profile);
    const banked = quota * 2;
    const outcome = applyShiftResult(balance, profile, report({ banked }));

    expect(outcome.quota).toBe(quota);
    expect(outcome.bonusScrap).toBe(Math.round(banked * balance.shift.quota_bonus));
    expect(outcome.scrapEarned).toBe(banked + outcome.bonusScrap);
    expect(walletAmount(outcome.profile, SCRAP)).toBe(outcome.scrapEarned);
  });

  it('pays no premium for a shift that missed the plan', () => {
    const profile = createProfile(balance);
    const banked = shiftQuota(balance, profile) - 1;
    const outcome = applyShiftResult(balance, profile, report({ banked }));
    expect(outcome.bonusScrap).toBe(0);
    expect(outcome.scrapEarned).toBe(banked);
  });

  it('adds the mined crystals to the wallet and keeps the scrap apart', () => {
    const profile = profileWith({ wallet: { [SCRAP]: 10, [CRYSTAL]: 2 } });
    const outcome = applyShiftResult(balance, profile, report({ banked: 0, crystals: 3 }));
    expect(outcome.crystalsEarned).toBe(3);
    expect(walletAmount(outcome.profile, CRYSTAL)).toBe(2 + 3);
    expect(walletAmount(outcome.profile, SCRAP)).toBe(10);
  });

  it('pays the crystals of a new checkpoint once and never again', () => {
    // Two checkpoints down, wherever balance puts them: the ladder may be
    // uneven, so the rows come out of it instead of being multiplied.
    const ladder = checkpointRows(balance);
    const second = ladder[2] ?? 0;
    const third = ladder[3] ?? 0;
    const perCheckpoint = balance.shift.crystals_per_new_checkpoint;
    const fresh = createProfile(balance);

    // First trip down to the second checkpoint: two rows opened, two payments.
    const first = applyShiftResult(balance, fresh, report({ deepestRow: second }));
    expect(first.newCheckpoints).toBe(2);
    expect(first.checkpointCrystals).toBe(2 * perCheckpoint);
    expect(walletAmount(first.profile, CRYSTAL)).toBe(2 * perCheckpoint);
    expect(first.profile.deepestRow).toBe(second);

    // Down the same shaft again: nothing new is open, so nothing is paid.
    const again = applyShiftResult(balance, first.profile, report({ deepestRow: second }));
    expect(again.newCheckpoints).toBe(0);
    expect(again.checkpointCrystals).toBe(0);
    expect(walletAmount(again.profile, CRYSTAL)).toBe(2 * perCheckpoint);

    // One checkpoint deeper: only that one pays.
    const deeper = applyShiftResult(balance, again.profile, report({ deepestRow: third }));
    expect(deeper.newCheckpoints).toBe(1);
    expect(walletAmount(deeper.profile, CRYSTAL)).toBe(3 * perCheckpoint);
  });

  it('pays nothing extra for rows between two checkpoints', () => {
    const every = balance.shift.checkpoint_every_rows;
    const outcome = applyShiftResult(balance, createProfile(balance), report({ deepestRow: every - 1 }));
    expect(outcome.newCheckpoints).toBe(0);
    expect(outcome.checkpointCrystals).toBe(0);
    expect(outcome.profile.deepestRow).toBe(every - 1);
  });

  it('remembers the deepest row ever reached, not the last one', () => {
    const deep = applyShiftResult(balance, createProfile(balance), report({ deepestRow: 12 }));
    expect(deep.profile.deepestRow).toBe(12);
    const shallow = applyShiftResult(balance, deep.profile, report({ deepestRow: 3 }));
    expect(shallow.profile.deepestRow).toBe(12);
    expect(shallow.newCheckpoints).toBe(0);
  });

  it('records the scrap handed over, without the premium it just paid', () => {
    const profile = createProfile(balance);
    const banked = shiftQuota(balance, profile) * 3;
    const outcome = applyShiftResult(balance, profile, report({ banked }));
    expect(outcome.record).toBe(true);
    expect(outcome.bonusScrap).toBeGreaterThan(0);
    expect(outcome.profile.bestShiftScrap).toBe(banked);
    // The plan is measured against the record, so a premium must not raise it.
    expect(shiftQuota(balance, outcome.profile)).toBe(
      Math.round(banked * balance.shift.quota_share_of_best),
    );
  });

  it('keeps the old record when the shift did not beat it', () => {
    const best = profileWith({ bestShiftScrap: 1000 });
    const outcome = applyShiftResult(balance, best, report({ banked: 999 }));
    expect(outcome.record).toBe(false);
    expect(outcome.profile.bestShiftScrap).toBe(1000);

    const tie = applyShiftResult(balance, best, report({ banked: 1000 }));
    expect(tie.record).toBe(false);
    expect(tie.profile.bestShiftScrap).toBe(1000);
  });
});

describe('a shift never takes anything away (PLAN_V1 §2.1)', () => {
  it('leaves the wallet, the levels, the record and the depth whole after a breach', () => {
    const rich = profileWith({
      wallet: { [SCRAP]: 5000, [CRYSTAL]: 9 },
      upgrades: { [DRILL]: 4, [CARGO]: 2, [ELEVATOR]: 1 },
      deepestRow: 17,
      bestShiftScrap: 900,
      fiveYearPlan: 2,
    });
    // The worst shift there is: the dome fell with an empty bank and no depth.
    const outcome = applyShiftResult(
      balance,
      rich,
      report({ mined: 400, banked: 0, deepestRow: 2, crystals: 0, endReason: 'breach' }),
    );

    expect(walletAmount(outcome.profile, SCRAP)).toBe(5000);
    expect(walletAmount(outcome.profile, CRYSTAL)).toBe(9);
    expect(outcome.profile.upgrades).toEqual(rich.upgrades);
    expect(outcome.profile.deepestRow).toBe(17);
    expect(outcome.profile.bestShiftScrap).toBe(900);
    expect(outcome.profile.fiveYearPlan).toBe(2);
    expect(outcome.scrapEarned).toBe(0);
    expect(outcome.crystalsEarned).toBe(0);
    expect(outcome.record).toBe(false);
  });

  it('adds something for a breached shift that still handed scrap over and dug deeper', () => {
    // Deep enough to open a checkpoint, wherever balance puts them: the point
    // is that a breach still pays for the depth it reached.
    const deeper = balance.shift.checkpoint_every_rows * 2;
    const before = profileWith({ wallet: { [SCRAP]: 100 }, deepestRow: 1, bestShiftScrap: 50 });
    const outcome = applyShiftResult(
      balance,
      before,
      report({ mined: 800, banked: 300, deepestRow: deeper, crystals: 2, endReason: 'breach' }),
    );
    expect(walletAmount(outcome.profile, SCRAP)).toBeGreaterThan(100);
    expect(walletAmount(outcome.profile, CRYSTAL)).toBeGreaterThan(2);
    expect(outcome.profile.deepestRow).toBe(deeper);
    expect(outcome.profile.bestShiftScrap).toBe(300);
  });

  it('never lowers a number of the profile, over a run of random-looking shifts', () => {
    let profile = createProfile(balance);
    const shifts: readonly ShiftReport[] = [
      report({ banked: 300, deepestRow: 6, crystals: 0 }),
      report({ banked: 0, deepestRow: 1, endReason: 'breach' }),
      report({ banked: 120, deepestRow: 14, crystals: 3, endReason: 'breach' }),
      report({ banked: 900, deepestRow: 11 }),
      report({ banked: 40, deepestRow: 22, crystals: 1 }),
      report({ banked: 0, deepestRow: 0, endReason: 'breach' }),
    ];
    for (const shift of shifts) {
      const before = profile;
      const outcome = applyShiftResult(balance, before, shift);
      profile = outcome.profile;
      expect(walletAmount(profile, SCRAP)).toBeGreaterThanOrEqual(walletAmount(before, SCRAP));
      expect(walletAmount(profile, CRYSTAL)).toBeGreaterThanOrEqual(walletAmount(before, CRYSTAL));
      expect(profile.deepestRow).toBeGreaterThanOrEqual(before.deepestRow);
      expect(profile.bestShiftScrap).toBeGreaterThanOrEqual(before.bestShiftScrap);
      expect(profile.upgrades).toEqual(before.upgrades);
    }
  });
});

describe('profileToSaved', () => {
  it('writes the schema version next to the profile it was given', () => {
    const profile = profileWith({
      wallet: { [SCRAP]: 120, [CRYSTAL]: 4 },
      upgrades: { [DRILL]: 2 },
      deepestRow: 15,
      bestShiftScrap: 640,
      fiveYearPlan: 3,
    });
    const saved = profileToSaved(profile);
    expect(saved.version).toBe(SAVE_VERSION);
    expect(saved.wallet).toEqual(profile.wallet);
    expect(saved.upgrades).toEqual(profile.upgrades);
    expect(saved.deepestRow).toBe(15);
    expect(saved.bestShiftScrap).toBe(640);
    expect(saved.fiveYearPlan).toBe(3);
  });
});

describe('profileFromSaved', () => {
  it('reads back exactly what was written', () => {
    const profile = profileWith({
      wallet: { [SCRAP]: 1234, [CRYSTAL]: 7 },
      upgrades: { [DRILL]: 3, [CARGO]: 1, [SALVO]: 2, [CONVEYOR]: 1 },
      deepestRow: 20,
      bestShiftScrap: 810,
      fiveYearPlan: 2,
    });
    const loaded = profileFromSaved(balance, profileToSaved(profile));
    expect(loaded).toEqual(profile);
  });

  it('survives the trip through JSON, which is how it is really stored', () => {
    const profile = profileWith({
      wallet: { [SCRAP]: 99, [CRYSTAL]: 1 },
      upgrades: { [TURRET]: 5 },
      deepestRow: 9,
      bestShiftScrap: 300,
    });
    const raw = JSON.stringify(profileToSaved(profile));
    expect(profileFromSaved(balance, JSON.parse(raw))).toEqual(profile);
  });

  it('refuses a save written by another version', () => {
    const saved = profileToSaved(createProfile(balance));
    expect(profileFromSaved(balance, { ...saved, version: SAVE_VERSION + 1 })).toBeNull();
    expect(profileFromSaved(balance, { ...saved, version: String(SAVE_VERSION) })).toBeNull();
    const { version: _version, ...noVersion } = saved;
    expect(profileFromSaved(balance, noVersion)).toBeNull();
    // Version 1 is not foreign, it is the previous schema: it is migrated, see
    // the "migration from version 1" block below.
    expect(profileFromSaved(balance, { ...saved, version: SAVE_VERSION - 2 })).toBeNull();
  });

  it('refuses anything that is not an object', () => {
    for (const raw of [null, undefined, 0, 1, '', 'vostok9', true, Number.NaN]) {
      expect(profileFromSaved(balance, raw)).toBeNull();
    }
  });

  it('takes a readable save even when the wallet or the upgrades are rubbish', () => {
    const broken = profileFromSaved(balance, {
      version: SAVE_VERSION,
      wallet: 'all of it',
      upgrades: 42,
      deepestRow: 'deep',
      bestShiftScrap: null,
      fiveYearPlan: [],
    });
    expect(broken).toEqual(createProfile(balance));
  });

  it('drops a resource and a branch balance does not list', () => {
    const loaded = profileFromSaved(balance, {
      version: SAVE_VERSION,
      wallet: { [SCRAP]: 10, gold: 500 },
      upgrades: { [DRILL]: 1, kraken: 9 },
      deepestRow: 0,
      bestShiftScrap: 0,
      fiveYearPlan: 1,
    });
    expect(Object.keys(loaded?.wallet ?? {})).toEqual(resourceIds(balance));
    expect(Object.keys(loaded?.upgrades ?? {})).toEqual(upgradeIds(balance));
    expect(walletAmount(loaded as Profile, SCRAP)).toBe(10);
    expect(upgradeLevel(loaded as Profile, DRILL)).toBe(1);
    expect(walletAmount(loaded as Profile, 'gold')).toBe(0);
    expect(upgradeLevel(loaded as Profile, 'kraken')).toBe(0);
  });

  it('clamps a level above max_level down to what the branch allows', () => {
    const loaded = profileFromSaved(balance, {
      version: SAVE_VERSION,
      wallet: {},
      upgrades: { [SALVO]: 999, [CONVEYOR]: 999, [DRILL]: 7 },
      deepestRow: 0,
      bestShiftScrap: 0,
      fiveYearPlan: 1,
    });
    expect(upgradeLevel(loaded as Profile, SALVO)).toBe(item(SALVO).max_level);
    expect(upgradeLevel(loaded as Profile, CONVEYOR)).toBe(item(CONVEYOR).max_level);
    // A branch without a max_level keeps whatever it had.
    expect(upgradeLevel(loaded as Profile, DRILL)).toBe(7);
  });

  it('turns negative and broken numbers into zero', () => {
    const loaded = profileFromSaved(balance, {
      version: SAVE_VERSION,
      wallet: { [SCRAP]: -100, [CRYSTAL]: Number.NaN },
      upgrades: { [DRILL]: -3, [CARGO]: Number.NaN, [TURRET]: Number.POSITIVE_INFINITY },
      deepestRow: -8,
      bestShiftScrap: -50,
      fiveYearPlan: -1,
    });
    expect(walletAmount(loaded as Profile, SCRAP)).toBe(0);
    expect(walletAmount(loaded as Profile, CRYSTAL)).toBe(0);
    expect(upgradeLevel(loaded as Profile, DRILL)).toBe(0);
    expect(upgradeLevel(loaded as Profile, CARGO)).toBe(0);
    expect(upgradeLevel(loaded as Profile, TURRET)).toBe(0);
    expect(loaded?.deepestRow).toBe(ENTRANCE_ROW);
    expect(loaded?.bestShiftScrap).toBe(0);
    // The five-year plan is counted from one, there is no plan zero.
    expect(loaded?.fiveYearPlan).toBe(1);
  });

  it('rounds fractional amounts and levels down', () => {
    const loaded = profileFromSaved(balance, {
      version: SAVE_VERSION,
      wallet: { [SCRAP]: 10.9, [CRYSTAL]: 2.5 },
      upgrades: { [DRILL]: 2.9 },
      deepestRow: 7.8,
      bestShiftScrap: 300.7,
      fiveYearPlan: 2.9,
    });
    expect(walletAmount(loaded as Profile, SCRAP)).toBe(10);
    expect(walletAmount(loaded as Profile, CRYSTAL)).toBe(2);
    expect(upgradeLevel(loaded as Profile, DRILL)).toBe(2);
    expect(loaded?.deepestRow).toBe(7);
    expect(loaded?.bestShiftScrap).toBe(300);
    expect(loaded?.fiveYearPlan).toBe(2);
  });

  it('holds the depth inside the mine', () => {
    const deeper = profileFromSaved(balance, {
      version: SAVE_VERSION,
      deepestRow: balance.shift.grid_depth + 100,
    });
    expect(deeper?.deepestRow).toBe(balance.shift.grid_depth);
    // A save from a deeper mine must not open checkpoints that do not exist.
    expect(deepestOpenCheckpoint(balance, deeper as Profile)).toBeLessThanOrEqual(
      balance.shift.grid_depth,
    );

    const bottom = profileFromSaved(balance, {
      version: SAVE_VERSION,
      deepestRow: balance.shift.grid_depth,
    });
    expect(bottom?.deepestRow).toBe(balance.shift.grid_depth);
  });

  it('never throws, whatever the save looks like', () => {
    const nasty: unknown[] = [
      { version: SAVE_VERSION },
      { version: SAVE_VERSION, wallet: null, upgrades: null },
      { version: SAVE_VERSION, wallet: [], upgrades: [] },
      { version: SAVE_VERSION, wallet: { [SCRAP]: '500' }, upgrades: { [DRILL]: '3' } },
      { version: SAVE_VERSION, deepestRow: Number.POSITIVE_INFINITY },
      { version: SAVE_VERSION, deepestRow: Number.NaN, bestShiftScrap: Number.NaN },
      [],
      () => 1,
    ];
    for (const raw of nasty) {
      expect(() => profileFromSaved(balance, raw)).not.toThrow();
    }
    // Nothing usable in it, but it is still a version 1 save: a clean profile.
    expect(profileFromSaved(balance, { version: SAVE_VERSION })).toEqual(createProfile(balance));
  });

  it('gives a profile the base screen can go on playing with', () => {
    const loaded = profileFromSaved(balance, {
      version: SAVE_VERSION,
      wallet: { [SCRAP]: upgradeCost(balance, DRILL, 0) },
      deepestRow: checkpointRows(balance)[1] ?? 0,
    });
    expect(loaded).not.toBeNull();
    expect(canBuyUpgrade(balance, loaded as Profile, DRILL)).toBe(true);
    expect(deepestOpenCheckpoint(balance, loaded as Profile)).toBe(checkpointRows(balance)[1] ?? 0);
    expect(shiftQuota(balance, loaded as Profile)).toBe(balance.shift.quota_min);
  });
});

/* ------------------------------------------------------------------- hangar */

/** One hour in milliseconds. A unit of the clock, not a game number. */
const HOUR_MS = 3600 * 1000;

/** Balance variant with the hangar numbers bent, to prove the code reads them. */
function offlineBalance(patch: { perHourPerDepth?: number; capHours?: number }): Balance {
  return {
    ...balance,
    offline: {
      scrap_per_hour_per_depth: patch.perHourPerDepth ?? balance.offline.scrap_per_hour_per_depth,
      cap_hours: patch.capHours ?? balance.offline.cap_hours,
    },
  };
}

describe('hangarScrapPerHour', () => {
  it('pays scrap_per_hour_per_depth for every row the player reached', () => {
    const profile = profileWith({ deepestRow: 12 });
    expect(hangarScrapPerHour(balance, profile)).toBe(
      balance.offline.scrap_per_hour_per_depth * 12,
    );
  });

  it('adds the hangar step for every level bought', () => {
    const step = item(HANGAR).step;
    for (const level of [0, 1, 3, 7]) {
      const profile = profileWith({ deepestRow: 10, upgrades: { [HANGAR]: level } });
      expect(hangarScrapPerHour(balance, profile)).toBeCloseTo(
        balance.offline.scrap_per_hour_per_depth * 10 * (1 + step * level),
        6,
      );
    }
  });

  it('pays nothing to an account that never went down', () => {
    const fresh = createProfile(balance);
    expect(fresh.deepestRow).toBe(ENTRANCE_ROW);
    expect(hangarScrapPerHour(balance, fresh)).toBe(0);
    // Even a fully upgraded hangar multiplies zero depth by nothing.
    expect(hangarScrapPerHour(balance, profileWith({ upgrades: { [HANGAR]: 9 } }))).toBe(0);
  });

  it('reads the number out of balance instead of carrying its own', () => {
    const profile = profileWith({ deepestRow: 5 });
    expect(hangarScrapPerHour(offlineBalance({ perHourPerDepth: 100 }), profile)).toBe(500);
  });
});

describe('hangarHarvest', () => {
  it('pays hours away times the hourly rate', () => {
    const profile = profileWith({ deepestRow: 10, lastVisitMs: 0 });
    const harvest = hangarHarvest(balance, profile, HOUR_MS * 2);
    expect(harvest.hours).toBeCloseTo(2, 6);
    expect(harvest.scrap).toBe(balance.offline.scrap_per_hour_per_depth * 10 * 2);
  });

  it('stops at cap_hours however long the game was closed', () => {
    const cap = balance.offline.cap_hours;
    const profile = profileWith({ deepestRow: 30, lastVisitMs: 0 });
    const capped = hangarHarvest(balance, profile, HOUR_MS * 100);
    expect(capped.hours).toBe(cap);
    expect(capped.scrap).toBe(
      Math.floor(balance.offline.scrap_per_hour_per_depth * 30 * cap),
    );
    expect(capped.fillShare).toBe(1);
    // A day away and a week away are worth exactly the same.
    expect(hangarHarvest(balance, profile, HOUR_MS * 24 * 7)).toEqual(capped);
  });

  it('is empty right after a visit and fills up towards the ceiling', () => {
    const profile = profileWith({ deepestRow: 20, lastVisitMs: HOUR_MS });
    const now = hangarHarvest(balance, profile, HOUR_MS);
    expect(now.scrap).toBe(0);
    expect(now.hours).toBe(0);
    expect(now.fillShare).toBe(0);

    const half = hangarHarvest(balance, profile, HOUR_MS + HOUR_MS * (balance.offline.cap_hours / 2));
    expect(half.fillShare).toBeCloseTo(0.5, 6);
  });

  it('pays nothing when the clock went backwards', () => {
    const profile = profileWith({ deepestRow: 30, lastVisitMs: HOUR_MS * 10 });
    for (const now of [HOUR_MS * 9, 0, -HOUR_MS]) {
      const harvest = hangarHarvest(balance, profile, now);
      expect(harvest.scrap).toBe(0);
      expect(harvest.hours).toBe(0);
      expect(harvest.fillShare).toBe(0);
    }
  });

  it('pays nothing at all without depth, however long the wait', () => {
    const profile = profileWith({ deepestRow: 0, upgrades: { [HANGAR]: 5 }, lastVisitMs: 0 });
    const harvest = hangarHarvest(balance, profile, HOUR_MS * 100);
    expect(harvest.scrap).toBe(0);
    // The bar still fills: the hangar is full of nothing, which is honest.
    expect(harvest.fillShare).toBe(1);
  });

  it('hands over whole scrap only', () => {
    const profile = profileWith({ deepestRow: 1, lastVisitMs: 0 });
    const harvest = hangarHarvest(offlineBalance({ perHourPerDepth: 7 }), profile, HOUR_MS / 2);
    expect(harvest.scrap).toBe(3);
  });

  it('never throws and never pays on a broken clock', () => {
    const profile = profileWith({ deepestRow: 10, lastVisitMs: 0 });
    for (const now of [Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(() => hangarHarvest(balance, profile, now)).not.toThrow();
      expect(hangarHarvest(balance, profile, now).scrap).toBe(0);
    }
  });

  it('changes nothing in the profile it is asked about', () => {
    const profile = profileWith({ deepestRow: 30, lastVisitMs: 0 });
    const before = JSON.stringify(profile);
    hangarHarvest(balance, profile, HOUR_MS * 3);
    expect(JSON.stringify(profile)).toBe(before);
  });
});

describe('collectHangar', () => {
  it('puts the scrap in the wallet and moves the visit stamp to now', () => {
    const profile = profileWith({ deepestRow: 10, wallet: { [SCRAP]: 100 }, lastVisitMs: 0 });
    const now = HOUR_MS * 2;
    const { profile: after, harvest } = collectHangar(balance, profile, now);
    expect(harvest.scrap).toBe(balance.offline.scrap_per_hour_per_depth * 10 * 2);
    expect(walletAmount(after, SCRAP)).toBe(100 + harvest.scrap);
    expect(after.lastVisitMs).toBe(now);
  });

  it('never pays the same hours twice', () => {
    const profile = profileWith({ deepestRow: 15, lastVisitMs: 0 });
    const now = HOUR_MS * 3;
    const first = collectHangar(balance, profile, now);
    expect(first.harvest.scrap).toBeGreaterThan(0);

    const second = collectHangar(balance, first.profile, now);
    expect(second.harvest.scrap).toBe(0);
    expect(walletAmount(second.profile, SCRAP)).toBe(walletAmount(first.profile, SCRAP));
  });

  it('brings scrap and nothing else: no crystals, no depth, no record', () => {
    const profile = profileWith({
      deepestRow: 20,
      wallet: { [SCRAP]: 0, [CRYSTAL]: 4 },
      bestShiftScrap: 700,
      upgrades: { [HANGAR]: 3, [DRILL]: 2 },
      fiveYearPlan: 2,
      lastVisitMs: 0,
    });
    const { profile: after } = collectHangar(balance, profile, HOUR_MS * 6);
    expect(walletAmount(after, CRYSTAL)).toBe(4);
    expect(after.deepestRow).toBe(20);
    expect(after.bestShiftScrap).toBe(700);
    expect(after.fiveYearPlan).toBe(2);
    expect(after.upgrades).toEqual(profile.upgrades);
    // The plan is measured against played shifts, so the hangar cannot raise it.
    expect(shiftQuota(balance, after)).toBe(shiftQuota(balance, profile));
  });

  it('takes nothing away when there is nothing to take', () => {
    const profile = profileWith({ deepestRow: 30, wallet: { [SCRAP]: 500 }, lastVisitMs: HOUR_MS });
    const { profile: after, harvest } = collectHangar(balance, profile, HOUR_MS / 2);
    expect(harvest.scrap).toBe(0);
    expect(walletAmount(after, SCRAP)).toBe(500);
    // The clock went backwards, and the stamp still moves: the hangar restarts
    // from the moment the player is actually here.
    expect(after.lastVisitMs).toBe(HOUR_MS / 2);
  });

  it('leaves the profile it was handed untouched', () => {
    const profile = profileWith({ deepestRow: 30, lastVisitMs: 0 });
    const before = JSON.stringify(profile);
    collectHangar(balance, profile, HOUR_MS * 6);
    expect(JSON.stringify(profile)).toBe(before);
  });
});

describe('touchVisit', () => {
  it('moves the stamp and touches nothing else', () => {
    const profile = profileWith({ deepestRow: 20, wallet: { [SCRAP]: 50 }, lastVisitMs: 0 });
    const stamped = touchVisit(profile, HOUR_MS * 5);
    expect(stamped.lastVisitMs).toBe(HOUR_MS * 5);
    expect({ ...stamped, lastVisitMs: 0 }).toEqual({ ...profile, lastVisitMs: 0 });
  });

  it('empties the hangar: time in the game is not time offline', () => {
    const profile = profileWith({ deepestRow: 30, lastVisitMs: 0 });
    const stamped = touchVisit(profile, HOUR_MS * 6);
    expect(hangarHarvest(balance, stamped, HOUR_MS * 6).scrap).toBe(0);
  });

  it('keeps the old stamp when the clock is unreadable', () => {
    const profile = profileWith({ lastVisitMs: HOUR_MS });
    expect(touchVisit(profile, Number.NaN).lastVisitMs).toBe(HOUR_MS);
  });
});

/* ------------------------------------------------------------ five-year plan */

/**
 * Plans the five-year tests run in: the first, the one winning hands out, the
 * one after it, and a far one where the multiplier has compounded four times.
 */
const MEASURED_PLANS: readonly number[] = [1, 2, 3, 5];

/**
 * Scrap the drill actually puts in the backpack in one plan, in one layer.
 *
 * The five-year plan is the reward for reaching the bottom, so every plan is a
 * state the game is certain to be played in, and «the numbers multiplied
 * correctly» is not the question worth asking about it. This one is: it drops a
 * drill at the top of the layer, taps the cell under it and runs the real
 * simulation for a minute. Zero means the mine is dead — the cell does not fit
 * an empty cargo, the drill blocks itself, and no arithmetic assertion notices.
 */
function dugOneCell(plan: number, layerIndex: number): number {
  const bent = shiftBalance(balance, profileWith({ fiveYearPlan: plan }));
  const top = bent.layers[layerIndex]?.rows[0] ?? ENTRANCE_ROW;
  const state = createShift(bent, 1, { startRow: top });
  const col = Math.floor(bent.shift.grid_width / 2);
  const row = Math.min(top + 1, bent.shift.grid_depth);
  expect(canDig(state, col, row)).toBe(true);
  expect(aimDrill(state, col, row)).toBe(true);
  for (let tick = 0; tick < 60; tick += 1) {
    stepShift(state, 1);
  }
  return state.cargo + state.banked;
}


describe('planTier', () => {
  it('counts the first plan as tier zero', () => {
    expect(planTier(1)).toBe(0);
    expect(planTier(2)).toBe(1);
    expect(planTier(5)).toBe(4);
  });

  it('never goes below zero, whatever a broken save says', () => {
    for (const value of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planTier(value)).toBeGreaterThanOrEqual(0);
    }
    expect(planTier(2.9)).toBe(1);
  });
});

describe('planBalance', () => {
  it('changes not a single number in the first five-year plan', () => {
    // The measured balance of PLAN_V1 §6 is the balance of a new account: the
    // very same object comes back, so nothing can drift.
    expect(planBalance(balance, 1)).toBe(balance);
    expect(planBalance(balance, 1)).toEqual(balance);
  });

  it('multiplies the yield of every layer once per tier', () => {
    const mult = balance.prestige.yield_mult_per_tier;
    const second = planBalance(balance, 2);
    balance.layers.forEach((layer, index) => {
      expect(second.layers[index]?.yield).toBeCloseTo(layer.yield * mult, 10);
    });
    const fourth = planBalance(balance, 4);
    balance.layers.forEach((layer, index) => {
      expect(fourth.layers[index]?.yield).toBeCloseTo(layer.yield * mult ** 3, 10);
    });
  });

  it('lifts the cargo by the same factor as the ore, so a trip stays a trip', () => {
    // The rule of §2.6: a trip is `floor(capacity / yield)` cells and two
    // decisions. A plan that doubles the ore and leaves the backpack at 96 does
    // not make the trip shorter, it makes it *nothing* — see the dig below.
    const mult = balance.prestige.yield_mult_per_tier;
    expect(planBalance(balance, 2).cargo.capacity_base).toBeCloseTo(
      balance.cargo.capacity_base * mult,
      10,
    );
    expect(planBalance(balance, 5).cargo.capacity_base).toBeCloseTo(
      balance.cargo.capacity_base * mult ** 4,
      10,
    );
    for (const plan of MEASURED_PLANS) {
      const bent = planBalance(balance, plan);
      bent.layers.forEach((layer, index) => {
        expect(
          Math.floor(bent.cargo.capacity_base / layer.yield),
          `пятилетка ${plan}, ${layer.id}`,
        ).toBe(Math.floor(balance.cargo.capacity_base / (balance.layers[index]?.yield ?? 1)));
      });
    }
  });

  it('leaves a mine that can actually be dug in every plan', () => {
    // The question the arithmetic above cannot answer, and the one that was not
    // asked when the plan started multiplying the yield: does the drill still
    // dig? A cell whose ore does not fit an empty cargo is never started at all,
    // so the shift spends six minutes handing over an empty backpack.
    for (const plan of MEASURED_PLANS) {
      for (let index = 0; index < balance.layers.length; index += 1) {
        expect(dugOneCell(plan, index), `пятилетка ${plan}, слой ${index + 1}`).toBeGreaterThan(0);
      }
    }
  });

  it('multiplies the base health of an enemy once per tier', () => {
    const mult = balance.prestige.wave_hp_mult_per_tier;
    expect(planBalance(balance, 2).waves.enemy_hp_base).toBeCloseTo(
      balance.waves.enemy_hp_base * mult,
      10,
    );
    expect(planBalance(balance, 3).waves.enemy_hp_base).toBeCloseTo(
      balance.waves.enemy_hp_base * mult ** 2,
      10,
    );
  });

  it('leaves hardness, crystals, prices and the grid where they were', () => {
    const second = planBalance(balance, 2);
    balance.layers.forEach((layer, index) => {
      expect(second.layers[index]?.hardness_sec).toBe(layer.hardness_sec);
      expect(second.layers[index]?.crystal_chance).toBe(layer.crystal_chance);
      expect(second.layers[index]?.enemies).toEqual(layer.enemies);
    });
    expect(second.shift).toEqual(balance.shift);
    expect(second.upgrades).toEqual(balance.upgrades);
    expect(second.dome).toEqual(balance.dome);
    expect(second.turret).toEqual(balance.turret);
    expect(second.drill).toEqual(balance.drill);
    expect(second.offline).toEqual(balance.offline);
    // Wave timing is untouched: only the health the waves come with grows.
    expect({ ...second.waves, enemy_hp_base: balance.waves.enemy_hp_base }).toEqual(balance.waves);
  });

  it('never touches the balance it was handed', () => {
    const before = JSON.parse(JSON.stringify(balance));
    planBalance(balance, 3);
    expect(JSON.parse(JSON.stringify(balance))).toEqual(before);
  });
});

describe('shiftBalance', () => {
  it('is the plain balance for a fresh account', () => {
    expect(shiftBalance(balance, createProfile(balance))).toEqual(balance);
  });

  it('puts the upgrades on top of the plan, and both are felt', () => {
    const profile = profileWith({ fiveYearPlan: 3, upgrades: { [DRILL]: 2, [CARGO]: 1 } });
    const combined = shiftBalance(balance, profile);
    const yieldMult = balance.prestige.yield_mult_per_tier ** 2;
    // The plan doubles the ore and the cargo level lifts it again with the
    // backpack, so both multipliers are on the layer.
    expect(combined.layers[0]?.yield).toBe(
      Math.round((balance.layers[0]?.yield ?? 0) * yieldMult * (1 + item(CARGO).step)),
    );
    expect(combined.waves.enemy_hp_base).toBeCloseTo(
      balance.waves.enemy_hp_base * balance.prestige.wave_hp_mult_per_tier ** 2,
      10,
    );
    expect(combined.drill.speed_base).toBeCloseTo(
      balance.drill.speed_base * (1 + item(DRILL).step * 2),
      10,
    );
    // The backpack carries both multipliers too, for the same reason the ore
    // does: the plan lifts it so the trip survives the richer ore, the level
    // lifts it again. `floor(capacity / yield)` is what has to come out
    // unchanged, and the cells-per-trip check below is the one that says so.
    expect(combined.cargo.capacity_base).toBeCloseTo(
      balance.cargo.capacity_base * yieldMult * (1 + item(CARGO).step),
      10,
    );
    combined.layers.forEach((layer, index) => {
      expect(Math.floor(combined.cargo.capacity_base / layer.yield), layer.id).toBe(
        Math.floor(balance.cargo.capacity_base / (balance.layers[index]?.yield ?? 1)),
      );
    });
    // And the mine digs: the whole point of the two multipliers being one.
    expect(dugOneCell(3, balance.layers.length - 1)).toBeGreaterThan(0);
  });

  it('puts the plan first, and the order shows only in the rounding of the ore', () => {
    // Both sides scale the same two numbers now — the backpack and the ore — and
    // scaling commutes, so for branches that do not touch them the order is free.
    const untouched = profileWith({ fiveYearPlan: 4, upgrades: { [DRILL]: 3, [DOME]: 2, [SALVO]: 4 } });
    expect(shiftBalance(balance, untouched)).toEqual(
      planBalance(effectiveBalance(balance, untouched.upgrades), untouched.fiveYearPlan),
    );

    // With a cargo level the two do differ, and the reason is written down in
    // `shiftBalance`: the yield is rounded to a whole scrap, and rounding does
    // not commute with multiplication. The difference is at most one scrap, and
    // the order is fixed so the rounding happens once — on the number the HUD
    // shows — instead of being multiplied up by the plan.
    const cargo = profileWith({ fiveYearPlan: 2, upgrades: { [CARGO]: 4 } });
    const planFirst = shiftBalance(balance, cargo);
    const upgradesFirst = planBalance(effectiveBalance(balance, cargo.upgrades), cargo.fiveYearPlan);
    expect(planFirst.cargo.capacity_base).toBeCloseTo(upgradesFirst.cargo.capacity_base, 10);
    planFirst.layers.forEach((layer, index) => {
      expect(Math.abs(layer.yield - (upgradesFirst.layers[index]?.yield ?? 0)), layer.id).toBeLessThanOrEqual(1);
      // Whichever way round, a trip is the same number of cells: that is the
      // property the game depends on, and it does not care about the last scrap.
      expect(Math.floor(planFirst.cargo.capacity_base / layer.yield), layer.id).toBe(
        Math.floor(balance.cargo.capacity_base / (balance.layers[index]?.yield ?? 1)),
      );
    });
  });
});

describe('isBottomReached', () => {
  it('is false until the deepest row of the mine is dug', () => {
    for (const row of [0, 1, 15, balance.shift.grid_depth - 1]) {
      expect(isBottomReached(balance, profileWith({ deepestRow: row }))).toBe(false);
    }
  });

  it('is true on the bottom row itself', () => {
    expect(isBottomReached(balance, profileWith({ deepestRow: balance.shift.grid_depth }))).toBe(true);
  });

  it('reads the bottom from balance, not from a number in the code', () => {
    const shallow: Balance = { ...balance, shift: { ...balance.shift, grid_depth: 12 } };
    expect(isBottomReached(shallow, profileWith({ deepestRow: 12 }))).toBe(true);
    expect(isBottomReached(shallow, profileWith({ deepestRow: 11 }))).toBe(false);
  });

  it('follows the depth a finished shift wrote into the profile', () => {
    const profile = profileWith({ deepestRow: balance.shift.grid_depth - 1 });
    expect(isBottomReached(balance, profile)).toBe(false);
    const outcome = applyShiftResult(
      balance,
      profile,
      report({ banked: 100, deepestRow: balance.shift.grid_depth }),
    );
    expect(isBottomReached(balance, outcome.profile)).toBe(true);
  });
});

describe('startNextPlan', () => {
  const closed = profileWith({
    wallet: { [SCRAP]: 4200, [CRYSTAL]: 17 },
    upgrades: { [DRILL]: 6, [TURRET]: 4, [DOME]: 5, [CARGO]: 3, [SALVO]: 8, [CONVEYOR]: 1 },
    deepestRow: 30,
    bestShiftScrap: 1800,
    fiveYearPlan: 1,
    lastVisitMs: HOUR_MS * 9,
  });

  it('counts the next five-year plan', () => {
    expect(startNextPlan(closed).fiveYearPlan).toBe(2);
    expect(startNextPlan(startNextPlan(closed)).fiveYearPlan).toBe(3);
  });

  it('takes away neither scrap, nor crystals, nor a bought level (PLAN_V1 §2.1)', () => {
    const next = startNextPlan(closed);
    expect(walletAmount(next, SCRAP)).toBe(4200);
    expect(walletAmount(next, CRYSTAL)).toBe(17);
    expect(next.upgrades).toEqual(closed.upgrades);
    expect(hasConveyor(next)).toBe(true);
  });

  it('seals the shaft: the depth starts from the surface again', () => {
    const next = startNextPlan(closed);
    expect(next.deepestRow).toBe(ENTRANCE_ROW);
    expect(openCheckpointRows(balance, next)).toEqual([ENTRANCE_ROW]);
    expect(deepestOpenCheckpoint(balance, next)).toBe(ENTRANCE_ROW);
    expect(isBottomReached(balance, next)).toBe(false);
  });

  it('keeps the shift record, so the quota is still measured against real work', () => {
    const next = startNextPlan(closed);
    expect(next.bestShiftScrap).toBe(closed.bestShiftScrap);
    expect(shiftQuota(balance, next)).toBe(shiftQuota(balance, closed));
  });

  it('leaves the visit stamp alone: the clock is not its business', () => {
    expect(startNextPlan(closed).lastVisitMs).toBe(closed.lastVisitMs);
  });

  it('pays the reset depth nothing offline until the new plan digs again', () => {
    const next = startNextPlan(closed);
    expect(hangarHarvest(balance, next, closed.lastVisitMs + HOUR_MS * 3).scrap).toBe(0);
  });

  it('makes the ore richer and the waves tougher from the next shift on', () => {
    const next = startNextPlan(closed);
    const before = shiftBalance(balance, closed);
    const after = shiftBalance(balance, next);
    expect(after.layers[0]?.yield).toBeCloseTo(
      (before.layers[0]?.yield ?? 0) * balance.prestige.yield_mult_per_tier,
      10,
    );
    expect(after.waves.enemy_hp_base).toBeCloseTo(
      before.waves.enemy_hp_base * balance.prestige.wave_hp_mult_per_tier,
      10,
    );
  });

  it('survives a save and a load with the plan number intact', () => {
    const next = startNextPlan(closed);
    const loaded = profileFromSaved(balance, JSON.parse(JSON.stringify(profileToSaved(next))), 0);
    expect(loaded?.fiveYearPlan).toBe(2);
    expect(loaded?.deepestRow).toBe(ENTRANCE_ROW);
    expect(loaded?.upgrades).toEqual(next.upgrades);
    expect(walletAmount(loaded as Profile, SCRAP)).toBe(4200);
    expect(shiftBalance(balance, loaded as Profile)).toEqual(shiftBalance(balance, next));
  });
});

/* --------------------------------------------------- migration from version 1 */

/** A version 1 save: everything the old schema had, no visit stamp. */
const SAVE_V1 = {
  version: 1,
  wallet: { [SCRAP]: 1730, [CRYSTAL]: 6 },
  upgrades: { [DRILL]: 4, [TURRET]: 2, [CARGO]: 3, [HANGAR]: 2, [SALVO]: 5, [ELEVATOR]: 1 },
  deepestRow: 20,
  bestShiftScrap: 940,
  fiveYearPlan: 2,
} as const;

describe('save migration v1 -> v2', () => {
  it('reads a version 1 save instead of throwing it away', () => {
    expect(SAVE_VERSION).toBe(2);
    expect(profileFromSaved(balance, SAVE_V1, HOUR_MS)).not.toBeNull();
  });

  it('loses not a single scrap, crystal or bought level', () => {
    const loaded = profileFromSaved(balance, SAVE_V1, HOUR_MS) as Profile;
    expect(walletAmount(loaded, SCRAP)).toBe(1730);
    expect(walletAmount(loaded, CRYSTAL)).toBe(6);
    expect(upgradeLevel(loaded, DRILL)).toBe(4);
    expect(upgradeLevel(loaded, TURRET)).toBe(2);
    expect(upgradeLevel(loaded, CARGO)).toBe(3);
    expect(upgradeLevel(loaded, HANGAR)).toBe(2);
    expect(upgradeLevel(loaded, SALVO)).toBe(5);
    expect(upgradeLevel(loaded, ELEVATOR)).toBe(1);
    expect(loaded.deepestRow).toBe(20);
    expect(loaded.bestShiftScrap).toBe(940);
    expect(loaded.fiveYearPlan).toBe(2);
  });

  it('keeps the depth open and the plan where they were', () => {
    const loaded = profileFromSaved(balance, SAVE_V1, HOUR_MS) as Profile;
    // The deepest checkpoint the saved depth reaches, wherever balance spaces
    // them: the migration must not move the player up or down the shaft.
    const every = balance.shift.checkpoint_every_rows;
    expect(deepestOpenCheckpoint(balance, loaded)).toBe(
      Math.floor(SAVE_V1.deepestRow / every) * every,
    );
    expect(shiftQuota(balance, loaded)).toBe(
      Math.max(balance.shift.quota_min, Math.round(940 * balance.shift.quota_share_of_best)),
    );
  });

  it('stamps the visit with the moment the player arrived', () => {
    const now = HOUR_MS * 42;
    const loaded = profileFromSaved(balance, SAVE_V1, now) as Profile;
    expect(loaded.lastVisitMs).toBe(now);
    // Which means the format change itself pays out nothing.
    expect(hangarHarvest(balance, loaded, now).scrap).toBe(0);
    // And the hangar starts counting from that visit on.
    expect(hangarHarvest(balance, loaded, now + HOUR_MS).scrap).toBeGreaterThan(0);
  });

  it('migrates a version 1 save that has nothing readable in it', () => {
    const loaded = profileFromSaved(balance, { version: 1 }, HOUR_MS);
    expect(loaded).toEqual(createProfile(balance, HOUR_MS));
  });

  it('writes what it read back as version 2', () => {
    const loaded = profileFromSaved(balance, SAVE_V1, HOUR_MS) as Profile;
    const saved = profileToSaved(loaded);
    expect(saved.version).toBe(SAVE_VERSION);
    expect(saved.lastVisitMs).toBe(HOUR_MS);
    // Second trip: a migrated save is a normal version 2 save from now on.
    expect(profileFromSaved(balance, JSON.parse(JSON.stringify(saved)), 0)).toEqual(loaded);
  });

  it('repairs a version 2 save whose stamp is broken, without losing anything', () => {
    const now = HOUR_MS * 7;
    for (const stamp of [undefined, Number.NaN, 'вчера', -5]) {
      const loaded = profileFromSaved(
        balance,
        { ...SAVE_V1, version: SAVE_VERSION, lastVisitMs: stamp },
        now,
      ) as Profile;
      expect(walletAmount(loaded, SCRAP)).toBe(1730);
      expect(loaded.lastVisitMs).toBeGreaterThanOrEqual(0);
      expect(hangarHarvest(balance, loaded, now).scrap).toBe(0);
    }
  });
});
