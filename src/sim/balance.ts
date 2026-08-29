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
