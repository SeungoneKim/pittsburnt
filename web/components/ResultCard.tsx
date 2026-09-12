"use client";

import { useState } from "react";

import type { AdaptResult, CrashResult, Meta, Selection } from "@/lib/types";

const fmt = (n: number) => Math.round(n).toLocaleString();

function band(u: number) {
  if (u >= 46) return { label: "Extreme Heat Stress", cls: "text-red-900" };
  if (u >= 38) return { label: "Very Strong Heat Stress", cls: "text-orange-700" };
  if (u >= 32) return { label: "Strong Heat Stress", cls: "text-amber-600" };
  if (u >= 26) return { label: "Moderate Heat Stress", cls: "text-yellow-600" };
  return { label: "No Thermal Stress", cls: "text-sky-700" };
}

interface Props {
  meta: Meta;
  sel: Selection;
  result: CrashResult;
  adapted: AdaptResult | null;
  topHotspot: { corridor: string | null; value: number; unit: string } | null;
  onOpenSources: (key?: string) => void;
  onViewAllHotspots: () => void;
}

/**
 * Four numbers at a size a judge can read, and nothing else at rest.
 *
 * Air temperature, UTCI, heat load and severe exposure carry the story. Every
 * qualification - planning weights, trip counts, segment counts, disclaimers -
 * lives in a popover or in Sources, so the resting surface stays legible.
 */
