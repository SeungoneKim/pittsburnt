"use client";

import type { AdaptResult, CrashResult, Meta, Selection } from "@/lib/types";

interface Props {
  meta: Meta;
  sel: Selection;
  result: CrashResult | null;
  adapted: AdaptResult | null;
  hotspots: { segId: string; corridor: string | null; exposure: number }[];
}

function Stat({ label, value, unit, tone = "default" }: {
  label: string; value: string; unit?: string;
  tone?: "default" | "before" | "after";
}) {
  const colour = tone === "after" ? "text-emerald-700"
    : tone === "before" ? "text-red-600" : "text-slate-900";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${colour}`}>
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

export default function ResultPanel({ meta, sel, result, adapted, hotspots }: Props) {
  if (!result) {
    return (
      <div className="w-[330px] rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur">
        <p className="text-xs leading-relaxed text-slate-600">
          Pick a time, a population and a climate scenario, then{" "}
          <b>run the crash test</b> to see where modelled pedestrian heat
          exposure accumulates.
        </p>
      </div>
    );
  }

  const persona = meta.personas.find((p) => p.key === sel.persona);
  const scenario = meta.scenarios.find((s) => s.key === sel.scenario);
  const fmt = (n: number) => Math.round(n).toLocaleString();

  return (
    <div className="w-[330px] space-y-3 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500">
          Heat Exposure Score
        </div>
        <div className="text-[11px] text-slate-600">
          {scenario?.label} · {sel.hour}:00 · {persona?.label} · heat index{" "}
          {result.heat_index_c.toFixed(1)} °C
        </div>
      </div>

      {!adapted ? (
        <>
          <Stat
            label="At-risk pedestrian minutes"
            value={fmt(result.total)}
            tone="before"
          />
          <p className="text-[11px] text-slate-500">
            {fmt(result.total_unweighted)} unweighted · planning weight{" "}
            {persona?.planning_weight}
          </p>
        </>
      ) : (
        <>
          <div className="flex items-end justify-between gap-3">
            <Stat label="Before" value={fmt(adapted.before_total)} tone="before" />
            <div className="pb-2 text-lg text-slate-400">→</div>
            <Stat label="After" value={fmt(adapted.after_total)} tone="after" />
          </div>
          <div className="rounded-lg bg-emerald-50 px-3 py-2">
            <div className="text-xl font-bold text-emerald-800">
              −{adapted.reduction_pct.toFixed(1)}%
            </div>
            <div className="text-[11px] text-emerald-900/70">
              exposure removed for ${fmt(adapted.spent_usd)} ·{" "}
              {Object.entries(adapted.counts)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${n} ${meta.interventions[k]?.label.toLowerCase() ?? k}`)
                .join(" + ") || "nothing placed"}
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500">
            Identical geometry, identical {persona?.trips} trips, identical
            climate. The only change is the shade.
          </p>
        </>
      )}

      <div className="border-t border-slate-200 pt-2.5">
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">
          Top exposure hotspots
        </div>
        <ol className="space-y-1">
          {hotspots.slice(0, 6).map((h, i) => (
            <li key={h.segId} className="flex items-baseline gap-2 text-xs">
              <span className="w-3 text-slate-400">{i + 1}</span>
              <span className="flex-1 truncate text-slate-700">
                {h.corridor ?? "Unnamed path"}
              </span>
              <span className="tabular-nums font-medium text-slate-900">
                {h.exposure.toFixed(1)}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
