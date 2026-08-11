import { describe, expect, it } from 'vitest';
import balanceJson from '../content/balance.json' with { type: 'json' };
import type { Balance } from '../src/sim/balance.js';
import {
  createDefense,
  domeHpShare,
  enemyHp,
  isDomeWarning,
  isSalvoReady,
  nextWaveInSec,
  turretTarget,
  waveDueAtSec,
  waveEnemyCount,
} from '../src/sim/defense.js';
import {
  aimDrill,
  aimTurret,
  callElevator,
  createShift,
  fireSalvo,
  isDug,
  shiftReport,
  step,
  type ShiftState,
} from '../src/sim/shift.js';

const balance = balanceJson as unknown as Balance;

/** Column the drill starts in: middle of the grid. */
const START_COL = Math.floor(balance.shift.grid_width / 2);

/** Balance variant. Tests bend single numbers, they never invent new ones. */
function balanceWith(patch: {
  domeHp?: number;
  cargoCapacity?: number;
  durationSec?: number;
  firstWaveSec?: number;
  intervalSec?: number;
  countBase?: number;
  countPerWave?: number;
  enemyHpBase?: number;
}): Balance {
  return {
    ...balance,
    shift: {
      ...balance.shift,
      duration_sec: patch.durationSec ?? balance.shift.duration_sec,
    },
    cargo: {
      ...balance.cargo,
      capacity_base: patch.cargoCapacity ?? balance.cargo.capacity_base,
    },
    dome: {
      ...balance.dome,
      hp_base: patch.domeHp ?? balance.dome.hp_base,
    },
    waves: {
      ...balance.waves,
      first_wave_sec: patch.firstWaveSec ?? balance.waves.first_wave_sec,
      interval_sec: patch.intervalSec ?? balance.waves.interval_sec,
      count_base: patch.countBase ?? balance.waves.count_base,
      count_per_wave: patch.countPerWave ?? balance.waves.count_per_wave,
      enemy_hp_base: patch.enemyHpBase ?? balance.waves.enemy_hp_base,
    },
  };
}

/** Enemies too tough for the turret: the test is about what reaches the dome. */
const UNKILLABLE = 1e6;

/** Exactly one enemy per wave, so a single arrival can be measured. */
const SINGLE = { countBase: 0, countPerWave: 1 };

/** Seconds an enemy of `type` spends walking to the dome. */
function travelSec(type: string, from: Balance = balance): number {
  const speed = from.enemies[type]?.speed ?? 0;
  return from.waves.enemy_travel_sec / speed;
}

/** Scrap one cell of a layer drops. */
function layerYield(layerIndex: number): number {
  const layer = balance.layers[layerIndex];
  if (!layer) {
    throw new Error(`no layer ${layerIndex} in balance`);
  }
  return layer.yield;
}

/** Digs one cell and drives into it. Waits for the drill, not for the clock. */
function digCell(state: ShiftState, col: number, row: number): void {
  expect(aimDrill(state, col, row)).toBe(true);
  for (let guard = 0; guard < 2000; guard += 1) {
    if (state.phase !== 'running') {
      return;
    }
    // The drill goes on digging by itself, so this is the one instant it stands
    // in the cell that was ordered.
    if (isDug(state, col, row) && state.drill.col === col && state.drill.row === row) {
      return;
    }
    step(state, 0.05);
  }
  throw new Error(`cell ${col},${row} was not dug`);
}

describe('createDefense', () => {
  it('opens the shift with a full dome, no enemies and the salvo ready', () => {
    const defense = createDefense(balance);
    expect(defense.hp).toBe(balance.dome.hp_base);
    expect(defense.hpMax).toBe(balance.dome.hp_base);
    expect(defense.enemies).toEqual([]);
    expect(defense.wavesSent).toBe(0);
    expect(domeHpShare(defense)).toBe(1);
    expect(isSalvoReady(defense)).toBe(true);
  });

  it('refuses a layer that asks for an enemy the balance does not describe', () => {
    const broken: Balance = {
      ...balance,
      layers: balance.layers.map((layer, index) =>
        index === 0 ? { ...layer, enemies: ['kraken'] } : layer,
      ),
    };
    expect(() => createDefense(broken)).toThrow(RangeError);
  });
});

