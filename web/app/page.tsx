"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import AssumptionsPanel from "@/components/AssumptionsPanel";
import ControlPanel from "@/components/ControlPanel";
import ResultPanel from "@/components/ResultPanel";
import StageOverlay from "@/components/StageOverlay";
import { adapt, crashTest, getMode, loadMeta, onModeChange } from "@/lib/api";
import {
  ADAPT_STAGES, CRASH_STAGES, headlineFor, prefersReducedMotion, runStages,
} from "@/lib/reveal";
import type { AdaptStage, CrashStage } from "@/lib/reveal";
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
  const [crashStage, setCrashStage] = useState<CrashStage>("idle");
  const [adaptStage, setAdaptStage] = useState<AdaptStage>("idle");
  const [stageProgress, setStageProgress] = useState(0);
  const [seqProgress, setSeqProgress] = useState(0);
  const reveal = useRef<{ skip: () => void; cancel: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SourceMode>("live");
  const [layers, setLayers] = useState({
    shadow: false, canopy: false, trees: false, buildings: false,
    trips: false, agents: true,
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
    // Inputs are locked while a sequence runs, so a half-revealed result can
    // never be attributed to settings the viewer changed underneath it.
    if (reveal.current && busy) return;
    setSel((s) => ({ ...s, ...p }));
    setResult(null);
    setAdapted(null);
    setCrashStage("idle");
    setAdaptStage("idle");
  }, [busy]);

  /** Play a stage sequence over an already-validated snapshot. */
  const play = useCallback(
    <S extends string>(
      stages: typeof CRASH_STAGES | typeof ADAPT_STAGES,
      set: (s: S) => void, done: S,
    ) => {
      reveal.current?.cancel();
      reveal.current = runStages(
        stages as never, done as never,
        (c) => {
          set(c.stage as S);
          setStageProgress(c.stageProgress);
          setSeqProgress(c.progress);
          if (!c.running) setBusy(false);
        },
        prefersReducedMotion(),
      );
    }, []);

  const runCrashTest = useCallback(async () => {
    setBusy(true); setError(null); setAdapted(null);
    setAdaptStage("idle");
    setCrashStage("loading"); setStageProgress(0); setSeqProgress(0);
    try {
      // Fetch and validate first. The animation reveals a completed
      // computation; it never stands in for one that has not returned.
      const snapshot = await crashTest(sel);
      if (!Number.isFinite(snapshot.severe_total)
          || snapshot.severe_minutes.length !== meta?.seg_ids.length) {
        throw new Error("snapshot failed validation");
      }
      setResult(snapshot);
      play<CrashStage>(CRASH_STAGES, setCrashStage, "complete");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCrashStage("idle");
      setBusy(false);
    }
  }, [sel, meta, play]);

  const runAdapt = useCallback(async () => {
    if (!result) return;
    setBusy(true); setError(null);
    setAdaptStage("loading"); setStageProgress(0); setSeqProgress(0);
    try {
      const plan = await adapt(sel, result);
      if (!Number.isFinite(plan.after_severe)) {
        throw new Error("plan failed validation");
      }
      setAdapted(plan);
      play<AdaptStage>(ADAPT_STAGES, setAdaptStage, "complete");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAdaptStage("idle");
      setBusy(false);
    }
  }, [sel, result, play]);

  const replay = useCallback(() => {
    setBusy(true);
    if (adapted) play<AdaptStage>(ADAPT_STAGES, setAdaptStage, "complete");
    else play<CrashStage>(CRASH_STAGES, setCrashStage, "complete");
  }, [adapted, play]);

  const skip = useCallback(() => reveal.current?.skip(), []);

  const reset = useCallback(() => {
    // Reset must work at any time, including mid-sequence.
    reveal.current?.cancel();
    setSel(DEFAULT);
    setResult(null);
    setAdapted(null);
    setError(null);
    setBusy(false);
    setCrashStage("idle");
    setAdaptStage("idle");
    setStageProgress(0);
    setSeqProgress(0);
    setLayers({ shadow: false, canopy: false, trees: false,
      buildings: false, trips: false, agents: true });
  }, []);

  // Human-exposure ranking. Deliberately separate from the map's colour:
  // the hottest street is not necessarily where people accumulate the most
  // severe minutes, and a percentile must never redefine a stress class.
  // "complete" is a resting state, not a beat - but the card has to stay so
  // Replay remains reachable, which the spec requires.
  const stageHead = adaptStage !== "idle"
    ? (headlineFor(ADAPT_STAGES, adaptStage) ?? (adaptStage === "complete"
      ? { stage: "complete" as const, ms: 0, headline: "Plan complete",
        detail: "Same people, same routes, same weather — only the shade changed" }
      : null))
    : (headlineFor(CRASH_STAGES, crashStage) ?? (crashStage === "complete"
      ? { stage: "complete" as const, ms: 0, headline: "Crash test complete",
        detail: "Spend a budget to see what shade would buy" }
      : null));

  const showThermal = ["thermal", "people", "hotspot", "complete"]
    .includes(crashStage);

  // Placements land over the "place" stage and stay put afterwards.
  const placedFraction = adaptStage === "lock" || adaptStage === "rank"
    ? 0
    : adaptStage === "place" ? stageProgress : 1;

  const hotspots = useMemo(() => {
    if (!meta || !result) return [];
    const useSevere = result.severe_total > 0;
    const active = adapted?.metric_values
      ?? (useSevere ? result.severe_minutes : result.heat_load);
    return active
      .map((value, i) => ({
        segId: meta.seg_ids[i],
        corridor: corridors[meta.seg_ids[i]] ?? null,
        value,
        unit: useSevere ? "severe min" : "heat load",
      }))
      .filter((h) => h.value > 0)
      .sort((a, b) => b.value - a.value)
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
        <StageOverlay
          headline={stageHead?.headline ?? null}
          detail={stageHead?.detail ?? null}
          progress={seqProgress}
          running={busy}
          onSkip={skip}
          onReplay={replay}
          canReplay={!!result && !busy}
          budget={adaptStage !== "idle" && adapted
            ? {
              // Spend ticks up from the optimiser trace, not from a guess.
              spent: adapted.spent_usd * placedFraction,
              total: sel.budget,
              counts: Object.fromEntries(Object.entries(adapted.counts)
                .map(([k, n]) => [k, Math.round(n * placedFraction)])),
            }
            : null}
          meta={meta}
          adapted={adapted}
        />
        <MapView
          meta={meta}
          result={result}
          adapted={adapted}
          hour={sel.hour}
          layers={layers}
          persona={sel.persona}
          crashStage={crashStage}
          adaptStage={adaptStage}
          stageProgress={stageProgress}
        />

        <div className="pointer-events-none absolute inset-0 p-4">
          <div className="pointer-events-auto absolute right-4 top-4">
            <ResultPanel
              meta={meta}
              sel={sel}
              result={crashStage === "hotspot" || crashStage === "complete"
                ? result : null}
              adapted={adaptStage === "land" || adaptStage === "complete"
                ? adapted : null}
              hotspots={hotspots}
            />
          </div>

          <div className="absolute bottom-4 left-4">
            <AssumptionsPanel meta={meta} />
          </div>

          {/* The legend appears with the tint it describes, not before it. */}
          {result && showThermal && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 shadow backdrop-blur">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                Thermal stress (UTCI)
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="h-2 w-44 rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg,#9fb4c4 0%,#b7c3bd 23%,#e2d3a4 46%,"
                      + "#efb183 69%,#d7301f 69.1%,#7f0000 100%)",
                  }}
                />
                {adapted && (
                  <span className="ml-1 flex items-center gap-1 text-[10px] text-emerald-700">
                    <span className="inline-block h-0.5 w-4 bg-emerald-600" />
                    shade added
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex w-44 justify-between text-[9px] tabular-nums text-slate-500">
                <span>20</span><span>26</span><span>32</span>
                <span className="font-semibold text-red-700">38 °C</span>
                <span>46</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-600">
                <span>red = Very Strong Heat Stress</span>
                {result && (
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-3 rounded-sm bg-red-900/25" />
                    top-25 human hotspot
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
