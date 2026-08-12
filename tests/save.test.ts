import { describe, expect, it } from 'vitest';
import balanceJson from '../content/balance.json' with { type: 'json' };
import {
  browserStore,
  loadProfile,
  SAVE_KEY,
  saveProfile,
  type KeyValueStore,
} from '../src/game/saveStorage.js';
import type { Balance } from '../src/sim/balance.js';
import {
  buyUpgrade,
  createProfile,
  crystalId,
  profileToSaved,
  SAVE_VERSION,
  scrapId,
  upgradeCost,
  upgradeLevel,
  walletAmount,
  type Profile,
} from '../src/sim/progress.js';

const balance = balanceJson as unknown as Balance;

/** The two currencies of the game, resolved from balance like the code does. */
const SCRAP = scrapId(balance);
const CRYSTAL = crystalId(balance);

/** A cheap scrap branch: the levels below are bought, not invented. */
const DRILL = 'drill';

/** localStorage as far as this module needs it: a plain map, no browser. */
function memoryStore(seed: Record<string, string> = {}): KeyValueStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

/** A storage that refuses everything, like a browser in private mode. */
function brokenStore(): KeyValueStore {
  return {
    getItem: () => {
      throw new Error('storage is blocked');
    },
    setItem: () => {
      throw new Error('quota exceeded');
    },
  };
}

/** A profile worth saving: money spent, depth reached, a record set. */
function playedProfile(): Profile {
  const fresh = createProfile(balance);
  const funded: Profile = {
    ...fresh,
    wallet: { ...fresh.wallet, [SCRAP]: upgradeCost(balance, DRILL, 0), [CRYSTAL]: 3 },
    deepestRow: balance.shift.checkpoint_every_rows * 2,
    bestShiftScrap: balance.shift.quota_min,
    fiveYearPlan: 2,
  };
  const bought = buyUpgrade(balance, funded, DRILL);
  if (!bought) {
    throw new Error(`could not buy "${DRILL}"`);
  }
  return bought;
}

describe('saveProfile', () => {
  it('writes one key with the version and the profile in it', () => {
    const store = memoryStore();
    const profile = playedProfile();
    expect(saveProfile(profile, store)).toBe(true);

    expect([...store.map.keys()]).toEqual([SAVE_KEY]);
    const raw = store.getItem(SAVE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '')).toEqual(profileToSaved(profile));
  });

  it('overwrites the previous save instead of piling saves up', () => {
    const store = memoryStore();
    saveProfile(createProfile(balance), store);
    const played = playedProfile();
    expect(saveProfile(played, store)).toBe(true);
    expect(store.map.size).toBe(1);
    expect(loadProfile(balance, store)).toEqual(played);
  });

  it('says no when there is no storage at all', () => {
    expect(saveProfile(playedProfile(), null)).toBe(false);
  });

  it('says no when the storage refuses the write, and does not throw', () => {
    expect(saveProfile(playedProfile(), brokenStore())).toBe(false);
  });
});

