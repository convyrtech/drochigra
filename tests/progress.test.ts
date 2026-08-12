import { describe, expect, it } from 'vitest';
import balanceJson from '../content/balance.json' with { type: 'json' };
import type { Balance, UpgradeItemBalance } from '../src/sim/balance.js';
import {
  applyShiftResult,
  buyUpgrade,
  canBuyUpgrade,
  cheapestUpgrade,
  checkpointRows,
  createProfile,
  crystalId,
  deepestOpenCheckpoint,
  effectiveBalance,
  hasConveyor,
  isCheckpointOpen,
  isUpgradeMaxed,
  nextUpgrade,
  openCheckpointRows,
  profileFromSaved,
  profileToSaved,
  quotaBonusScrap,
  quotaShare,
  resourceIds,
  SAVE_VERSION,
  scrapId,
  shiftQuota,
  upgradeCost,
  upgradeIds,
  upgradeLevel,
  upgradeMaxLevel,
  walletAmount,
  type Profile,
} from '../src/sim/progress.js';
import { ENTRANCE_ROW, type ShiftEndReason, type ShiftReport } from '../src/sim/shift.js';

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
function balanceWith(patch: { checkpointEveryRows?: number }): Balance {
  return {
    ...balance,
    shift: {
      ...balance.shift,
      checkpoint_every_rows: patch.checkpointEveryRows ?? balance.shift.checkpoint_every_rows,
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
}): Profile {
  const fresh = createProfile(balance);
  return {
    ...fresh,
    wallet: { ...fresh.wallet, ...patch.wallet },
    upgrades: { ...fresh.upgrades, ...patch.upgrades },
    deepestRow: patch.deepestRow ?? fresh.deepestRow,
    bestShiftScrap: patch.bestShiftScrap ?? fresh.bestShiftScrap,
    fiveYearPlan: patch.fiveYearPlan ?? fresh.fiveYearPlan,
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
    expect(fresh.layers).toBe(balance.layers);
    expect(fresh.shift).toBe(balance.shift);
    expect(fresh.waves).toBe(balance.waves);
    expect(fresh.upgrades).toBe(balance.upgrades);
  });

  it('bends the drill speed by the drill step and nothing else', () => {
    const step = item(DRILL).step;
    for (const level of [1, 3, 7]) {
      const bent = effectiveBalance(balance, { [DRILL]: level });
      expect(bent.drill.speed_base).toBeCloseTo(balance.drill.speed_base * (1 + step * level), 10);
      expect(bent.drill.move_rows_per_sec).toBeCloseTo(balance.drill.move_rows_per_sec, 10);
      expect(bent.cargo.capacity_base).toBeCloseTo(balance.cargo.capacity_base, 10);
      expect(bent.turret.dps_base).toBeCloseTo(balance.turret.dps_base, 10);
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

describe('checkpoints', () => {
  it('puts one on the surface and then every checkpoint_every_rows down to the bottom', () => {
    const every = balance.shift.checkpoint_every_rows;
    const rows = checkpointRows(balance);
    expect(rows[0]).toBe(ENTRANCE_ROW);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index]).toBe(ENTRANCE_ROW + every * index);
    }
    expect(rows[rows.length - 1]).toBeLessThanOrEqual(balance.shift.grid_depth);
    expect((rows[rows.length - 1] ?? 0) + every).toBeGreaterThan(balance.shift.grid_depth);
  });

  it('keeps the surface only when balance switches the checkpoints off', () => {
    expect(checkpointRows(balanceWith({ checkpointEveryRows: 0 }))).toEqual([ENTRANCE_ROW]);
  });

  it('opens a checkpoint only once the player has dug that deep', () => {
    const every = balance.shift.checkpoint_every_rows;
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
    const every = balance.shift.checkpoint_every_rows;
    const deep = profileWith({ deepestRow: every * 3 + 1 });
    expect(openCheckpointRows(balance, deep)).toEqual([
      ENTRANCE_ROW,
      every,
      every * 2,
      every * 3,
    ]);
    expect(deepestOpenCheckpoint(balance, deep)).toBe(every * 3);
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
    const every = balance.shift.checkpoint_every_rows;
    const perCheckpoint = balance.shift.crystals_per_new_checkpoint;
    const fresh = createProfile(balance);

    // First trip down to the second checkpoint: two rows opened, two payments.
    const first = applyShiftResult(balance, fresh, report({ deepestRow: every * 2 }));
    expect(first.newCheckpoints).toBe(2);
    expect(first.checkpointCrystals).toBe(2 * perCheckpoint);
    expect(walletAmount(first.profile, CRYSTAL)).toBe(2 * perCheckpoint);
    expect(first.profile.deepestRow).toBe(every * 2);

    // Down the same shaft again: nothing new is open, so nothing is paid.
    const again = applyShiftResult(balance, first.profile, report({ deepestRow: every * 2 }));
    expect(again.newCheckpoints).toBe(0);
    expect(again.checkpointCrystals).toBe(0);
    expect(walletAmount(again.profile, CRYSTAL)).toBe(2 * perCheckpoint);

    // One checkpoint deeper: only that one pays.
    const deeper = applyShiftResult(balance, again.profile, report({ deepestRow: every * 3 }));
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
    const before = profileWith({ wallet: { [SCRAP]: 100 }, deepestRow: 4, bestShiftScrap: 50 });
    const outcome = applyShiftResult(
      balance,
      before,
      report({ mined: 800, banked: 300, deepestRow: 11, crystals: 2, endReason: 'breach' }),
    );
    expect(walletAmount(outcome.profile, SCRAP)).toBeGreaterThan(100);
    expect(walletAmount(outcome.profile, CRYSTAL)).toBeGreaterThan(2);
    expect(outcome.profile.deepestRow).toBe(11);
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
    expect(profileFromSaved(balance, { ...saved, version: SAVE_VERSION - 1 })).toBeNull();
    expect(profileFromSaved(balance, { ...saved, version: String(SAVE_VERSION) })).toBeNull();
    const { version: _version, ...noVersion } = saved;
    expect(profileFromSaved(balance, noVersion)).toBeNull();
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
      deepestRow: balance.shift.checkpoint_every_rows,
    });
    expect(loaded).not.toBeNull();
    expect(canBuyUpgrade(balance, loaded as Profile, DRILL)).toBe(true);
    expect(deepestOpenCheckpoint(balance, loaded as Profile)).toBe(
      balance.shift.checkpoint_every_rows,
    );
    expect(shiftQuota(balance, loaded as Profile)).toBe(balance.shift.quota_min);
  });
});
