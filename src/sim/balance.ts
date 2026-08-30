/**
 * Types mirroring content/balance.json. Every game number lives in that file,
 * this module only describes its shape.
 */

/** Inclusive row range of a layer: [firstRow, lastRow]. */
export type RowRange = readonly [number, number];

/** One currency. `premium` marks what offline work never produces. */
export interface ResourceBalance {
  readonly name: string;
  readonly premium: boolean;
}

export interface LayerBalance {
  readonly id: string;
  readonly name: string;
  readonly rows: RowRange;
  readonly hardness_sec: number;
  readonly yield: number;
  /** Chance in [0, 1] that a dug cell of this layer drops one crystal. */
  readonly crystal_chance: number;
  readonly enemies: readonly string[];
}

export interface ShiftBalance {
  readonly duration_sec: number;
  readonly grid_width: number;
  readonly grid_depth: number;
  readonly elevator_bank_sec: number;
  /** Even spacing of the elevator checkpoints. Ignored when `checkpoint_rows` is set. */
  readonly checkpoint_every_rows: number;
  /**
   * The elevator checkpoints outright, when they are not evenly spaced — the
   * layers do not dig at the same speed, so their gaps should not be equal
   * either. See `checkpointRows` in src/sim/progress.ts.
   */
  readonly checkpoint_rows?: readonly number[];
  readonly crystals_per_new_checkpoint: number;
  readonly quota_share_of_best: number;
  readonly quota_min: number;
  readonly quota_bonus: number;
}

export interface DomeBalance {
  readonly hp_base: number;
  readonly warning_hp_share: number;
}

export interface TurretBalance {
  readonly dps_base: number;
  readonly salvo_multiplier: number;
  readonly salvo_cooldown_sec: number;
}

export interface CargoBalance {
  readonly capacity_base: number;
}

export interface DrillBalance {
  readonly speed_base: number;
  /** Travel speed of the drill, in grid cells per second. The road costs time. */
  readonly move_rows_per_sec: number;
}

export interface EnemyBalance {
  readonly hp_mult: number;
  readonly speed: number;
  readonly dome_damage: number;
}

export interface WavesBalance {
  readonly first_wave_sec: number;
  readonly interval_sec: number;
  readonly count_base: number;
  readonly count_per_wave: number;
  /** Health of an enemy with `hp_mult` 1 in wave 0 of the first layer. */
  readonly enemy_hp_base: number;
  /** Seconds an enemy with `speed` 1 needs to reach the dome from the edge. */
  readonly enemy_travel_sec: number;
  readonly hp_growth_per_wave: number;
  readonly hp_growth_per_layer: number;
}

export interface UpgradeItemBalance {
  readonly name: string;
  readonly effect: string;
  /** Key in `Balance.resources` the upgrade is paid with. */
  readonly currency: string;
  readonly cost_base: number;
  readonly step: number;
  readonly max_level?: number;
  /** Overrides `UpgradesBalance.cost_growth` for this item. */
  readonly cost_growth?: number;
}

export interface UpgradesBalance {
  readonly cost_growth: number;
  readonly items: Readonly<Record<string, UpgradeItemBalance>>;
}

export interface OfflineBalance {
  readonly scrap_per_hour_per_depth: number;
  readonly cap_hours: number;
}

export interface PrestigeBalance {
  readonly wave_hp_mult_per_tier: number;
  readonly yield_mult_per_tier: number;
}

export interface AdsBalance {
  readonly enabled: boolean;
}

export interface Balance {
  /** Every currency of the game, keyed by id. The wallet is a map over these. */
  readonly resources: Readonly<Record<string, ResourceBalance>>;
  readonly shift: ShiftBalance;
  readonly dome: DomeBalance;
  readonly turret: TurretBalance;
  readonly cargo: CargoBalance;
  readonly drill: DrillBalance;
  readonly layers: readonly LayerBalance[];
  readonly enemies: Readonly<Record<string, EnemyBalance>>;
  readonly waves: WavesBalance;
  readonly upgrades: UpgradesBalance;
  readonly offline: OfflineBalance;
  readonly prestige: PrestigeBalance;
  readonly ads: AdsBalance;
}