describe('loadProfile', () => {
  it('gives a fresh account when nothing was ever saved', () => {
    expect(loadProfile(balance, memoryStore())).toEqual(createProfile(balance));
  });

  it('gives a fresh account when there is no storage or the storage throws', () => {
    expect(loadProfile(balance, null)).toEqual(createProfile(balance));
    expect(loadProfile(balance, brokenStore())).toEqual(createProfile(balance));
  });

  it('gives a fresh account for a save that is not JSON', () => {
    const store = memoryStore({ [SAVE_KEY]: '{"version":1,' });
    expect(loadProfile(balance, store)).toEqual(createProfile(balance));
  });

  it('gives a fresh account for JSON that is not a profile', () => {
    for (const raw of ['null', '17', '"vostok9"', '[]', 'true']) {
      const store = memoryStore({ [SAVE_KEY]: raw });
      expect(loadProfile(balance, store)).toEqual(createProfile(balance));
    }
  });

  it('gives a fresh account for a save from another version', () => {
    const foreign = { ...profileToSaved(playedProfile()), version: SAVE_VERSION + 1 };
    const store = memoryStore({ [SAVE_KEY]: JSON.stringify(foreign) });
    const loaded = loadProfile(balance, store);
    expect(loaded).toEqual(createProfile(balance));
    expect(upgradeLevel(loaded, DRILL)).toBe(0);
  });

  it('clamps what a readable save says instead of trusting it', () => {
    const store = memoryStore({
      [SAVE_KEY]: JSON.stringify({
        version: SAVE_VERSION,
        wallet: { [SCRAP]: -500, [CRYSTAL]: Number.NaN, gold: 1000 },
        upgrades: { [DRILL]: -2, kraken: 5 },
        deepestRow: balance.shift.grid_depth + 50,
        bestShiftScrap: -1,
        fiveYearPlan: 0,
      }),
    });
    const loaded = loadProfile(balance, store);
    expect(walletAmount(loaded, SCRAP)).toBe(0);
    expect(walletAmount(loaded, CRYSTAL)).toBe(0);
    expect(walletAmount(loaded, 'gold')).toBe(0);
    expect(upgradeLevel(loaded, DRILL)).toBe(0);
    expect(loaded.deepestRow).toBe(balance.shift.grid_depth);
    expect(loaded.bestShiftScrap).toBe(0);
    expect(loaded.fiveYearPlan).toBe(1);
  });

  it('reads nothing but its own key', () => {
    const store = memoryStore({ 'vostok9.other': JSON.stringify(profileToSaved(playedProfile())) });
    expect(loadProfile(balance, store)).toEqual(createProfile(balance));
  });
});

describe('save and load', () => {
  it('gives back the same profile it was handed', () => {
    const store = memoryStore();
    const profile = playedProfile();
    expect(saveProfile(profile, store)).toBe(true);
    expect(loadProfile(balance, store)).toEqual(profile);
  });

  it('survives a fresh profile, a maxed one and everything in between', () => {
    const fresh = createProfile(balance);
    const maxed: Profile = {
      ...fresh,
      wallet: { ...fresh.wallet, [SCRAP]: 999999, [CRYSTAL]: 42 },
      upgrades: Object.fromEntries(
        Object.entries(balance.upgrades.items).map(([id, item]) => [id, item.max_level ?? 12]),
      ),
      deepestRow: balance.shift.grid_depth,
      bestShiftScrap: 12345,
      fiveYearPlan: 3,
    };
    for (const profile of [fresh, playedProfile(), maxed]) {
      const store = memoryStore();
      expect(saveProfile(profile, store)).toBe(true);
      expect(loadProfile(balance, store)).toEqual(profile);
    }
  });

  it('keeps the profile across several rounds of playing and saving', () => {
    const store = memoryStore();
    let profile = createProfile(balance);
    for (let round = 0; round < 3; round += 1) {
      const cost = upgradeCost(balance, DRILL, upgradeLevel(profile, DRILL));
      const funded: Profile = { ...profile, wallet: { ...profile.wallet, [SCRAP]: cost } };
      const bought = buyUpgrade(balance, funded, DRILL);
      expect(bought).not.toBeNull();
      profile = bought as Profile;
      expect(saveProfile(profile, store)).toBe(true);
      profile = loadProfile(balance, store);
      expect(upgradeLevel(profile, DRILL)).toBe(round + 1);
    }
  });

  it('goes on playing on a lost save: the session costs nothing but the storage', () => {
    const store = brokenStore();
    const profile = playedProfile();
    expect(saveProfile(profile, store)).toBe(false);
    expect(loadProfile(balance, store)).toEqual(createProfile(balance));
  });
});

describe('browserStore', () => {
  it('finds no localStorage in node and never throws', () => {
    expect(() => browserStore()).not.toThrow();
    expect(browserStore()).toBeNull();
  });

  it('hands back whatever localStorage the page has', () => {
    const fake = memoryStore();
    const global = globalThis as { localStorage?: KeyValueStore };
    global.localStorage = fake;
    try {
      expect(browserStore()).toBe(fake);
      // The default store of the module is that same localStorage.
      const profile = playedProfile();
      expect(saveProfile(profile)).toBe(true);
      expect(fake.getItem(SAVE_KEY)).not.toBeNull();
      expect(loadProfile(balance)).toEqual(profile);
    } finally {
      delete global.localStorage;
    }
  });
});
