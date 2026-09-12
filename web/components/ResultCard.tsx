"use client";

import ThreeState from "@/components/ThreeState";
import type { AdaptResult, CrashResult, Meta, Selection } from "@/lib/types";

const fmt = (n: number) => Math.round(n).toLocaleString();

function band(u: number) {
  if (u >= 46) return { label: "Extreme Heat Stress", cls: "text-red-900" };
  if (u >= 38) return { label: "Very Strong Heat Stress", cls: "text-orange-700" };
  if (u >= 32) return { label: "Strong Heat Stress", cls: "text-amber-600" };
  if (u >= 26) return { label: "Moderate Heat Stress", cls: "text-yellow-600" };
  return { label: "No Thermal Stress", cls: "text-emerald-700" };
}

/**
 * The result surface: three states, the plan, and one hotspot.
 *
 * Everything qualifying — planning weights, trip counts, the full hotspot
 * list, limitations — lives in Sources. A provenance chip here opens it at
 * the matching entry.
 */
export default function ResultCard({
  meta, sel, result, adapted, topHotspot, onOpenSources, onViewAllHotspots,
}: {
  meta: Meta;
  sel: Selection;
  result: CrashResult;
  adapted: AdaptResult | null;
  topHotspot: { corridor: string | null; value: number; unit: string } | null;
  onOpenSources: (key?: string) => void;
  onViewAllHotspots: () => void;
}) {
  const sunBand = band(result.utci_sun_c);

  return (
    <div className="pointer-events-auto w-[404px] overflow-hidden rounded-3xl
      border border-white/70 bg-white/92 shadow-2xl shadow-slate-900/10
      backdrop-blur-md">
      <div className="max-h-[calc(100dvh-150px)] overflow-y-auto p-5">
        <ThreeState meta={meta} sel={sel} result={result} adapted={adapted} />

        <div className="mt-3 flex items-center gap-2 border-t border-slate-200/80 pt-3">
          <span className={`text-[13px] font-semibold ${sunBand.cls}`}>
            {sunBand.label} in sun
          </span>
          <span className="text-[12px] text-slate-500">
            · shade {result.utci_shade_c.toFixed(1)} °C
            ({result.conditions.shade_relief_c.toFixed(1)} °C cooler)
          </span>
          <button
            onClick={() => onOpenSources("utci_c")}
            title="Open the source for this value"
            className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[9px]
              font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-200"
          >
            com
          </button>
        </div>

        {adapted ? (
          <div className="mt-3 rounded-2xl bg-emerald-50/80 p-3.5">
            <div className="flex items-baseline gap-2">
              <span className="text-[20px] font-extrabold tracking-tight text-emerald-900">
                ${fmt(adapted.spent_usd)}
              </span>
              <span className="text-[12px] font-semibold uppercase tracking-wide
                text-emerald-800">
                {adapted.policy_label}
              </span>
            </div>
            <div className="mt-2 space-y-1">
              {Object.entries(adapted.counts)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => (
                  <PlanRow key={k}
                    kind={k}
                    value={String(n)}
                    label={meta.interventions[k]?.label ?? k} />
                ))}
              <PlanRow kind="money"
                value={`$${fmt(sel.budget - adapted.spent_usd)}`}
                label="left — under the cheapest remaining unit" />
            </div>
            {adapted.service_floor.length > 0 && (
              <p className="mt-2 border-t border-emerald-200/70 pt-2 text-[11px]
                leading-snug text-emerald-900/75">
                Service floor: one shelter at the worst unsheltered stop on{" "}
                {adapted.service_floor.map((f) => f.corridor).join(", ")} before
                efficiency spends the rest.
              </p>
            )}
            <div className="mt-2 space-y-0.5">
              {adapted.impact_scopes.map((s) => (
                <div key={s.label} className="flex justify-between text-[11px]
                  text-emerald-900/70">
                  <span>{s.label}</span>
                  <span className="tabular-nums font-semibold">
                    −{s.reduction_pct.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-3 rounded-2xl bg-slate-50 p-3 text-[12px] leading-relaxed
            text-slate-600">
            {result.severe_total > 0
              ? `${fmt(result.severe_total)} person-minutes are spent at or above `
                + `${meta.severe_threshold_utci_c} °C — ${fmt(result.walking_severe_total)} `
                + `walking, ${fmt(result.waiting_severe_total)} waiting at stops.`
              : `Nobody reaches ${meta.severe_threshold_utci_c} °C at this hour. `
                + `The hottest exposure sits `
                + `${Math.abs(result.utci_sun_c - meta.severe_threshold_utci_c).toFixed(1)} °C `
                + `short of it, so the measure here is cumulative heat load.`}
          </p>
        )}

        {topHotspot && (
          <div className="mt-3 border-t border-slate-200/80 pt-3">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">
              Most exposed street
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[16px] font-bold text-slate-900">
                {topHotspot.corridor ?? "Unnamed path"}
              </span>
              <span className="text-[16px] font-bold tabular-nums text-slate-900">
                {topHotspot.value.toFixed(1)}
              </span>
            </div>
            <button
              onClick={onViewAllHotspots}
              className="mt-0.5 text-[12px] text-slate-500 underline
                decoration-dotted underline-offset-2 hover:text-slate-900"
            >
              View all
            </button>
          </div>
        )}

        <button
          onClick={() => onOpenSources("snapshot")}
          className="mt-3 font-mono text-[10px] text-slate-400 underline
            decoration-dotted underline-offset-2 hover:text-slate-600"
        >
          {result.snapshot_id}
        </button>
      </div>
    </div>
  );
}

/** Small inline marks that match the map sprites, drawn as SVG so they look
 *  the same on every machine. */
function Mark({ kind }: { kind: string }) {
  if (kind === "shaded_shelter") {
    return (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <path d="M2 9 L10 3 L18 9 Z" fill="#14b8a6" />
        <path d="M4 9v8M16 9v8" stroke="#0f766e" strokeWidth="1.8" />
      </svg>
    );
  }
  if (kind === "money") {
    return (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <circle cx="10" cy="10" r="8" fill="#d1fae5" stroke="#059669" strokeWidth="1.5" />
        <text x="10" y="14" textAnchor="middle" fontSize="10" fill="#047857">$</text>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <rect x="9" y="12" width="2" height="6" fill="#6b4423" />
      <circle cx="10" cy="7" r="5" fill="#2f8f4e" />
      <circle cx="6.5" cy="10" r="3.6" fill="#3da35d" />
      <circle cx="13.5" cy="10" r="3.6" fill="#3da35d" />
    </svg>
  );
}

function PlanRow({ kind, value, label }: {
  kind: string; value: string; label: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-5 shrink-0 self-center"><Mark kind={kind} /></span>
      <span className="text-[16px] font-bold tabular-nums text-emerald-900">
        {value}
      </span>
      <span className="text-[12px] uppercase tracking-wide text-emerald-900/70">
        {label}
      </span>
    </div>
  );
}