describe('wave numbers', () => {
  it('grows the enemy count wave by wave', () => {
    // floor(count_base + count_per_wave * wave) with the shipped 2 and 0.6.
    expect(waveEnemyCount(balance, 1)).toBe(2);
    expect(waveEnemyCount(balance, 2)).toBe(3);
    expect(waveEnemyCount(balance, 3)).toBe(3);
    expect(waveEnemyCount(balance, 4)).toBe(4);
    expect(waveEnemyCount(balance, 5)).toBe(5);
  });

  it('grows the enemy health by wave, by layer and by type', () => {
    const { waves } = balance;
    const expected = (wave: number, layer: number, mult: number) =>
      waves.enemy_hp_base * waves.hp_growth_per_wave ** wave * (1 + waves.hp_growth_per_layer * layer) * mult;

    expect(enemyHp(balance, 1, 0, 'aberration')).toBeCloseTo(expected(1, 0, 1), 10);
    expect(enemyHp(balance, 5, 0, 'aberration')).toBeCloseTo(expected(5, 0, 1), 10);
    expect(enemyHp(balance, 1, 2, 'aberration')).toBeCloseTo(expected(1, 2, 1), 10);
    expect(enemyHp(balance, 3, 1, 'drowned')).toBeCloseTo(expected(3, 1, 2.5), 10);
    expect(enemyHp(balance, 3, 1, 'moth')).toBeCloseTo(expected(3, 1, 0.6), 10);

    // Deeper and later is always worse, never better.
    expect(enemyHp(balance, 2, 0, 'aberration')).toBeGreaterThan(enemyHp(balance, 1, 0, 'aberration'));
    expect(enemyHp(balance, 1, 1, 'aberration')).toBeGreaterThan(enemyHp(balance, 1, 0, 'aberration'));
  });

  it('puts the first wave on first_wave_sec and the next ones one interval apart', () => {
    expect(waveDueAtSec(balance, 1)).toBe(balance.waves.first_wave_sec);
    expect(waveDueAtSec(balance, 2)).toBe(balance.waves.first_wave_sec + balance.waves.interval_sec);
    expect(waveDueAtSec(balance, 3)).toBe(balance.waves.first_wave_sec + balance.waves.interval_sec * 2);
  });
});

describe('waves coming out', () => {
  it('sends the first wave exactly on first_wave_sec and the second one interval later', () => {
    const state = createShift(balanceWith({ enemyHpBase: UNKILLABLE }), 1);
    const { first_wave_sec: first, interval_sec: interval } = balance.waves;

    step(state, first - 0.01);
    expect(state.defense.wavesSent).toBe(0);
    expect(nextWaveInSec(state.balance, state.defense)).toBeCloseTo(0.01, 6);

    step(state, 0.02);
    expect(state.defense.wavesSent).toBe(1);
    expect(state.defense.enemies).toHaveLength(waveEnemyCount(balance, 1));

    step(state, interval - 0.02);
    expect(state.defense.wavesSent).toBe(1);
    step(state, 0.02);
    expect(state.defense.wavesSent).toBe(2);
  });

  it('takes the enemy types and the health from the layer the drill sits in', () => {
    const shallow = createShift(balanceWith({ firstWaveSec: 1, enemyHpBase: UNKILLABLE }), 1);
    step(shallow, 1.1);
    expect(new Set(shallow.defense.enemies.map((enemy) => enemy.type))).toEqual(
      new Set(balance.layers[0]?.enemies),
    );

    const deep = createShift(balanceWith({ firstWaveSec: 1, enemyHpBase: UNKILLABLE }), 1);
    // Row 12 is layer II: the wave is drawn from where the drill is, not from the surface.
    deep.drill.row = 12;
    step(deep, 1.1);
    const types = new Set(deep.defense.enemies.map((enemy) => enemy.type));
    expect(types).toEqual(new Set(balance.layers[1]?.enemies));

    const aberration = deep.defense.enemies.find((enemy) => enemy.type === 'aberration');
    expect(aberration?.maxHp).toBeCloseTo(enemyHp(deep.balance, 1, 1, 'aberration'), 10);
    const shallowFirst = shallow.defense.enemies[0];
    expect(aberration?.maxHp ?? 0).toBeGreaterThan(shallowFirst?.maxHp ?? 0);
  });

  it('walks the enemies in from both edges', () => {
    const state = createShift(balanceWith({ firstWaveSec: 1, enemyHpBase: UNKILLABLE }), 1);
    step(state, 1.1);
    const sides = new Set(state.defense.enemies.map((enemy) => enemy.side));
    expect(sides).toEqual(new Set(['left', 'right']));
    for (const enemy of state.defense.enemies) {
      expect(enemy.progress).toBeGreaterThanOrEqual(0);
      expect(enemy.progress).toBeLessThan(1);
    }
  });
});

