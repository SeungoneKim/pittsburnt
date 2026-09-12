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
  AdaptResult, CrashResult, Meta, Placement, Selection, SourceMode,
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
let bundle: {
  crash?: { sun_by_hour: Record<string, number[]>; results: Record<string, CrashResult> };
  adapts?: { kinds: string[]; variants: string[]; results: Record<string, RawAdapt> };
  meta?: Meta;
} = {};

interface RawAdapt {
  spent_usd: number;
  counts: Record<string, number>;
  before_total: number;
  after_total: number;
  reduction_pct: number;
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
    total_exposure: number; total_exposure_unweighted: number;
    heat_index_c: number;
    segments: { exposure: number; sun_exposure: number }[];
  }>("/crash-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scenario: sel.scenario, hour: sel.hour, persona: sel.persona,
    }),
  });

  if (live) {
    setMode("live");
    return {
      total: live.total_exposure,
      total_unweighted: live.total_exposure_unweighted,
      heat_index_c: live.heat_index_c,
      exposure: live.segments.map((s) => s.exposure),
      sun: live.segments.map((s) => s.sun_exposure),
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
    spent_usd: number; counts: Record<string, number>;
    before_total: number; after_total: number; reduction_pct: number;
    segments: { exposure: number }[];
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
    return {
      spent_usd: live.spent_usd, counts: live.counts,
      before_total: live.before_total, after_total: live.after_total,
      reduction_pct: live.reduction_pct,
      exposure: live.segments.map((s) => s.exposure),
      placements: [...tally.values()],
    };
  }

  setMode("fallback");
  const [b, meta] = [await adaptBundle(), await loadMeta()];
  const r = b.results[
    `${sel.scenario}|${sel.hour}|${sel.persona}|${sel.budget}|${sel.variant}`];
  if (!r) throw new Error("no precomputed adapt for that budget");
  // Static results ship as a diff against the baseline; rebuild the full array.
  const exposure = before.exposure.slice();
  for (const [i, v] of r.changed) exposure[i] = v;
  return {
    spent_usd: r.spent_usd, counts: r.counts,
    before_total: r.before_total, after_total: r.after_total,
    reduction_pct: r.reduction_pct, exposure,
    placements: r.placements.map(([si, ki, n]) => ({
      seg_id: meta.seg_ids[si], kind: b.kinds[ki], count: n,
    })),
  };
}

export async function loadGeo(name: string) {
  return statik<GeoJSON.FeatureCollection>(`${name}.geojson`);
}
