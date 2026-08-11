import type { Balance, EnemyBalance } from './balance.js';

/**
 * Dome defence: waves, enemies, turret, salvo. Deterministic like the rest of
 * src/sim — no graphics, no Math.random, no clock. Waves are scheduled on the
 * clock this module is advanced with, so the same shift always sends the same
 * enemies in the same order.
 *
 * An enemy is one number: `progress`, 0 at the edge of the dome zone and 1 at
 * the dome. Turning that into pixels is the view's business.
 *
 * The shift owns this state and drives it (src/sim/shift.ts): it advances the
 * clocks up to the next event, then resolves everything that came due.
 */

/** Floating point slack for time and progress comparisons. Not a game number. */
const EPS = 1e-9;

/**
 * Smallest slice the defence ever asks the shift clock for. An event that lands
 * exactly on a float hair would otherwise report "due in 0 seconds" forever and
 * freeze the shift; a slice this short costs less than a nanosecond of damage.
 */
const MIN_EVENT_SEC = 4 * EPS;

/** Edge of the dome zone an enemy walks in from. Alternates inside a wave. */
export type EnemySide = 'left' | 'right';

export interface Enemy {
  readonly id: number;
  /** Key in `balance.enemies`. */
  readonly type: string;
  /** Wave that sent it, counted from 1. */
  readonly wave: number;
  readonly side: EnemySide;
  /** Place in its wave, from 0. The view spreads a wave out by it. */
  readonly slot: number;
  readonly maxHp: number;
  hp: number;
  /** 0 at the edge of the dome zone, 1 at the dome. */
  progress: number;
}

export interface DefenseState {
  /** Dome health. Only an enemy that reaches the dome takes it away. */
  hp: number;
  readonly hpMax: number;
  /** Seconds of running shift so far: waves are scheduled on this clock. */
  elapsedSec: number;
  /** Waves already sent; also the number of the last wave. */
  wavesSent: number;
  enemies: Enemy[];
  /** Enemy the player pointed the turret at; null means "the closest one". */
  focusId: number | null;
  /** Seconds left of the salvo cooldown. */
  salvoCooldownSec: number;
  /** Enemies that reached the dome this shift. */
  leaked: number;
  /** Enemies shot down this shift. */
  killed: number;
  nextEnemyId: number;
}

/** Fresh dome at full health, no enemies, salvo ready. */
export function createDefense(balance: Balance): DefenseState {
  const { dome, waves, turret } = balance;
  if (!(dome.hp_base > 0)) {
    throw new RangeError(`dome.hp_base must be positive, got ${dome.hp_base}`);
  }
  if (!(waves.enemy_travel_sec > 0)) {
    throw new RangeError(`waves.enemy_travel_sec must be positive, got ${waves.enemy_travel_sec}`);
  }
  if (!(waves.interval_sec > 0)) {
    throw new RangeError(`waves.interval_sec must be positive, got ${waves.interval_sec}`);
  }
  if (!(turret.dps_base > 0)) {
    throw new RangeError(`turret.dps_base must be positive, got ${turret.dps_base}`);
  }
  // A typo in the enemy list of a layer would otherwise only show up mid-shift.
  for (const layer of balance.layers) {
    for (const type of layer.enemies) {
      enemyBalance(balance, type);
    }
  }

  return {
    hp: dome.hp_base,
    hpMax: dome.hp_base,
    elapsedSec: 0,
    wavesSent: 0,
    enemies: [],
    focusId: null,
    salvoCooldownSec: 0,
    leaked: 0,
    killed: 0,
    nextEnemyId: 1,
  };
}

/* ----------------------------------------------------------------- formulas */

export function enemyBalance(balance: Balance, type: string): EnemyBalance {
  const enemy = balance.enemies[type];
  if (!enemy) {
    throw new RangeError(`enemy "${type}" is not in balance.enemies`);
  }
  return enemy;
}

/**
 * Health of one enemy (PLAN_V1 §6): the wave makes it grow, the layer the drill
 * sits in makes it grow again — the deeper you dig, the tougher they come.
 */
