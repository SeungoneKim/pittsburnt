"use client";

import { useEffect, useRef } from "react";

import { STATUS_LABEL, STATUS_STYLE } from "@/lib/provenance";
import type { ValueStatus } from "@/lib/provenance";
import type { AdaptResult, CrashResult, Meta, Selection } from "@/lib/types";

const fmt = (n: number) => Math.round(n).toLocaleString();

/**
 * Everything the resting surface should not carry.
 *
 * Planning weights, raw trip counts, segment counts, model limitations, the
 * full hotspot list and the day profile all live here. A provenance badge
 * anywhere in the UI opens this drawer, scrolls to the matching entry and
 * highlights it, so a claim is one click from its source.
 */
export default function SourcesDrawer({
  meta, sel, result, adapted, focus, hotspots, onClose,
}: {
  meta: Meta;
  sel: Selection;
  result: CrashResult | null;
  adapted: AdaptResult | null;
  focus: string | null;
  hotspots: { corridor: string | null; value: number; unit: string }[];
  onClose: () => void;
}) {
  const refs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  useEffect(() => {
    if (!focus) return;
    const el = refs.current[focus];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-amber-400");
    const t = setTimeout(() => el.classList.remove("ring-2", "ring-amber-400"), 1500);
    return () => clearTimeout(t);
  }, [focus]);

  const m = meta.climate_method as Record<string, string>;
  const persona = meta.personas.find((p) => p.key === sel.persona);
  const scenario = meta.scenarios.find((s) => s.key === sel.scenario);

  const reg = (k: string) => (el: HTMLDivElement | null) => { refs.current[k] = el; };

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex justify-end
      bg-slate-900/25 backdrop-blur-[2px]" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="h-full w-[520px] overflow-y-auto bg-white shadow-2xl"
      >
        <header className="sticky top-0 z-10 flex items-baseline justify-between
          border-b border-slate-200 bg-white/95 px-6 py-4 backdrop-blur">
          <h2 className="text-[20px] font-bold tracking-tight">Sources &amp; method</h2>
          <button onClick={onClose}
            className="text-[13px] text-slate-500 hover:text-slate-900">Close</button>
        </header>

        <div className="space-y-5 px-6 py-5 text-[13px] leading-relaxed">
          <div className="rounded-xl border-l-4 border-red-500 bg-red-50 p-3">
            <b className="text-red-900">This is not a medical forecast.</b>
            <p className="mt-1 text-red-900/80">
              Pittsburnt does not promise a medically safe street. It shows
              where a reproducible future heat scenario overlaps with human
              walking and waiting, then makes the policy trade-off behind a
              budgeted shade plan visible. UTCI{" "}
              {meta.severe_threshold_utci_c} °C is a published thermal-stress
              class, not a diagnosis.
            </p>
          </div>

          {result && (
            <Block title="This result" k="snapshot" reg={reg}>
              <Kv k="Snapshot" v={result.snapshot_id} mono />
              <Kv k="Dataset" v={meta.dataset_version} mono />
              <Kv k="Scenario" v={scenario?.label ?? "—"} />
              <Kv k="Crossing hours"
                v={scenario?.crossing_hours.length
                  ? scenario.crossing_hours.map((h) => `${h}:00`).join(", ")
                  : "no sampled hour crosses the threshold"} />
              <Kv k="Segments modelled" v={`${fmt(meta.seg_ids.length)} · 167.16 km`} />
              <p className="mt-1 text-slate-500">
                Every result carries a hash of the inputs that produced it. A
                cached answer is refused unless that hash matches the request.
              </p>
            </Block>
          )}

          {result && (
            <Block title="Across the day" k="day" reg={reg}>
              <div className="space-y-1">
                {result.day_profile.map((d) => (
                  <div key={d.hour} className="flex items-baseline justify-between">
                    <span className={d.hour === sel.hour ? "font-semibold" : ""}>
                      {d.hour}:00
                    </span>
                    <span className="tabular-nums text-slate-600">
                      UTCI {d.utci_sun_c.toFixed(1)} °C ·{" "}
                      {d.crosses
                        ? `${fmt(d.severe)} severe person-min`
                        : `${Math.abs(d.headroom_c).toFixed(1)} °C below threshold`}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-slate-500">
                These are four sampled times, not four continuous hours.
              </p>
            </Block>
          )}

          {hotspots.length > 0 && (
            <Block title="Most exposed streets" k="hotspots" reg={reg}>
              <ol className="space-y-0.5">
                {hotspots.slice(0, 10).map((h, i) => (
                  <li key={i} className="flex justify-between">
                    <span>{i + 1}. {h.corridor ?? "Unnamed path"}</span>
                    <span className="tabular-nums">{h.value.toFixed(1)}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-1 text-slate-500">
                Ranked by {hotspots[0]?.unit}, not by temperature. A percentile
                may rank human hotspots; it never restates a thermal class.
              </p>
            </Block>
          )}

          <Block title="Thermal index" k="utci_c" reg={reg}>
            UTCI from air temperature, humidity, wind and mean radiant
            temperature. Sun enters through Tmrt: shade removes the direct
            beam, not the sky.{" "}
            <b>Humidity, wind and solar radiation are held constant</b> across
            scenarios — only air temperature carries the warming delta, so the
            comparison isolates it.
          </Block>

          <Block title="Air temperature and climate" k="air_temp_c" reg={reg}>
            <b>Observed hot-day baseline</b> — observed, not modelled, and not
            current weather: {m.baseline}. {m.baseline_source}.
            <br /><br />
            <b>Futures</b>: {m.projection_source}. Nothing is extrapolated.
            {" "}{m.longwave_assumption}.
          </Block>

          <Block title="Exposure metric" k="severe_person_minutes" reg={reg}>
            Human exposure = walking + waiting. Severe exposure counts
            person-minutes at or above {meta.severe_threshold_utci_c} °C. Heat
            load is continuous above 26 °C, so it responds to cooling that does
            not cross a class boundary.
            {persona && (
              <p className="mt-1">
                The primary figure is <b>unweighted</b>. {persona.label} carry a
                planning priority of ×{persona.planning_weight} — a statement
                about who a plan should protect first, not physiology. It is
                reported separately and never folded in.
              </p>
            )}
          </Block>

          <Block title="Who is walking" k="personas" reg={reg}>
            {meta.personas.map((p) => (
              <Kv key={p.key} k={p.label}
                v={`${p.speed_mps.toFixed(2)} m/s · ${fmt(p.trips)} simulated agents`
                  + (p.derived ? " · sum of the four cohorts" : "")} />
            ))}
            <p className="mt-1 text-slate-500">
              Synthetic fixed-seed samples (seed {meta.trip_seed}), not
              calibrated pedestrian counts or Census shares. Walking speeds are
              planning assumptions.
            </p>
          </Block>

          <Block title="Existing protection" k="protection" reg={reg}>
            <Kv k="Existing Tree Inventory" v="2,231 individual public tree points (City inventory)" />
            <Kv k="Existing Canopy Coverage" v={`${meta.canopy?.cover_pct}% of the study area · ${meta.canopy_vintage} raster`} />
            <p className="mt-1 text-slate-500">
              The two tree layers answer different questions: one is where a
              tree is recorded, the other is where foliage is overhead. The{" "}
              {meta.canopy_vintage} raster may omit recent planting and removals.
            </p>
          </Block>

          <Block title="Time" k="time" reg={reg}>
            Four sampled snapshot hours — 8 AM, 12 PM, 3 PM and 6 PM. Sun
            position, shadow geometry and pedestrian demand are precomputed at
            exactly these times for a frozen July date.
          </Block>

          <Block title="Climate scenarios" k="climate" reg={reg}>
            {meta.scenarios.map((s) => (
              <Kv key={s.key} k={s.label}
                v={`peak UTCI ${s.peak_utci_c} °C · `
                  + (s.crossing_hours.length
                    ? `crosses at ${s.crossing_hours.map((h) => `${h}:00`).join(", ")}`
                    : "never crosses")} />
            ))}
          </Block>

          {adapted && (
            <Block title="Why this plan" k="plan" reg={reg}>
              <Kv k="Policy" v={adapted.policy_label} />
              <Kv k="Budget" v={`$${fmt(sel.budget)}`} />
              <Kv k="Spent" v={`$${fmt(adapted.spent_usd)}`} />
              <Kv k="Units placed" v={`${adapted.unit_placements.length}`} />
              {adapted.service_floor.length > 0 && (
                <>
                  <p className="mt-1 font-medium">Service floor (Phase A)</p>
                  {adapted.service_floor.map((f) => (
                    <Kv key={f.seg_id} k={f.corridor}
                      v={`${f.waiting_severe_minutes_avoided.toFixed(3)} waiting severe min avoided`} />
                  ))}
                </>
              )}
              <p className="mt-1 text-slate-500">
                {adapted.rank_trace?.objective}. Labelled a policy, not a proven
                global optimum. Every figure is a value the optimiser recorded
                while deciding.
              </p>
            </Block>
          )}

          <Block title="Where every number comes from" k="provenance" reg={reg}>
            {(["source", "computed", "assumption"] as ValueStatus[]).map((st) => {
              const rows = Object.entries(meta.value_meta ?? {})
                .filter(([, v]) => v.status === st);
              if (!rows.length) return null;
              return (
                <div key={st} className="mb-1">
                  <span className={`rounded px-1 text-[10px] font-medium uppercase
                    tracking-wide ${STATUS_STYLE[st]}`}>{STATUS_LABEL[st]}</span>{" "}
                  <span className="text-slate-600">
                    {rows.map(([k]) => k.replace(/_/g, " ")).join(", ")}
                  </span>
                </div>
              );
            })}
          </Block>

          <Block title="Known limitations" k="limits" reg={reg}>
            <Kv k="Unit costs" v="$1,200 tree / $15,000 shelter — low-confidence planning assumptions, not Pittsburgh procurement quotes" />
            <Kv k="Transit share" v={`${((meta.waiting_exposure?.transit_trip_share ?? 0) * 100).toFixed(0)}% of walking trips assumed to end in a wait (10–30% sensitivity); service frequency is not ridership`} />
            <Kv k="Building heights" v="59.5% measured or sourced; the remainder modelled with record-level confidence" />
            <Kv k="Tree feasibility" v="Capacity is segment-length based and mature shade is immediate; utilities, pits, survival and Year-1 growth are not modelled" />
            <Kv k="Pedestrian demand" v="Synthetic fixed-seed trips, not observed counts" />
          </Block>
        </div>
      </aside>
    </div>
  );
}

function Block({ title, k, reg, children }: {
  title: string; k: string;
  reg: (k: string) => (el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  return (
    <div ref={reg(k)} className="rounded-xl border border-slate-200 p-3 transition">
      <h3 className="mb-1 text-[14px] font-semibold text-slate-900">{title}</h3>
      <div className="text-slate-700">{children}</div>
    </div>
  );
}

function Kv({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="shrink-0 text-slate-500">{k}</span>
      <span className={`text-right text-slate-800 ${mono ? "font-mono text-[11px]" : ""}`}>{v}</span>
    </div>
  );
}