describe('turret', () => {
  it('kills one enemy in hp / dps seconds', () => {
    const state = createShift(balanceWith({ firstWaveSec: 1, ...SINGLE }), 1);
    step(state, 1.01);
    const target = state.defense.enemies[0];
    expect(target).toBeDefined();
    const killSec = (target?.hp ?? 0) / balance.turret.dps_base;

    step(state, killSec - 0.02);
    expect(state.defense.enemies).toHaveLength(1);
    expect(state.defense.enemies[0]?.hp).toBeGreaterThan(0);

    step(state, 0.04);
    expect(state.defense.enemies).toHaveLength(0);
    expect(state.defense.killed).toBe(1);
    expect(state.defense.leaked).toBe(0);
    expect(state.defense.hp).toBe(state.defense.hpMax);
  });

  it('shoots the enemy the player picked and lets the others walk', () => {
    const state = createShift(
      balanceWith({ firstWaveSec: 1, countBase: 0, countPerWave: 2 }),
      1,
    );
    step(state, 1.01);
    expect(state.defense.enemies).toHaveLength(2);
    const [first, second] = state.defense.enemies;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // Left alone the turret would take the older one; the order overrides that.
    expect(turretTarget(state.defense)?.id).toBe(first?.id);
    expect(aimTurret(state, second?.id ?? 0)).toBe(true);
    expect(turretTarget(state.defense)?.id).toBe(second?.id);

    step(state, (second?.hp ?? 0) / balance.turret.dps_base + 0.02);
    expect(state.defense.killed).toBe(1);
    expect(state.defense.enemies.map((enemy) => enemy.id)).toEqual([first?.id]);
    // The order died with its target: the turret picks for itself again.
    expect(state.defense.focusId).toBe(null);
    expect(state.defense.enemies[0]?.hp).toBeGreaterThan(0);
  });

  it('refuses an order for an enemy that is not there', () => {
    const state = createShift(balanceWith({ firstWaveSec: 1, ...SINGLE }), 1);
    step(state, 1.01);
    expect(aimTurret(state, 9999)).toBe(false);
    expect(state.defense.focusId).toBe(null);
  });
});

