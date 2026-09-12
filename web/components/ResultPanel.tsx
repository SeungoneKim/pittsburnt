"use client";

import DayProfile from "@/components/DayProfile";
import ValueBadge from "@/components/ValueBadge";
import type { AdaptResult, CrashResult, Hour, Meta, Selection } from "@/lib/types";

interface Props {
  meta: Meta;
  sel: Selection;
  result: CrashResult | null;
  adapted: AdaptResult | null;
  hotspots: { segId: string; corridor: string | null; value: number; unit: string }[];
  onPickHour: (h: Hour) => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString();

/** Published UTCI assessment scale. Names and thresholds are not ours. */
function band(utci: number): { label: string; colour: string } {
  if (utci >= 46) return { label: "Extreme Heat Stress", colour: "text-red-900" };
  if (utci >= 38) return { label: "Very Strong Heat Stress", colour: "text-orange-700" };
  if (utci >= 32) return { label: "Strong Heat Stress", colour: "text-amber-600" };
  if (utci >= 26) return { label: "Moderate Heat Stress", colour: "text-yellow-600" };
  return { label: "No Thermal Stress", colour: "text-sky-700" };
}

function Layer({ n, title, children }: {
  n: number; title: string; children: React.ReactNode;
}) {
  return (
    <div className="border-t border-slate-200 pt-2.5 first:border-0 first:pt-0">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
        <span className="grid h-3.5 w-3.5 place-items-center rounded bg-slate-200 text-[8px] text-slate-600">
          {n}
        </span>
        {title}
      </div>
      {children}
    </div>
  );
}

export default function ResultPanel({
  meta, sel, result, adapted, hotspots, onPickHour,
}: Props) {
  if (!result) {
    return (
      <div className="w-[350px] rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur">
        <p className="text-xs leading-relaxed text-slate-600">
          Pick a time, a population and a climate scenario, then{" "}
          <b>run the crash test</b> to see where modelled thermal stress and
          pedestrian exposure overlap.
        </p>
      </div>
    );
  }

  const persona = meta.personas.find((p) => p.key === sel.persona);
  const scenario = meta.scenarios.find((s) => s.key === sel.scenario);
  const c = result.conditions;
  const sunBand = band(result.utci_sun_c);
  const shadeBand = band(result.utci_shade_c);
  const useSevere = result.severe_total > 0;
  const here = result.day_profile?.find((d) => d.hour === sel.hour);
  const headroom = here?.headroom_c ?? 0;

  return (
    <div className="w-[350px] space-y-3 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-slate-600">
          {scenario?.label} · {sel.hour}:00 · {persona?.label}
        </span>
        {/* Snapshot identity: this number belongs to these inputs. */}
        <span
          className="cursor-help font-mono text-[9px] text-slate-400"
          title={`Snapshot ${result.snapshot_id}\nThis result is only valid for the inputs that produced it.`}
        >
          {result.snapshot_id}
        </span>
      </div>

      {/* 1 - the weather that goes in */}
      <Layer n={1} title="Weather input">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-700">
          <span>
            {c.air_temp_c.toFixed(1)} °C air
            <ValueBadge meta={meta.value_meta?.air_temp_c} compact />
          </span>
          <span>{c.rh_pct.toFixed(0)}% RH</span>
          <span>{c.wind_ms.toFixed(1)} m/s wind</span>
          <span className="text-slate-500">
            Tmrt {c.tmrt_shade_c.toFixed(0)}–{c.tmrt_sun_c.toFixed(0)} °C
            <ValueBadge meta={meta.value_meta?.tmrt_c} compact />
          </span>
        </div>
      </Layer>

      {/* 2 - what that does to a body */}
      <Layer n={2} title="Thermal stress (UTCI)">
        <div className="mb-1">
          <ValueBadge meta={meta.value_meta?.utci_c} />
        </div>
        <div className="flex items-end gap-4">
          <div>
            <div className="text-3xl font-bold tabular-nums text-orange-700">
              {result.utci_sun_c.toFixed(1)}
              <span className="ml-0.5 text-sm font-normal text-slate-500">°C</span>
            </div>
            <div className={`text-[11px] font-medium ${sunBand.colour}`}>
              in sun · {sunBand.label}
            </div>
          </div>
          <div>
            <div className="text-2xl font-semibold tabular-nums text-sky-700">
              {result.utci_shade_c.toFixed(1)}
              <span className="ml-0.5 text-xs font-normal text-slate-500">°C</span>
            </div>
            <div className={`text-[11px] ${shadeBand.colour}`}>
              in shade · {shadeBand.label}
            </div>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          Shade is worth <b>{c.shade_relief_c.toFixed(1)} °C</b> of UTCI here.
          Red on the map begins at {meta.severe_threshold_utci_c} °C.
        </p>
      </Layer>

      {/* 3 - how much of that people actually absorb */}
      <Layer n={3} title="Human exposure">
        {!adapted ? (
          <>
            {useSevere ? (
              <>
                <div className="text-2xl font-bold tabular-nums text-slate-900">
                  {fmt(result.severe_total)}
                  <span className="ml-1 text-xs font-normal text-slate-500">
                    severe person-minutes
                  </span>
                  <ValueBadge meta={meta.value_meta?.severe_person_minutes} compact />
                </div>
                <p className="text-[11px] text-slate-500">
                  at or above {meta.severe_threshold_utci_c} °C ·{" "}
                  heat load {fmt(result.heat_load_total)}
                </p>
                <p className="text-[11px] text-slate-600">
                  {fmt(result.walking_severe_total)} walking ·{" "}
                  {fmt(result.waiting_severe_total)} waiting at stops
                  <ValueBadge meta={meta.value_meta?.waiting_minutes} compact />
                </p>
              </>
            ) : (
              /* Zero is a result, not an empty state: say how close it came. */
              <>
                <div className="text-xl font-bold text-sky-800">
                  Below the severe threshold
                </div>
                <p className="text-[11px] leading-relaxed text-slate-600">
                  Nobody reaches {meta.severe_threshold_utci_c} °C at this hour.
                  The hottest exposure is{" "}
                  <b>{Math.abs(headroom).toFixed(1)} °C short</b> of it, so the
                  measure here is cumulative burden:{" "}
                  <b className="tabular-nums">{fmt(result.heat_load_total)}</b>{" "}
                  heat load.
                </p>
              </>
            )}
            {/* A weighted zero says nothing; only show it when there is
                something to weight. */}
            {useSevere && persona && persona.planning_weight !== 1 && (
              <p className="mt-1 text-[11px] text-amber-700">
                {fmt(result.weighted_severe_total)} under a ×
                {persona.planning_weight} planning priority — a policy choice,
                reported separately and never folded into the number above.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="flex items-end justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">
                  Before
                </div>
                <div className="text-2xl font-bold tabular-nums text-red-600">
                  {fmt(useSevere ? adapted.before_severe : adapted.before_heat_load)}
                </div>
              </div>
              <div className="pb-2 text-lg text-slate-400">→</div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">
                  After
                </div>
                <div className="text-2xl font-bold tabular-nums text-emerald-700">
                  {fmt(useSevere ? adapted.after_severe : adapted.after_heat_load)}
                </div>
              </div>
            </div>
            {useSevere && (
              <p className="mt-0.5 text-[11px] text-slate-600">
                walking {fmt(adapted.before_walking_severe)} →{" "}
                {fmt(adapted.after_walking_severe)} · waiting{" "}
                {fmt(adapted.before_waiting_severe)} →{" "}
                {fmt(adapted.after_waiting_severe)}
              </p>
            )}
            <p className="mt-0.5 text-[11px] text-slate-500">
              {useSevere ? "severe person-minutes" : "heat load"} ·{" "}
              ${fmt(adapted.spent_usd)} ·{" "}
              {Object.entries(adapted.counts)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${n} ${meta.interventions[k]?.label.toLowerCase() ?? k}`)
                .join(" + ") || "nothing placed"}
            </p>

            {/* Both scopes, always together: a big local win and a smaller
                city-wide one are different claims. */}
            <div className="mt-2 space-y-1.5">
              {adapted.impact_scopes.map((s) => (
                <div key={s.label} className="rounded-lg bg-slate-50 px-2.5 py-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] text-slate-700">{s.label}</span>
                    <span className="text-sm font-bold tabular-nums text-emerald-800">
                      −{s.reduction_pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-500">
                    across {s.length_km.toFixed(2)} km ·{" "}
                    {fmt(s.before_metric)} → {fmt(s.after_metric)}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              Identical geometry, identical {persona?.trips} trips, identical
              weather. The only change is the shade.
            </p>
          </>
        )}
      </Layer>

      <Layer n={4} title="When it bites">
        <DayProfile
          profile={result.day_profile}
          hour={sel.hour}
          threshold={meta.severe_threshold_utci_c}
          onPick={onPickHour}
        />
      </Layer>

      <Layer n={5} title="Where people are most exposed">
        <ol className="space-y-1">
          {hotspots.slice(0, 5).map((h, i) => (
            <li key={h.segId} className="flex items-baseline gap-2 text-xs">
              <span className="w-3 text-slate-400">{i + 1}</span>
              <span className="flex-1 truncate text-slate-700">
                {h.corridor ?? "Unnamed path"}
              </span>
              <span className="tabular-nums font-medium text-slate-900">
                {h.value.toFixed(1)}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-1 text-[11px] text-slate-500">
          Ranked by {hotspots[0]?.unit ?? "exposure"} — not by temperature. The
          hottest street is not always where people absorb the most.
        </p>
      </Layer>
    </div>
  );
}
