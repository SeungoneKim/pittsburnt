/**
 * Data access with a hard reliability guarantee.
 *
 * The brief's rule: "If live APIs fail: all core demo data should have a
 * local cached GeoJSON/JSON fallback." So every call tries the FastAPI
 * service first and silently falls back to the precomputed static bundle in
 * /public/data. The demo cannot be broken by a dead backend, a bad network,
 * or a venue's wifi.
 *
 * The only capability lost in fallback mode is an arbitrary budget: static
 * results exist for the preset budgets only.
 */
import type {
  AdaptResult, CrashResult, ImpactScope, Meta, Placement, Selection, SourceMode,
} from "./types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TIMEOUT_MS = 2500;

let mode: SourceMode = "live";
const listeners = new Set<(m: SourceMode) => void>();

export function onModeChange(fn: (m: SourceMode) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setMode(m: SourceMode) {
  if (m !== mode) {
    mode = m;
    listeners.forEach((fn) => fn(m));
  }
}

export function getMode(): SourceMode {
  return mode;
}

async function tryApi<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const res = await fetch(`${API}${path}`, { ...init, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function statik<T>(file: string): Promise<T> {
  const res = await fetch(`/data/${file}`);
  if (!res.ok) throw new Error(`fallback asset missing: ${file}`);
  return (await res.json()) as T;
}

// The static bundle is fetched once and reused for every subsequent answer.
const bundle: {
  crash?: { sun_by_hour: Record<string, number[]>; results: Record<string, CrashResult> };
  adapts?: { kinds: string[]; variants: string[]; results: Record<string, RawAdapt> };
  meta?: Meta;
} = {};

interface RawAdapt {
  spent_usd: number;
  counts: Record<string, number>;
  metric_used: string;
  before_severe: number;
  after_severe: number;
  before_heat_load: number;
  after_heat_load: number;
  reduction_pct: number;
  impact_scopes: ImpactScope[];
  changed: [number, number][];
  placements: [number, number, number][];
}

export async function loadMeta(): Promise<Meta> {
  if (bundle.meta) return bundle.meta;
  // /meta on the API and the static meta.json carry different shapes; the
  // static one is canonical for the UI because it also holds seg_ids.
  const m = await statik<Meta>("meta.json");
  bundle.meta = m;
  const live = await tryApi<{ ok: boolean }>("/health");
  setMode(live ? "live" : "fallback");
  return m;
}

async function crashBundle() {
  if (!bundle.crash) bundle.crash = await statik("crash_tests.json");
  return bundle.crash!;
}

async function adaptBundle() {
  if (!bundle.adapts) bundle.adapts = await statik("adapts.json");
  return bundle.adapts!;
}

export async function crashTest(sel: Selection): Promise<CrashResult> {
  const live = await tryApi<{
    severe_person_minutes: number; heat_load: number;
    weighted_severe_person_minutes: number; planning_weight: number;
    conditions: CrashResult["conditions"] & {
      utci_sun_c: number; utci_shade_c: number;
    };
    segments: { severe_minutes: number; heat_load: number;
                sun_exposure: number; minutes: number }[];
  }>("/crash-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scenario: sel.scenario, hour: sel.hour, persona: sel.persona,
    }),
  });

  if (live) {
    setMode("live");
    const { utci_sun_c, utci_shade_c, ...cond } = live.conditions;
    return {
      severe_total: live.severe_person_minutes,
      heat_load_total: live.heat_load,
      weighted_severe_total: live.weighted_severe_person_minutes,
      planning_weight: live.planning_weight,
      utci_sun_c, utci_shade_c, conditions: cond,
      severe_minutes: live.segments.map((s) => s.severe_minutes),
      heat_load: live.segments.map((s) => s.heat_load),
      sun: live.segments.map((s) => s.sun_exposure),
      minutes: live.segments.map((s) => s.minutes),
    };
  }

  setMode("fallback");
  const b = await crashBundle();
  const r = b.results[`${sel.scenario}|${sel.hour}|${sel.persona}`];
  if (!r) throw new Error("no precomputed result for that combination");
  return { ...r, sun: b.sun_by_hour[String(sel.hour)] };
}

export async function adapt(sel: Selection, before: CrashResult): Promise<AdaptResult> {
  const live = await tryApi<{
    spent_usd: number; counts: Record<string, number>; metric_used: string;
    before_severe: number; after_severe: number;
    before_heat_load: number; after_heat_load: number;
    reduction_pct: number; impact_scopes: ImpactScope[];
    segments: { severe_minutes: number; heat_load: number }[];
    placements: { seg_id: string; kind: string }[];
  }>("/adapt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scenario: sel.scenario, hour: sel.hour, persona: sel.persona,
      budget_usd: sel.budget,
      kinds: sel.variant === "all" ? null : [sel.variant],
    }),
  });

  if (live) {
    setMode("live");
    const tally = new Map<string, Placement>();
    for (const p of live.placements) {
      const k = `${p.seg_id}|${p.kind}`;
      const cur = tally.get(k);
      if (cur) cur.count += 1;
      else tally.set(k, { seg_id: p.seg_id, kind: p.kind, count: 1 });
    }
    const useSevere = live.metric_used === "severe_person_minutes";
    return {
      spent_usd: live.spent_usd, counts: live.counts,
      metric_used: live.metric_used,
      before_severe: live.before_severe, after_severe: live.after_severe,
      before_heat_load: live.before_heat_load,
      after_heat_load: live.after_heat_load,
      reduction_pct: live.reduction_pct,
      impact_scopes: live.impact_scopes,
      metric_values: live.segments.map((s) =>
        useSevere ? s.severe_minutes : s.heat_load),
      placements: [...tally.values()],
    };
  }

  setMode("fallback");
  const [b, meta] = [await adaptBundle(), await loadMeta()];
  const r = b.results[
    `${sel.scenario}|${sel.hour}|${sel.persona}|${sel.budget}|${sel.variant}`];
  if (!r) throw new Error("no precomputed adapt for that budget");
  // Static results ship as a diff against the baseline; rebuild the full array.
  const useSevere = r.metric_used === "severe_person_minutes";
  const metric_values = (useSevere ? before.severe_minutes : before.heat_load).slice();
  for (const [i, v] of r.changed) metric_values[i] = v;
  return {
    spent_usd: r.spent_usd, counts: r.counts, metric_used: r.metric_used,
    before_severe: r.before_severe, after_severe: r.after_severe,
    before_heat_load: r.before_heat_load, after_heat_load: r.after_heat_load,
    reduction_pct: r.reduction_pct, impact_scopes: r.impact_scopes,
    metric_values,
    placements: r.placements.map(([si, ki, n]) => ({
      seg_id: meta.seg_ids[si], kind: b.kinds[ki], count: n,
    })),
  };
}

export async function loadGeo(name: string) {
  return statik<GeoJSON.FeatureCollection>(`${name}.geojson`);
}
