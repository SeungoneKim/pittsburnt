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
  /** Modelled shade footprint per intervention, in metres. */
  footprint_m: Record<string, { along_m: number; across_m: number }>;
  /** Minimum spacing between two purchased trees, in metres. */
  site_spacing_m: number;
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
  /** Person-minute-weighted UTCI the cohort actually felt. */
  experienced_utci_c: number;
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
  /**
   * Person-minute-weighted UTCI: what the modelled cohort actually
   * experienced across walking and waiting, not the full-sun anchor and not
   * an unweighted mean over 2,409 street segments.
   */
  experienced_utci_c: number;
  person_minutes_total: number;
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
  /** Stable id of the candidate site this unit was bought onto. */
  siteId: string;
  kind: "tree" | "shaded_shelter";
  segmentId: string;
  stopId: string | null;
  lon: number;
  lat: number;
  /** Street bearing at the site, so shade is drawn along the footway. */
  bearing_deg: number;
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
  /** Engine-owned shade geometry. The map draws it; it never invents it. */
  shade_footprints: GeoJSON.FeatureCollection;
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
  before_experienced_utci_c: number;
  after_experienced_utci_c: number;
  reduction_pct: number;
  impact_scopes: ImpactScope[];
  /** Post-intervention values of whichever metric is in use. */
  metric_values: number[];
  placements: Placement[];
  /** Present only when a user-confirmed custom solution built this plan. */
  custom?: CustomSolution;
  comparison?: SolutionComparison;
}

/** A measure a person proposed, gate-checked and confirmed, then priced. */
export interface CustomSolution {
  key: string;
  label: string;
  cost_usd: number;
  block: number;
  shade_m: number;
  mechanism: string;
}

/**
 * The same measure run two ways over the identical scenario and budget:
 * alone, and competing with the built-ins. The second number is usually the
 * interesting one - a measure can work and still lose on cost per unit of
 * shade, and that is a finding rather than a failure.
 */
export interface SolutionComparison {
  before_severe: number;
  solo: {
    units: number; spent_usd: number; after_severe: number;
    after_heat_load: number; reduction_pct: number;
  };
  mixed: {
    counts: Record<string, number>; custom_units: number; spent_usd: number;
    after_severe: number; after_heat_load: number; reduction_pct: number;
  };
  unbought: { kind: string; label: string; reason: string }[];
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
