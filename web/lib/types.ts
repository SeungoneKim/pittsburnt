export type Hour = 8 | 12 | 15 | 18;

export interface Persona {
  key: string;
  label: string;
  speed_mps: number;
  planning_weight: number;
  trips: number;
  /** True for "All pedestrians", which is the sum of the other cohorts. */
  derived?: boolean;
  composition?: string[];
  composition_note?: string;
}

export interface Scenario {
  key: string;
  label: string;
  delta_c: number;
  is_extrapolated: boolean;
  /** How many of the four snapshot hours reach Very Strong Heat Stress. */
  hours_crossing: number;
  peak_utci_c: number;
}

export interface Intervention {
  label: string;
  cost_usd: number;
  shade_m: number;
}

export interface CanopyMeta {
  bounds: [number, number][];
  cover_pct: number;
  context_cover_pct: number;
  source: string;
  vintage: string;
}

/** The square the model actually runs in. */
export interface Scope {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Meta {
  center: { lat: number; lon: number };
  corridors: string[];
  hours: Hour[];
  seg_ids: string[];
  budgets: number[];
  personas: Persona[];
  scenarios: Scenario[];
  interventions: Record<string, Intervention>;
  severe_threshold_utci_c: number;
  heat_load_base_utci_c: number;
  hero_corridors: string[];
  dataset_version: string;
  value_meta: Record<string, import("./provenance").ValueMeta>;
  waiting_exposure: WaitingMeta | null;
  variants: string[];
  canopy: CanopyMeta | null;
  scope: Scope;
  climate_method: Record<string, unknown>;
  canopy_source: string;
  canopy_vintage: string;
  trip_seed: number;
}

export interface Conditions {
  air_temp_c: number;
  rh_pct: number;
  wind_ms: number;
  tmrt_sun_c: number;
  tmrt_shade_c: number;
  shade_relief_c: number;
}

/** One crash test, in engine segment order. */
export interface WaitingMeta {
  transit_trip_share: number;
  transit_trip_share_range: [number, number];
  status: string;
  basis: string;
  wait_rule: string;
  wait_source: string;
  stops: number;
  median_wait_minutes: number;
  unsheltered_stops: number;
}

export interface DayHour {
  hour: number;
  severe: number;
  heat_load: number;
  utci_sun_c: number;
  utci_shade_c: number;
  crosses: boolean;
  /** Degrees above (+) or below (-) the severe threshold, in full sun. */
  headroom_c: number;
}

export interface CrashResult {
  input_hash: string;
  day_profile: DayHour[];
  snapshot_id: string;
  status: string;
  severe_total: number;          // walking + waiting, at or above UTCI 38 C
  walking_severe_total: number;
  waiting_severe_total: number;
  heat_load_total: number;
  weighted_severe_total: number;
  planning_weight: number;
  utci_sun_c: number;
  utci_shade_c: number;
  conditions: Conditions;
  severe_minutes: number[];
  heat_load: number[];
  sun: number[];
  minutes: number[];
}

/** Corridor vs whole-network impact, always reported together. */
export interface ImpactScope {
  label: string;
  length_km: number;
  segments: number;
  before_metric: number;
  after_metric: number;
  reduction_pct: number;
  metric: string;
}

export interface Placement {
  seg_id: string;
  kind: string;
  count: number;
}

export interface AdaptResult {
  input_hash: string;
  snapshot_id: string;
  status: string;
  spent_usd: number;
  counts: Record<string, number>;
  metric_used: string;
  before_severe: number;
  after_severe: number;
  before_walking_severe: number;
  after_walking_severe: number;
  before_waiting_severe: number;
  after_waiting_severe: number;
  before_heat_load: number;
  after_heat_load: number;
  reduction_pct: number;
  impact_scopes: ImpactScope[];
  /** Post-intervention values of whichever metric is in use. */
  metric_values: number[];
  placements: Placement[];
}

/** Which data path answered — surfaced in the UI so the mode is never a guess. */
export type SourceMode = "live" | "fallback";

export interface Selection {
  scenario: string;
  hour: Hour;
  persona: string;
  budget: number;
  /** Which intervention types the optimiser may spend on; "all" or one kind. */
  variant: string;
}
