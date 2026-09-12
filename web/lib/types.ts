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
  /** The exact hours that reach Very Strong Heat Stress - not a count. */
  crossing_hours: number[];
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

export interface BaselineState {
  label: string;
  air_temp_c: number;
  utci_sun_c: number;
  heat_load: number;
  severe: number;
}

export interface CrashResult {
  input_hash: string;
  day_profile: DayHour[];
  /** The observed hot-day baseline at the same hour, for context. */
  baseline_state: BaselineState;
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

export interface RankTrace {
  by_kind: Record<string, {
    units: number; cost_usd: number; severe_minutes_saved: number;
    heat_load_saved: number; severe_per_1k_usd: number;
  }>;
  best_site: { seg_id: string; kind: string; cost_usd: number;
    severe_minutes_saved: number } | null;
  placements_considered: number;
  unspent_usd: number;
  unbought: { kind: string; label: string; cost_usd: number; reason: string }[];
  objective: string;
  claim: string;
}

export interface UnitPlacement {
  unitId: string;
  kind: "tree" | "shaded_shelter";
  segmentId: string;
  stopId: string | null;
  lon: number;
  lat: number;
  costUsd: number;
  order: number;
  phase: "service_floor" | "marginal";
}

export interface ServiceFloorSite {
  corridor: string;
  seg_id: string;
  waiting_severe_minutes_avoided: number;
}

export interface AdaptResult {
  input_hash: string;
  rank_trace: RankTrace;
  policy: string;
  policy_label: string;
  service_floor: ServiceFloorSite[];
  /** Post-intervention environment, from the engine - never reconstructed. */
  after_sun: number[];
  after_utci_c: number[];
  unit_placements: UnitPlacement[];
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

/**
 * Nothing is pre-answered.
 *
 * The tool opens on a context map, not on a result for a question nobody
 * asked. Scenario, hour and persona all start null and the Crash Test is
 * disabled until a person has chosen all three - so any number on screen is
 * an answer to something they actually selected.
 */
export interface Selection {
  scenario: string | null;
  hour: Hour | null;
  persona: string | null;
  budget: number;
  /** Allocation policy: service floor first, or pure marginal efficiency. */
  policy: "balanced_protection" | "pure_efficiency";
}

/** A selection with every required field present. */
export interface ReadySelection extends Selection {
  scenario: string;
  hour: Hour;
  persona: string;
}

export function isReady(s: Selection): s is ReadySelection {
  return s.scenario !== null && s.hour !== null && s.persona !== null;
}

/** Agents can appear once we know who is walking and when. */
export function canShowPeople(s: Selection): boolean {
  return s.persona !== null && s.hour !== null;
}
