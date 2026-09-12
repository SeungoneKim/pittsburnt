"use client";

import { useState } from "react";
import type { Meta } from "@/lib/types";

/**
 * The honesty panel. The brief requires an assumptions list and an explicit
 * "not a medical forecast" disclaimer, and requires that dataset vintage be
 * exposed rather than implied to be current. Everything here is read from
 * the pipeline's own metadata, so it cannot drift from what was computed.
 */
export default function AssumptionsPanel({ meta }: { meta: Meta }) {
  const [open, setOpen] = useState(false);
  const m = meta.climate_method as Record<string, string>;

  return (
    <div className="pointer-events-auto">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-slate-300 bg-white/95 px-3 py-1.5 text-xs font-medium text-slate-700 shadow backdrop-blur hover:bg-white"
      >
        {open ? "Hide" : "Assumptions & sources"}
      </button>

      {open && (
        <div className="mt-2 max-h-[70vh] w-[360px] space-y-3 overflow-y-auto rounded-xl border border-slate-200 bg-white/97 p-4 text-[11px] leading-relaxed shadow-xl backdrop-blur">
          <div className="rounded-lg border-l-2 border-red-500 bg-red-50 px-3 py-2">
            <b className="text-red-900">This is not a medical forecast.</b>
            <p className="mt-0.5 text-red-900/80">
              UTCI {meta.severe_threshold_utci_c} °C is a published
              thermal-stress class, not a diagnosis and not a heatstroke
              probability. Pittsburnt compares the same simulated people over
              the same geometry before and after an intervention. It does not
              predict any individual&apos;s health outcome.
            </p>
          </div>

          <Section title="What the score means">
            Thermal stress is <b>UTCI</b>, the Universal Thermal Climate Index,
            computed from air temperature, humidity, wind and mean radiant
            temperature. Sun enters through Tmrt: a pedestrian in shade receives
            diffuse sky radiation, one in sun also receives the direct beam.
            <br />
            <br />
            The headline number counts <b>person-minutes at or above UTCI{" "}
            {meta.severe_threshold_utci_c} °C</b>, the published &ldquo;Very
            Strong Heat Stress&rdquo; class. Heat load is a secondary measure
            that also counts time below that threshold. Slower walkers
            accumulate more exposure because they are outside longer — there is
            no physiological multiplier anywhere in the model.
          </Section>

          <Section title="Planning weight">
            Weighting a vulnerable population above the average walker is a
            statement about who a heat plan should protect first, not a claim
            about anyone&apos;s physiology. The primary number is always
            <b> unweighted</b>; the weighted figure is shown beside it, clearly
            labelled, and never substituted for it.
          </Section>

          <Section title="Climate scenarios">
            <b>Observed hot-day baseline</b> — observed, not modelled, and not
            current weather: {m.baseline}. No live weather service is connected.
            <br />
            <span className="text-slate-500">{m.baseline_source}</span>
            <br />
            <b>Futures</b>: {m.projection_source}. Windows:{" "}
            {Object.values(
              (m as unknown as { projection_windows?: Record<string, string> })
                .projection_windows ?? {},
            ).join(" and ")}. Nothing is extrapolated.
            <br />
            {m.longwave_assumption}.
          </Section>

          <Section title="Shade and canopy">
            Building shadows are projected from footprint heights at each
            snapshot hour (shadow length = height ÷ tan(solar altitude)).
            Canopy comes from {meta.canopy_source}.{" "}
            <span className="text-amber-700">
              That layer is {meta.canopy_vintage} vintage and does not reflect
              trees planted or lost since.
            </span>{" "}
            Building heights are measured where OSM 3D data, height tags, or
            county assessment records exist, and modelled by building type and
            footprint size otherwise.
          </Section>

          <Section title="Pedestrian demand">
            Trips are synthetic, not observed: residential origins, destinations
            weighted by building footprint, routed on the OpenStreetMap walking
            network. Generated from a fixed seed ({meta.trip_seed}) so the
            before and after comparison runs the identical people over the
            identical geometry.
          </Section>

          <Section title="Interventions">
            {Object.entries(meta.interventions).map(([k, v]) => (
              <div key={k}>
                {v.label}: ${v.cost_usd.toLocaleString()} each, shades about{" "}
                {v.shade_m} m of footway.
              </div>
            ))}
            <span className="text-slate-500">
              Costs are planning-order-of-magnitude figures for a prototype, not
              procurement prices.
            </span>
          </Section>

          {meta.waiting_exposure && (
            <Section title="Waiting at transit stops">
              Exposure counts time spent <b>waiting</b> as well as walking. A
              person at a stop is standing still and cannot leave, which is
              what a shaded shelter protects.
              <br />
              <br />
              Wait duration is <b>derived</b>: half the headway, from real PRT
              service frequency at each of the{" "}
              {meta.waiting_exposure.stops} stops (median{" "}
              {meta.waiting_exposure.median_wait_minutes} minutes).
              <br />
              <span className="text-amber-700">
                ASSUMPTION — {(meta.waiting_exposure.transit_trip_share * 100).toFixed(0)}%
                of simulated trips are assumed to end in a transit wait
                (range{" "}
                {(meta.waiting_exposure.transit_trip_share_range[0] * 100).toFixed(0)}–
                {(meta.waiting_exposure.transit_trip_share_range[1] * 100).toFixed(0)}%).
                {" "}{meta.waiting_exposure.basis}
              </span>
            </Section>
          )}

          <Section title="What this model does not count">
            Walking and waiting at transit stops are counted. Other stationary
            time — queuing, sitting outside a café, working outdoors — is not,
            so this understates total exposure rather than overstating it.
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </div>
      <div className="text-slate-700">{children}</div>
    </div>
  );
}