/* ----------------------------------------------------- what the owner typed */

/**
 * What is wrong with the numbers in content/balance.json, said in the language
 * of the person who edits it. An empty list means nothing was found.
 *
 * The file opens with «Правь смело», and it means it: the owner tunes the game
 * without a programmer, by hand, in a text editor. That is the point of the
 * file, and it is also why a few of its numbers are not sliders but walls — get
 * one of them wrong and the game does not play badly, it stops playing, with
 * nothing on screen to say why. Those are the ones checked here. Everything else
 * is a matter of taste and stays unchecked: this is a guard against a mine that
 * cannot be dug, not a reviewer of the balance.
 *
 * Deliberately not a `throw`: `src/sim` decides nothing about what the player
 * sees. The list goes to whoever loaded the file (`src/game/loadBalance.ts`),
 * and that is where an unplayable balance turns into a message.
 */
export function balanceProblems(balance: Balance): readonly string[] {
  const problems: string[] = [];

  // A five-year plan is «руда богаче, волны крепче» (PLAN_V1 §5), so both
  // multipliers are raised to the power of the tier and both must be at least
  // one. Below one they shrink with every win — the reward for reaching the
  // bottom becomes a poorer mine — and at zero or below the arithmetic stops
  // meaning anything at all: the ore, the backpack and the enemies all collapse
  // to nothing on the second plan.
  const prestige: Partial<PrestigeBalance> = balance.prestige ?? {};
  for (const [key, value] of [
    ['yield_mult_per_tier', prestige.yield_mult_per_tier],
    ['wave_hp_mult_per_tier', prestige.wave_hp_mult_per_tier],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`prestige.${key} должно быть числом, а не «${String(value)}»`);
    } else if (value < 1) {
      problems.push(
        `prestige.${key} = ${value}: пятилетка не может быть слабее предыдущей, нужно не меньше 1`,
      );
    }
  }

  // The hard wall of §5. A cell whose scrap does not fit an empty cargo can
  // never be started: the drill blocks, hands over an empty backpack, comes back
  // and blocks again, for ever, at any upgrade level. `effectiveBalance` keeps
  // this true at every cargo level and in every five-year plan on its own — it
  // bends the backpack and the ore by one factor and cuts both down to whole
  // scrap together — but it can only preserve what balance.json starts with.
  // Write a layer richer than the cargo here and the mine is dead from the first
  // shift on, and no code downstream can rescue it.
  const capacity = balance.cargo?.capacity_base;
  const layers = Array.isArray(balance.layers) ? balance.layers : [];
  if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0) {
    problems.push(
      `cargo.capacity_base должно быть положительным числом, а не «${String(capacity)}»`,
    );
  } else {
    for (const layer of layers) {
      if (typeof layer?.yield !== 'number' || !Number.isFinite(layer.yield) || layer.yield <= 0) {
        problems.push(`yield слоя ${layer?.id ?? '?'} должен быть положительным числом`);
      } else if (layer.yield > capacity) {
        problems.push(
          `слой ${layer.id}: yield ${layer.yield} больше карго ${capacity} — ` +
            'такая клетка не влезет в пустое карго и не выкопается никогда',
        );
      }
    }
  }

  // The cargo branch scales the backpack and the ore by the same fraction, so a
  // negative step shrinks both towards zero and eventually past it: at step
  // -0.0625 the sixteenth level leaves a capacity of nothing and a cell worth
  // nothing, and the trip length becomes NaN. The wall above only guards the
  // numbers balance.json starts with; this guards where the branch takes them.
  const cargoStep = balance.upgrades?.items?.cargo?.step;
  if (cargoStep !== undefined && (typeof cargoStep !== 'number' || !(cargoStep > 0))) {
    problems.push(
      `upgrades.items.cargo.step = «${String(cargoStep)}»: ветка карго двигает и ёмкость, ` +
        'и добычу — шаг обязан быть положительным, иначе ходка обращается в ноль',
    );
  }

  return problems;
}
