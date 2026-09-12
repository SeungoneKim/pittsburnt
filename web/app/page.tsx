"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import AssumptionsPanel from "@/components/AssumptionsPanel";
import ControlPanel from "@/components/ControlPanel";
import ResultPanel from "@/components/ResultPanel";
import { adapt, crashTest, getMode, loadMeta, onModeChange } from "@/lib/api";
import type {
  AdaptResult, CrashResult, Meta, Selection, SourceMode,
} from "@/lib/types";

// Mapbox GL touches window on import, so it must not be server-rendered.
const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

const DEFAULT: Selection = {
  scenario: "heat2035",
  hour: 15,
  persona: "older_adults",
  budget: 250000,
  variant: "all",
};

export default function Page() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [sel, setSel] = useState<Selection>(DEFAULT);
  const [result, setResult] = useState<CrashResult | null>(null);
  const [adapted, setAdapted] = useState<AdaptResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SourceMode>("live");
  const [layers, setLayers] = useState({
    shadow: false, canopy: false, trees: false, stops: false,
    buildings: false, trips: false,
  });
  const [corridors, setCorridors] = useState<Record<string, string | null>>({});

  useEffect(() => {
    loadMeta().then((m) => { setMeta(m); setMode(getMode()); }).catch((e) => setError(String(e)));
    fetch("/data/segments.geojson").then((r) => r.json()).then((g) => {
      const map: Record<string, string | null> = {};
      for (const f of g.features) {
        map[f.properties.seg_id] = f.properties.corridor ?? null;
      }
      setCorridors(map);
    });
    return onModeChange(setMode);
  }, []);

  // Changing any input invalidates the current run: the map must never show
  // a score that belongs to a different scenario than the controls claim.
  const patch = useCallback((p: Partial<Selection>) => {
    setSel((s) => ({ ...s, ...p }));
    setResult(null);
    setAdapted(null);
  }, []);

  const runCrashTest = useCallback(async () => {
    setBusy(true); setError(null); setAdapted(null);
    try {
      setResult(await crashTest(sel));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sel]);

  const runAdapt = useCallback(async () => {
    if (!result) return;
    setBusy(true); setError(null);
    try {
      setAdapted(await adapt(sel, result));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sel, result]);

  const reset = useCallback(() => {
    setSel(DEFAULT);
    setResult(null);
    setAdapted(null);
    setError(null);
    setLayers({ shadow: false, canopy: false, trees: false, stops: false,
      buildings: false, trips: false });
  }, []);

  // Colour scale is pinned to the *baseline* run so ADAPT visibly cools the
  // map instead of renormalising itself straight back to red.
  //
  // Anchored on the 95th percentile of segments that actually carry people,
  // not the maximum: exposure is heavily long-tailed, so a max-anchored ramp
  // pushes almost the whole network into the bottom colour and hides the
  // gradient the map exists to show. The top few per cent saturate at red,
  // which is what "hotspot" should mean.
  const scaleMax = useMemo(() => {
    if (!result) return 1;
    const live = result.exposure.filter((v) => v > 0).sort((a, b) => a - b);
    if (!live.length) return 1;
    return live[Math.floor(live.length * 0.95)] || live[live.length - 1];
  }, [result]);

  const hotspots = useMemo(() => {
    if (!meta || !result) return [];
    const active = adapted?.exposure ?? result.exposure;
    return active
      .map((exposure, i) => ({
        segId: meta.seg_ids[i], corridor: corridors[meta.seg_ids[i]] ?? null, exposure,
      }))
      .sort((a, b) => b.exposure - a.exposure)
      .slice(0, 10);
  }, [meta, result, adapted, corridors]);

  if (error && !meta) {
    return (
      <main className="grid h-screen place-items-center p-8 text-sm text-red-700">
        Could not load the data bundle: {error}
      </main>
    );
  }
  if (!meta) {
    return (
      <main className="grid h-screen place-items-center text-sm text-slate-500">
        Loading Oakland…
      </main>
    );
  }

  return (
    <main className="flex h-screen overflow-hidden bg-slate-100">
      <aside className="z-10 w-[310px] shrink-0 border-r border-slate-200 shadow-sm">
        <ControlPanel
          meta={meta}
          sel={sel}
          onChange={patch}
          layers={layers}
          onLayers={(p) => setLayers((l) => ({ ...l, ...p }))}
          mode={mode}
          busy={busy}
          hasResult={!!result}
          onCrashTest={runCrashTest}
          onAdapt={runAdapt}
          onReset={reset}
        />
      </aside>

      <section className="relative flex-1">
        <MapView
          meta={meta}
          result={result}
          adapted={adapted}
          scaleMax={scaleMax}
          hour={sel.hour}
          layers={layers}
        />

        <div className="pointer-events-none absolute inset-0 p-4">
          <div className="pointer-events-auto absolute right-4 top-4">
            <ResultPanel
              meta={meta}
              sel={sel}
              result={result}
              adapted={adapted}
              hotspots={hotspots}
            />
          </div>

          <div className="absolute bottom-4 left-4">
            <AssumptionsPanel meta={meta} />
          </div>

          {result && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 shadow backdrop-blur">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                Modelled exposure
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-600">low</span>
                <div
                  className="h-2 w-40 rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg,#2c7bb6,#abd9e9,#ffffbf,#fdae61,#d7191c)",
                  }}
                />
                <span className="text-[10px] text-slate-600">hotspot</span>
                {adapted && (
                  <span className="ml-2 flex items-center gap-1 text-[10px] text-emerald-700">
                    <span className="inline-block h-0.5 w-4 bg-emerald-600" />
                    shade added
                  </span>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="pointer-events-auto absolute left-1/2 top-4 -translate-x-1/2 rounded-lg bg-red-600 px-3 py-2 text-xs text-white shadow">
              {error}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