export function enemyHp(balance: Balance, wave: number, layerIndex: number, type: string): number {
  const { waves } = balance;
  return (
    waves.enemy_hp_base *
    waves.hp_growth_per_wave ** wave *
    (1 + waves.hp_growth_per_layer * layerIndex) *
    enemyBalance(balance, type).hp_mult
  );
}

/** How many enemies wave `wave` sends. */
export function waveEnemyCount(balance: Balance, wave: number): number {
  const { waves } = balance;
  return Math.max(0, Math.floor(waves.count_base + waves.count_per_wave * wave));
}

/** Second of the shift wave `wave` comes out on. */
export function waveDueAtSec(balance: Balance, wave: number): number {
  const { waves } = balance;
  return waves.first_wave_sec + waves.interval_sec * (wave - 1);
}

/** Seconds until the next wave. */
export function nextWaveInSec(balance: Balance, defense: DefenseState): number {
  return Math.max(0, waveDueAtSec(balance, defense.wavesSent + 1) - defense.elapsedSec);
}

/** Share of the way to the dome an enemy covers in one second. */
function progressPerSec(balance: Balance, type: string): number {
  return enemyBalance(balance, type).speed / balance.waves.enemy_travel_sec;
}

/* ------------------------------------------------------------------ reading */

export function domeHpShare(defense: DefenseState): number {
  return defense.hpMax > 0 ? Math.min(1, Math.max(0, defense.hp / defense.hpMax)) : 0;
}

/** Siren time: the dome is low enough that the player has to look up (PLAN_V1 §4). */
export function isDomeWarning(balance: Balance, defense: DefenseState): boolean {
  return defense.hp > 0 && domeHpShare(defense) <= balance.dome.warning_hp_share;
}

export function isSalvoReady(defense: DefenseState): boolean {
  return defense.salvoCooldownSec <= EPS;
}

/** Cooldown left, 0 when ready and 1 right after a salvo. */
export function salvoCooldownShare(balance: Balance, defense: DefenseState): number {
  const total = balance.turret.salvo_cooldown_sec;
  if (!(total > 0)) {
    return 0;
  }
  return Math.min(1, Math.max(0, defense.salvoCooldownSec / total));
}

export function findEnemy(defense: DefenseState, enemyId: number): Enemy | null {
  return defense.enemies.find((enemy) => enemy.id === enemyId) ?? null;
}

/**
 * Who the turret shoots: the enemy the player picked while it lives, otherwise
 * the one closest to the dome. Ties go to the older enemy, so it never flickers.
 */
export function turretTarget(defense: DefenseState): Enemy | null {
  if (defense.focusId !== null) {
    const picked = findEnemy(defense, defense.focusId);
    if (picked) {
      return picked;
    }
  }
  let best: Enemy | null = null;
  for (const enemy of defense.enemies) {
    if (!best || enemy.progress > best.progress + EPS) {
      best = enemy;
    }
  }
  return best;
}

/* ------------------------------------------------------------------- orders */

/**
 * Point the turret at one enemy. It stays the target until it dies or reaches
 * the dome, then the turret goes back to picking the closest one itself.
 */
export function aimTurretAt(defense: DefenseState, enemyId: number): boolean {
  if (!findEnemy(defense, enemyId)) {
    return false;
  }
  defense.focusId = enemyId;
  return true;
}

/** One salvo: `dps_base * salvo_multiplier` to every living enemy at once. */
export function fireSalvoAt(balance: Balance, defense: DefenseState): boolean {
  if (!isSalvoReady(defense)) {
    return false;
  }
  const damage = balance.turret.dps_base * balance.turret.salvo_multiplier;
  for (const enemy of defense.enemies) {
    enemy.hp = Math.max(0, enemy.hp - damage);
  }
  defense.salvoCooldownSec = balance.turret.salvo_cooldown_sec;
  return true;
}

/* --------------------------------------------------------------- the clocks */

