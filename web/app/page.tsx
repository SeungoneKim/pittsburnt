"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

import AdjustModal from "@/components/AdjustModal";
import CrashButton from "@/components/CrashButton";
import ResultCard from "@/components/ResultCard";
import SetupCard from "@/components/SetupCard";
import ProgramPanel from "@/components/ProgramPanel";
import SolutionLab from "@/components/SolutionLab";
import SourcesDrawer from "@/components/SourcesDrawer";
import StageOverlay from "@/components/StageOverlay";
import type { Layers } from "@/components/SetupCard";
import { adapt, crashTest, getMode, loadMeta, onModeChange } from "@/lib/api";
import type { ProgramResult } from "@/lib/program";
import {
  ADAPT_STAGES, CRASH_STAGES, headlineFor, prefersReducedMotion, runStages,
} from "@/lib/reveal";
import type { AdaptStage, CrashStage } from "@/lib/reveal";
import { isReady } from "@/lib/types";
import type {
  AdaptResult, CrashResult, Meta, Selection, SourceMode,
} from "@/lib/types";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

/** Nothing is pre-answered: the tool opens on a context map. */
const EMPTY: Selection = {
  scenario: null, hour: null, persona: null,
  budget: 250000, policy: "balanced_protection",
};
const NO_LAYERS: Layers = {
  shadow: false, canopy: false, trees: false,
  buildings: false, trips: false, agents: true,
};