export default function ResultCard({
  meta, sel, result, adapted, topHotspot, onOpenSources, onViewAllHotspots,
}: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const c = result.conditions;
  const sunBand = band(result.utci_sun_c);
  const severe = adapted ? adapted.after_severe : result.severe_total;
  const load = adapted ? adapted.after_heat_load : result.heat_load_total;
  const crosses = result.utci_sun_c >= meta.severe_threshold_utci_c;

  return (
    <div className="pointer-events-auto w-[400px] overflow-hidden rounded-2xl
      border border-slate-200/80 bg-white/95 shadow-xl shadow-slate-900/5
      backdrop-blur">
      <div className="max-h-[calc(100dvh-180px)] overflow-y-auto p-5">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-medium text-slate-700">
            {meta.scenarios.find((s) => s.key === sel.scenario)?.label} ·{" "}
            {sel.hour}:00 · {meta.personas.find((p) => p.key === sel.persona)?.label}
          </span>
          <button
            onClick={() => onOpenSources("snapshot")}
            className="font-mono text-[10px] text-slate-400 underline
              decoration-dotted underline-offset-2 hover:text-slate-600"
          >
            {result.snapshot_id}
          </button>
        </div>

        <Big
          label="Air temperature"
          value={`${c.air_temp_c.toFixed(1)} °C`}
          sub={`${(c.air_temp_c * 9 / 5 + 32).toFixed(1)} °F`}
          badge="source"
          onBadge={() => onOpenSources("air_temp_c")}
          detail={`Relative humidity ${c.rh_pct.toFixed(0)}%, wind `
            + `${c.wind_ms.toFixed(1)} m/s and solar radiation are HELD `
            + `CONSTANT across scenarios, so the only thing that changes is `
            + `the warming delta.`}
          open={open === "air"}
          onToggle={() => setOpen(open === "air" ? null : "air")}
        />

        <Big
          label="UTCI in sun"
          value={`${result.utci_sun_c.toFixed(1)} °C`}
          sub={`${result.utci_shade_c.toFixed(1)} °C in shade · ${sunBand.label}`}
          subCls={sunBand.cls}
          badge="computed"
          onBadge={() => onOpenSources("utci_c")}
          detail={`Mean radiant temperature ${c.tmrt_shade_c.toFixed(0)}–`
            + `${c.tmrt_sun_c.toFixed(0)} °C. Shade is worth `
            + `${c.shade_relief_c.toFixed(1)} °C of UTCI here. `
            + `${meta.severe_threshold_utci_c} °C is the published entry to `
            + `Very Strong Heat Stress.`}
          open={open === "utci"}
          onToggle={() => setOpen(open === "utci" ? null : "utci")}
        />

        <Big
          label="Heat load"
          value={fmt(load)}
          sub={adapted
            ? `was ${fmt(adapted.before_heat_load)}`
            : "cumulative burden above 26 °C"}
          badge="computed"
          onBadge={() => onOpenSources("severe_person_minutes")}
          detail="Person-minutes weighted by how far UTCI sits above the
            Moderate threshold. Continuous, so it responds to any cooling —
            not only to crossing a class boundary."
          open={open === "load"}
          onToggle={() => setOpen(open === "load" ? null : "load")}
        />

        <Big
          label="Severe heat exposure"
          value={crosses ? fmt(severe) : "None"}
          sub={crosses
            ? (adapted
              ? `was ${fmt(adapted.before_severe)} person-minutes`
              : `person-minutes at or above ${meta.severe_threshold_utci_c} °C`)
            : `peak sits ${Math.abs(result.utci_sun_c - meta.severe_threshold_utci_c).toFixed(1)} °C below the threshold`}
          badge="computed"
          onBadge={() => onOpenSources("severe_person_minutes")}
          detail={`Walking ${fmt(result.walking_severe_total)} + waiting `
            + `${fmt(result.waiting_severe_total)}. Unweighted: planning `
            + `priority is a separate policy figure, in Sources.`}
          open={open === "severe"}
          onToggle={() => setOpen(open === "severe" ? null : "severe")}
          tone={crosses ? "hot" : "cool"}
        />

        {adapted && (
          <div className="mt-3 space-y-1.5 rounded-xl bg-emerald-50 p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-semibold text-emerald-900">
                {adapted.policy_label}
              </span>
              <span className="text-[20px] font-bold tabular-nums text-emerald-800">
                −{adapted.reduction_pct.toFixed(1)}%
              </span>
            </div>
            <div className="text-[12px] text-emerald-900/80">
              ${fmt(adapted.spent_usd)} ·{" "}
              {Object.entries(adapted.counts)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${n} ${meta.interventions[k]?.label.toLowerCase() ?? k}`)
                .join(" + ")}
            </div>
            {adapted.impact_scopes.map((s) => (
              <div key={s.label} className="flex justify-between text-[11px]
                text-emerald-900/70">
                <span>{s.label}</span>
                <span className="tabular-nums">−{s.reduction_pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        )}

        {topHotspot && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="text-[11px] uppercase tracking-wider text-slate-500">
              Most exposed street
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[15px] font-semibold text-slate-900">
                {topHotspot.corridor ?? "Unnamed path"}
              </span>
              <span className="tabular-nums text-[15px] font-semibold text-slate-900">
                {topHotspot.value.toFixed(1)}
              </span>
            </div>
            <button
              onClick={onViewAllHotspots}
              className="mt-1 text-[12px] text-slate-500 underline
                decoration-dotted underline-offset-2 hover:text-slate-800"
            >
              View all
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Big({ label, value, sub, subCls, badge, onBadge, detail, open, onToggle, tone }: {
  label: string; value: string; sub: string; subCls?: string;
  badge: string; onBadge: () => void; detail: string;
  open: boolean; onToggle: () => void; tone?: "hot" | "cool";
}) {
  const colour = tone === "hot" ? "text-orange-700"
    : tone === "cool" ? "text-sky-700" : "text-slate-900";
  return (
    <div className="border-t border-slate-100 py-2.5 first:border-0 first:pt-0">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-slate-500">
          {label}
        </span>
        {/* Provenance badges are buttons, not tooltips: they open Sources. */}
        <button
          onClick={onBadge}
          title="Open the source for this value"
          className="rounded bg-slate-100 px-1 text-[9px] font-medium uppercase
            tracking-wide text-slate-600 hover:bg-slate-200"
        >
          {badge.slice(0, 3)}
        </button>
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="ml-auto text-[11px] text-slate-400 hover:text-slate-700"
        >
          {open ? "less" : "detail"}
        </button>
      </div>
      <div className={`text-[30px] font-bold leading-tight tabular-nums ${colour}`}>
        {value}
      </div>
      <div className={`text-[12px] ${subCls ?? "text-slate-500"}`}>{sub}</div>
      {open && (
        <p className="mt-1 rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed
          text-slate-600">
          {detail}
        </p>
      )}
    </div>
  );
}