/**
 * Seconds until the next thing that changes the defence on its own: a wave, a
 * kill, an enemy reaching the dome, or a faster enemy overtaking the target.
 * Slicing time on these keeps one long step equal to many short ones.
 */
export function defenseTimeToNextEvent(balance: Balance, defense: DefenseState): number {
  let time = nextWaveInSec(balance, defense);

  const target = turretTarget(defense);
  if (target) {
    time = Math.min(time, target.hp / balance.turret.dps_base);
  }

  const targetRate = target ? progressPerSec(balance, target.type) : 0;
  for (const enemy of defense.enemies) {
    const rate = progressPerSec(balance, enemy.type);
    if (rate > 0) {
      time = Math.min(time, (1 - enemy.progress) / rate);
    }
    if (target && enemy !== target && rate > targetRate && enemy.progress < target.progress) {
      time = Math.min(time, (target.progress - enemy.progress) / (rate - targetRate));
    }
  }

  return Math.max(MIN_EVENT_SEC, time);
}

/** Runs the defence clocks for `dtSec` seconds without crossing an event. */
export function advanceDefense(balance: Balance, defense: DefenseState, dtSec: number): void {
  defense.elapsedSec += dtSec;
  defense.salvoCooldownSec = Math.max(0, defense.salvoCooldownSec - dtSec);

  const target = turretTarget(defense);
  if (target) {
    target.hp = Math.max(0, target.hp - balance.turret.dps_base * dtSec);
  }
  for (const enemy of defense.enemies) {
    enemy.progress = Math.min(1, enemy.progress + progressPerSec(balance, enemy.type) * dtSec);
  }
}

/**
 * Applies everything that came due: waves out, dead enemies gone, arrivals
 * biting the dome. `layerIndex` is the layer the drill sits in right now — it
 * decides how tough the wave is and which enemies it is made of.
 *
 * Returns true when something changed, so the shift can resolve again.
 */
export function resolveDefense(balance: Balance, defense: DefenseState, layerIndex: number): boolean {
  let changed = false;

  while (defense.elapsedSec >= waveDueAtSec(balance, defense.wavesSent + 1) - EPS) {
    spawnWave(balance, defense, defense.wavesSent + 1, layerIndex);
    changed = true;
  }

  // Kills first: an enemy shot down in the same instant it arrives does no
  // damage, so the turret always wins that tie.
  const survivors: Enemy[] = [];
  for (const enemy of defense.enemies) {
    if (enemy.hp <= EPS) {
      defense.killed += 1;
      changed = true;
      continue;
    }
    if (enemy.progress >= 1 - EPS) {
      // One hit, then it is gone: the worst a wave can do is known in advance.
      defense.hp = Math.max(0, defense.hp - enemyBalance(balance, enemy.type).dome_damage);
      defense.leaked += 1;
      changed = true;
      continue;
    }
    survivors.push(enemy);
  }
  if (survivors.length !== defense.enemies.length) {
    defense.enemies = survivors;
    if (defense.focusId !== null && !findEnemy(defense, defense.focusId)) {
      defense.focusId = null;
    }
  }

  return changed;
}

/** Enemies leave with the wave that sent them: they only exist while running. */
export function clearEnemies(defense: DefenseState): void {
  defense.enemies = [];
  defense.focusId = null;
}

function spawnWave(balance: Balance, defense: DefenseState, wave: number, layerIndex: number): void {
  const layer = balance.layers[layerIndex];
  const types = layer?.enemies ?? [];
  const count = waveEnemyCount(balance, wave);
  defense.wavesSent = wave;
  if (types.length === 0) {
    return;
  }

  for (let slot = 0; slot < count; slot += 1) {
    const type = types[slot % types.length] ?? types[0] ?? '';
    const hp = enemyHp(balance, wave, layerIndex, type);
    defense.enemies.push({
      id: defense.nextEnemyId,
      type,
      wave,
      side: slot % 2 === 0 ? 'left' : 'right',
      slot,
      maxHp: hp,
      hp,
      progress: 0,
    });
    defense.nextEnemyId += 1;
  }
}