describe('salvo', () => {
  it('hits every enemy at once and then has to cool down', () => {
    const state = createShift(
      balanceWith({ firstWaveSec: 1, enemyHpBase: UNKILLABLE }),
      1,
    );
    step(state, 1.01);
    const damage = balance.turret.dps_base * balance.turret.salvo_multiplier;
    const before = state.defense.enemies.map((enemy) => ({ id: enemy.id, hp: enemy.hp }));
    expect(before.length).toBeGreaterThan(1);

    expect(fireSalvo(state)).toBe(true);
    for (const was of before) {
      const now = state.defense.enemies.find((enemy) => enemy.id === was.id);
      expect(now?.hp).toBeCloseTo(was.hp - damage, 10);
    }

    expect(isSalvoReady(state.defense)).toBe(false);
    expect(fireSalvo(state)).toBe(false);

    step(state, balance.turret.salvo_cooldown_sec - 0.02);
    expect(isSalvoReady(state.defense)).toBe(false);
    step(state, 0.04);
    expect(isSalvoReady(state.defense)).toBe(true);
    expect(fireSalvo(state)).toBe(true);
  });

  it('does nothing when there is nobody to shoot but still goes on cooldown', () => {
    const state = createShift(balance, 1);
    expect(state.defense.enemies).toHaveLength(0);
    expect(fireSalvo(state)).toBe(true);
    expect(isSalvoReady(state.defense)).toBe(false);
  });
});

describe('the dome taking damage', () => {
  it('loses dome_damage when an enemy arrives, and the enemy is gone', () => {
    const state = createShift(
      balanceWith({ firstWaveSec: 1, enemyHpBase: UNKILLABLE, ...SINGLE }),
      1,
    );
    step(state, 1.01);
    const enemy = state.defense.enemies[0];
    expect(enemy?.type).toBe('aberration');
    const damage = balance.enemies['aberration']?.dome_damage ?? 0;

    step(state, travelSec('aberration') - 0.05);
    expect(state.defense.hp).toBe(state.defense.hpMax);
    expect(state.defense.enemies).toHaveLength(1);

    step(state, 0.1);
    expect(state.defense.hp).toBeCloseTo(state.defense.hpMax - damage, 10);
    expect(state.defense.enemies).toHaveLength(0);
    expect(state.defense.leaked).toBe(1);
    expect(state.defense.killed).toBe(0);
    // One bite each: it does not stand there chewing.
    step(state, 30);
    expect(state.defense.hp).toBeCloseTo(state.defense.hpMax - damage, 10);
  });

  it('raises the warning at the warning share and drops it when the dome is gone', () => {
    const defense = createDefense(balance);
    const share = balance.dome.warning_hp_share;
    expect(isDomeWarning(balance, defense)).toBe(false);

    defense.hp = defense.hpMax * share * 1.1;
    expect(isDomeWarning(balance, defense)).toBe(false);

    // The share itself already counts as low: 30 of 100 is a warning, not "fine".
    defense.hp = defense.hpMax * share;
    expect(domeHpShare(defense)).toBeCloseTo(share, 10);
    expect(isDomeWarning(balance, defense)).toBe(true);

    defense.hp = defense.hpMax * share * 0.5;
    expect(isDomeWarning(balance, defense)).toBe(true);

    // A dome at zero is a breach, not a warning: the shift is already over.
    defense.hp = 0;
    expect(isDomeWarning(balance, defense)).toBe(false);
  });

  it('lights the warning up as the enemies bite the dome down', () => {
    const damage = balance.enemies['aberration']?.dome_damage ?? 0;
    const state = createShift(
      balanceWith({
        domeHp: damage * 1.2,
        firstWaveSec: 1,
        enemyHpBase: UNKILLABLE,
        ...SINGLE,
      }),
      1,
    );
    expect(isDomeWarning(state.balance, state.defense)).toBe(false);

    step(state, 1 + travelSec('aberration') + 0.1);
    expect(state.defense.hp).toBeCloseTo(damage * 0.2, 10);
    expect(state.phase).toBe('running');
    expect(isDomeWarning(state.balance, state.defense)).toBe(true);
  });
});

