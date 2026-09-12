"use client";

import type { AdaptResult, Meta, Selection } from "@/lib/types";

const fmt = (n: number) => Math.round(n).toLocaleString();

/**
 * Why this allocation, from the optimiser's own trace.
 *
 * The spec's rule for any explanation layer: it may use optimiser-trace
 * values and nothing else - no invented costs, no invented impacts, no
 * chain-of-thought. Everything here is a number the optimiser recorded while
 * deciding, which is also why it needs no language model to produce.
 */
export default function WhyThisPlan({ meta, sel, adapted }: {
  meta: Meta; sel: Selection; adapted: AdaptResult;
}) {
  const t = adapted.rank_trace;
  if (!t) return null;
  const rows = Object.entries(t.by_kind).filter(([, v]) => v.units > 0);

  return (
    <div className="w-[350px] space-y-2 rounded-xl border border-slate-200
      bg-white/95 p-4 text-[11px] shadow-lg backdrop-blur">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        Why this plan
      </div>

      <div className="space-y-1">
        <Row label="Budget entered" value={`$${fmt(sel.budget)}`} />
        <Row label="Spent" value={`$${fmt(adapted.spent_usd)}`} />
        {t.unspent_usd > 0 && (
          <Row
            label="Left over"
            value={`$${fmt(t.unspent_usd)}`}
            hint="less than the cheapest remaining unit"
          />
        )}
        {rows.map(([k, v]) => (
          <Row
            key={k}
            label={meta.interventions[k]?.label ?? k}
            value={`${v.units} · $${fmt(v.cost_usd)}`}
            hint={`${v.severe_per_1k_usd.toFixed(2)} severe minutes avoided per $1,000`}
          />
        ))}
        <Row
          label="Severe minutes avoided"
          value={fmt(adapted.before_severe - adapted.after_severe)}
        />
        <Row
          label="Heat load avoided"
          value={fmt(adapted.before_heat_load - adapted.after_heat_load)}
        />
      </div>

      {t.best_site && (
        <p className="border-t border-slate-200 pt-2 text-slate-600">
          Highest-value single site:{" "}
          <b>{t.best_site.seg_id}</b> — one{" "}
          {meta.interventions[t.best_site.kind]?.label.toLowerCase()} there
          avoided <b>{t.best_site.severe_minutes_saved.toFixed(2)}</b> severe
          person-minutes for ${fmt(t.best_site.cost_usd)}.
        </p>
      )}

      {/* Why a permitted option went unbought - stated, not left blank. */}
      {t.unbought.map((u) => (
        <p key={u.kind} className="text-slate-600">
          <b>No {u.label.toLowerCase()} selected.</b> {u.reason}
        </p>
      ))}

      <p className="border-t border-slate-200 pt-2 text-[10px] leading-snug text-slate-500">
        Objective: {t.objective}. {t.claim}. Every figure above is a value the
        optimiser recorded while deciding — nothing here is estimated after
        the fact.
      </p>
    </div>
  );
}

function Row({ label, value, hint }: {
  label: string; value: string; hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-slate-600">
        {label}
        {hint && <span className="block text-[10px] text-slate-400">{hint}</span>}
      </span>
      <span className="shrink-0 tabular-nums font-medium text-slate-900">{value}</span>
    </div>
  );
}
