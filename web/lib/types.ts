export type Hour = 8 | 12 | 15 | 18;

export interface Persona {
  key: string;
  label: string;
  speed_mps: number;
  planning_weight: number;
  trips: number;
}

export interface Scenario {
  key: string;
  label: string;
  delta_c: number;
  is_extrapolated: boolean;
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
  variants: string[];
  canopy: CanopyMeta | null;
  scope: Scope;
  climate_method: Record<string, unknown>;
  canopy_source: string;
  canopy_vintage: string;
  trip_seed: number;
}

/** One crash test: an exposure value per segment, in engine segment order. */
export interface CrashResult {
  total: number;
  total_unweighted: number;
  heat_index_c: number;
  exposure: number[];
  sun: number[];
}

export interface Placement {
  seg_id: string;
  kind: string;
  count: number;
}

export interface AdaptResult {
  spent_usd: number;
  counts: Record<string, number>;
  before_total: number;
  after_total: number;
  reduction_pct: number;
  exposure: number[];
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
