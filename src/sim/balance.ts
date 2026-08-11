/**
 * Types mirroring content/balance.json. Every game number lives in that file,
 * this module only describes its shape.
 */

/** Inclusive row range of a layer: [firstRow, lastRow]. */
export type RowRange = readonly [number, number];

export interface LayerBalance {
  readonly id: string;
  readonly name: string;
  readonly rows: RowRange;
  readonly hardness_sec: number;
  readonly yield: number;
  readonly enemies: readonly string[];
}

export interface ShiftBalance {
  readonly duration_sec: number;
  readonly grid_width: number;
  readonly grid_depth: number;
  readonly elevator_bank_sec: number;
  readonly checkpoint_every_rows: number;
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
  readonly hp_growth_per_wave: number;
  readonly hp_growth_per_layer: number;
}

export interface UpgradeItemBalance {
  readonly name: string;
  readonly effect: string;
  readonly cost_base: number;
  readonly step: number;
  readonly max_level?: number;
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