describe('the dome breaking', () => {
  it('ends the shift, drops the cargo and keeps everything already banked', () => {
    const damage = balance.enemies['aberration']?.dome_damage ?? 0;
    const state = createShift(
      balanceWith({
        domeHp: damage,
        firstWaveSec: 1,
        // One cell fills the cargo: the drill stops instead of digging on while
        // the enemy walks, so the numbers below are the ones the test set up.
        cargoCapacity: layerYield(0),
        enemyHpBase: UNKILLABLE,
        ...SINGLE,
      }),
      1,
    );

    digCell(state, START_COL, 1);
    callElevator(state);
    step(state, 0.125 + balance.shift.elevator_bank_sec + 0.05);
    expect(state.banked).toBe(layerYield(0));

    digCell(state, START_COL, 2);
    const carried = state.cargo;
    expect(carried).toBe(layerYield(0));
    const timeLeft = state.timeLeftSec;

    step(state, travelSec('aberration'));
    expect(state.defense.hp).toBe(0);
    expect(state.phase).toBe('finished');
    expect(state.endReason).toBe('breach');
    expect(state.cargo).toBe(0);
    expect(state.banked).toBe(layerYield(0));
    expect(state.mined).toBe(layerYield(0) * 2);
    expect(state.deepestRow).toBe(2);
    expect(state.defense.enemies).toHaveLength(0);
    expect(state.timeLeftSec).toBeGreaterThan(0);
    expect(state.timeLeftSec).toBeLessThanOrEqual(timeLeft);

    const report = shiftReport(state);
    expect(report.endReason).toBe('breach');
    expect(report.banked).toBe(layerYield(0));
    // What the breach cost: mined but never handed over.
    expect(report.mined - report.banked).toBe(carried);

    // A finished shift takes no more orders and no more waves.
    const wavesAtBreach = state.defense.wavesSent;
    expect(aimDrill(state, START_COL, 3)).toBe(false);
    expect(aimTurret(state, 1)).toBe(false);
    expect(fireSalvo(state)).toBe(false);
    step(state, 120);
    expect(state.defense.wavesSent).toBe(wavesAtBreach);
    expect(state.defense.enemies).toHaveLength(0);
  });
});

describe('waves and the shift clock', () => {
  it('runs the whole shift out on the timer while the waves keep coming', () => {
    const state = createShift(balanceWith({ domeHp: 1e9, cargoCapacity: 1e6 }), 1);
    step(state, balance.shift.duration_sec + balance.shift.elevator_bank_sec + 1);

    expect(state.phase).toBe('finished');
    expect(state.endReason).toBe('timer');
    expect(state.defense.wavesSent).toBeGreaterThan(1);
    expect(state.defense.killed).toBeGreaterThan(0);
    expect(shiftReport(state).waves).toBe(state.defense.wavesSent);
  });

  it('sends no wave after the time is out and clears the enemies away', () => {
    const state = createShift(balanceWith({ domeHp: 1e9, enemyHpBase: UNKILLABLE }), 1);
    step(state, balance.shift.duration_sec);
    expect(state.defense.enemies).toHaveLength(0);
    const sent = state.defense.wavesSent;
    expect(sent).toBeGreaterThan(0);

    step(state, balance.waves.interval_sec * 3);
    expect(state.defense.wavesSent).toBe(sent);
    expect(state.defense.enemies).toHaveLength(0);
    expect(state.endReason).toBe('timer');
  });

  it('gives the same defence for the same shift however time is sliced', () => {
    const bal = balanceWith({ domeHp: 1e9, cargoCapacity: 1e6 });
    const coarse = createShift(bal, 7);
    const fine = createShift(bal, 7);

    step(coarse, 200);
    for (let i = 0; i < 800; i += 1) {
      step(fine, 0.25);
    }

    expect(fine.defense.wavesSent).toBe(coarse.defense.wavesSent);
    expect(fine.defense.killed).toBe(coarse.defense.killed);
    expect(fine.defense.leaked).toBe(coarse.defense.leaked);
    expect(fine.defense.hp).toBeCloseTo(coarse.defense.hp, 6);
    expect(fine.defense.enemies.map((enemy) => enemy.id)).toEqual(
      coarse.defense.enemies.map((enemy) => enemy.id),
    );
  });
});