export default function Page() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [sel, setSel] = useState<Selection>(EMPTY);
  const [result, setResult] = useState<CrashResult | null>(null);
  const [adapted, setAdapted] = useState<AdaptResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SourceMode>("live");
  const [layers, setLayers] = useState<Layers>(NO_LAYERS);
  const [corridors, setCorridors] = useState<Record<string, string | null>>({});
  const [crashStage, setCrashStage] = useState<CrashStage>("idle");
  const [adaptStage, setAdaptStage] = useState<AdaptStage>("idle");
  const [stageProgress, setStageProgress] = useState(0);
  const [seqProgress, setSeqProgress] = useState(0);
  const [showAdjust, setShowAdjust] = useState(false);
  const [sources, setSources] = useState<string | null>(null);
  const [lab, setLab] = useState(false);
  const [prog, setProg] = useState(false);
  const reveal = useRef<{ skip: () => void; cancel: () => void } | null>(null);
  const resetMap = useRef<(() => void) | null>(null);

  useEffect(() => {
    loadMeta().then((m) => { setMeta(m); setMode(getMode()); })
      .catch((e) => setError(String(e)));
    fetch("/data/segments.geojson").then((r) => r.json()).then((g) => {
      const map: Record<string, string | null> = {};
      for (const f of g.features) map[f.properties.seg_id] = f.properties.corridor ?? null;
      setCorridors(map);
    });
    return onModeChange(setMode);
  }, []);

  const play = useCallback(
    <S extends string>(stages: typeof CRASH_STAGES, set: (s: S) => void, done: S) => {
      reveal.current?.cancel();
      reveal.current = runStages(stages as never, done as never, (c) => {
        set(c.stage as S);
        setStageProgress(c.stageProgress);
        setSeqProgress(c.progress);
        if (!c.running) setBusy(false);
      }, prefersReducedMotion());
    }, []);

  /**
   * Changing the question invalidates the answer - but budget and policy are
   * not part of the question. They describe the plan, so changing them drops
   * the plan and leaves the crash test standing. Treating them the same way
   * meant opening the Adjust modal destroyed the result it was meant to act
   * on.
   */
  const patch = useCallback((p: Partial<Selection>) => {
    if (busy) return;   // inputs lock only while a sequence runs
    setSel((s) => ({ ...s, ...p }));
    const changesQuestion = "scenario" in p || "hour" in p || "persona" in p;
    setAdapted(null);
    setAdaptStage("idle");
    if (changesQuestion) {
      setResult(null);
      setCrashStage("idle");
    }
  }, [busy]);

  const runCrashTest = useCallback(async () => {
    if (!meta || !isReady(sel)) return;
    setBusy(true); setError(null); setAdapted(null); setAdaptStage("idle");
    setCrashStage("loading"); setStageProgress(0); setSeqProgress(0);
    try {
      const snap = await crashTest(sel);
      if (!Number.isFinite(snap.severe_total)
          || snap.severe_minutes.length !== meta.seg_ids.length) {
        throw new Error("snapshot failed validation");
      }
      setResult(snap);
      play<CrashStage>(CRASH_STAGES, setCrashStage, "complete");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCrashStage("idle"); setBusy(false);
    }
  }, [sel, meta, play]);

  const runAdapt = useCallback(async () => {
    if (!result || !isReady(sel)) return;
    setShowAdjust(false);
    setBusy(true); setError(null);
    setAdaptStage("loading"); setStageProgress(0); setSeqProgress(0);
    try {
      const plan = await adapt(sel, result);
      if (!Number.isFinite(plan.after_severe)) throw new Error("plan failed validation");
      setAdapted(plan);
      play<AdaptStage>(ADAPT_STAGES as never, setAdaptStage, "complete");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAdaptStage("idle"); setBusy(false);
    }
  }, [sel, result, play]);

  /**
   * A solved program lands exactly like a greedy plan: same shape, same
   * choreography, same map. The only difference a viewer sees is that the
   * result card can now cite a proof instead of a claim.
   */
  const landProgram = useCallback((plan: ProgramResult) => {
    setBusy(true); setError(null);
    setAdapted(plan);
    play<AdaptStage>(ADAPT_STAGES as never, setAdaptStage, "complete");
  }, [play]);

  const replay = useCallback(() => {
    setBusy(true);
    if (adapted) play<AdaptStage>(ADAPT_STAGES as never, setAdaptStage, "complete");
    else play<CrashStage>(CRASH_STAGES, setCrashStage, "complete");
  }, [adapted, play]);

  /**
   * Full reset. Cancels controllers and pending frames, drops every derived
   * value, and tells the map to clear feature-state and empty its dynamic
   * sources — a reset that leaves a halo or a stale agent source behind is
   * not a reset.
   */
  const reset = useCallback(() => {
    reveal.current?.cancel();
    reveal.current = null;
    setSel(EMPTY);
    setResult(null); setAdapted(null); setError(null);
    setBusy(false);
    setCrashStage("idle"); setAdaptStage("idle");
    setStageProgress(0); setSeqProgress(0);
    setShowAdjust(false); setSources(null); setLab(false); setProg(false);
    setLayers(NO_LAYERS);
    resetMap.current?.();
  }, []);

  const hotspots = useMemo(() => {
    if (!meta || !result) return [];
    const useSevere = result.severe_total > 0;
    const active = adapted
      ? (useSevere ? adapted.metric_values : adapted.metric_values)
      : (useSevere ? result.severe_minutes : result.heat_load);
    return active
      .map((value, i) => ({
        segId: meta.seg_ids[i],
        corridor: corridors[meta.seg_ids[i]] ?? null,
        value,
        unit: useSevere ? "severe person-minutes" : "heat load",
      }))
      .filter((h) => h.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [meta, result, adapted, corridors]);

  const missing = useMemo(() => {
    const m: string[] = [];
    if (!sel.hour) m.push("a time");
    if (!sel.persona) m.push("who is walking");
    if (!sel.scenario) m.push("a scenario");
    return m;
  }, [sel]);

  const stageHead = adaptStage !== "idle"
    ? (headlineFor(ADAPT_STAGES, adaptStage) ?? (adaptStage === "complete"
      ? { stage: "complete" as const, ms: 0, headline: "Plan complete",
        detail: "Same people, same routes, same weather — only the shade changed" }
      : null))
    : (headlineFor(CRASH_STAGES, crashStage) ?? (crashStage === "complete"
      ? { stage: "complete" as const, ms: 0, headline: "Crash test complete",
        detail: "Build a plan to see what shade would buy" }
      : null));

  const placedFraction = adaptStage === "lock" || adaptStage === "rank"
    ? 0 : adaptStage === "place" ? stageProgress : 1;
  const showResult = crashStage === "hotspot" || crashStage === "complete"
    || adaptStage !== "idle";

  if (error && !meta) {
    return <main className="grid h-dvh place-items-center p-8 text-sm text-red-700">
      Could not load the data bundle: {error}
    </main>;
  }
  if (!meta) {
    return <main className="grid h-dvh place-items-center text-sm text-slate-500">
      Loading Oakland…
    </main>;
  }

  return (
    <main className="relative h-dvh overflow-hidden bg-slate-100">
      <MapView
        meta={meta}
        result={result}
        adapted={adapted}
        hour={sel.hour}
        persona={sel.persona}
        layers={layers}
        crashStage={crashStage}
        adaptStage={adaptStage}
        stageProgress={stageProgress}
        placedFraction={placedFraction}
        registerReset={(fn) => { resetMap.current = fn; }}
      />

      <div className="pointer-events-none absolute inset-0 p-4">
        <div className="absolute left-4 top-4">
          <SetupCard
            meta={meta} sel={sel} onChange={patch}
            layers={layers}
            onLayers={(p) => setLayers((l) => ({ ...l, ...p }))}
            locked={busy}
            onOpenSources={(k) => setSources(k ?? "provenance")}
          />
        </div>

        <StageOverlay
          headline={stageHead?.headline ?? null}
          detail={stageHead?.detail ?? null}
          progress={seqProgress}
          running={busy}
          onSkip={() => reveal.current?.skip()}
          onReplay={replay}
          canReplay={!!result && !busy}
          budget={adaptStage !== "idle" && adapted ? {
            spent: adapted.spent_usd * placedFraction,
            total: sel.budget,
            counts: Object.fromEntries(Object.entries(adapted.counts)
              .map(([k, n]) => [k, Math.round(n * placedFraction)])),
          } : null}
          meta={meta}
          adapted={adapted}
        />

        {showResult && result && (
          <div className="absolute right-4 top-4">
            <ResultCard
              meta={meta} sel={sel} result={result}
              adapted={adaptStage === "land" || adaptStage === "complete" ? adapted : null}
              topHotspot={hotspots[0] ?? null}
              onOpenSources={(k) => setSources(k ?? "provenance")}
              onViewAllHotspots={() => setSources("hotspots")}
            />
          </div>
        )}

        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          <CrashButton
            mode={result ? "adjust" : "crash"}
            missing={missing}
            busy={busy}
            onClick={() => (result ? setShowAdjust(true) : runCrashTest())}
          />
        </div>

        {/* Clear of the dev overlay badge that sits in the bottom-left corner. */}
        <div className="pointer-events-auto absolute bottom-6 left-16 flex gap-2
          max-[1400px]:bottom-4">
          {/* The headline capability should not be three clicks deep. It
              needs a crash result to improve on, so it appears with one. */}
          {result && (
            <button
              onClick={() => setProg(true)}
              className="rounded-lg border-2 border-indigo-400 bg-indigo-600
                px-3 py-2 text-[13px] font-semibold text-white shadow
                hover:bg-indigo-700"
            >
              State a goal
            </button>
          )}
          <button
            onClick={() => setSources("provenance")}
            className="rounded-lg border border-slate-300 bg-white/95 px-3 py-2
              text-[13px] text-slate-700 shadow hover:bg-white"
          >
            Sources &amp; method
          </button>
          <button
            onClick={reset}
            className="rounded-lg border border-slate-300 bg-white/95 px-3 py-2
              text-[13px] text-slate-600 shadow hover:bg-white"
          >
            Reset
          </button>
        </div>

        {/* Clear of the map's own zoom controls, which live bottom-right. */}
        {showResult && result && (
          <div className="pointer-events-none absolute bottom-6 left-[352px] rounded-xl
            border border-slate-200 bg-white/95 px-3 py-2 shadow backdrop-blur">
            <div className="flex items-center gap-2">
              <div className="relative h-2.5 w-44 rounded-full"
                style={{
                  background: "linear-gradient(90deg,#8fc7a4,#bfe0a8 17%,"
                    + "#f2e394 33%,#f7d070 42%,#f3944a 54%,#e8562a 67%,"
                    + "#c81e1e 83%,#7f0000)",
                }}>
                {/* 38 C marked, not walled off. */}
                <span className="absolute -top-0.5 h-3.5 w-[2px] bg-slate-900"
                  style={{ left: "66.7%" }} />
              </div>
            </div>
            <div className="mt-1 flex w-44 justify-between text-[10px]
              tabular-nums text-slate-500">
              <span>26</span><span>32</span>
              <span className="font-semibold text-slate-900">38</span><span>46</span>
            </div>
            <div className="text-[10px] text-slate-500">UTCI (°C)</div>
          </div>
        )}

        {error && (
          <div className="pointer-events-auto absolute left-1/2 top-4 z-50
            -translate-x-1/2 rounded-lg bg-red-600 px-3 py-2 text-[13px]
            text-white shadow-lg">
            {error}
          </div>
        )}
      </div>

      {showAdjust && (
        <AdjustModal
          meta={meta} sel={sel} onChange={patch}
          onRun={runAdapt} onClose={() => setShowAdjust(false)}
          cachedOnly={mode === "fallback"}
          onOpenLab={() => { setShowAdjust(false); setLab(true); }}
          onOpenProgram={() => { setShowAdjust(false); setProg(true); }}
        />
      )}

      {lab && <SolutionLab sel={sel} onClose={() => setLab(false)} />}

      {prog && isReady(sel) && (
        <ProgramPanel sel={sel} onPlan={landProgram}
          onClose={() => setProg(false)} />
      )}

      {sources && (
        <SourcesDrawer
          meta={meta} sel={sel} result={result} adapted={adapted}
          focus={sources} hotspots={hotspots}
          onClose={() => setSources(null)}
        />
      )}
    </main>
  );
}
