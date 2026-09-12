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
              Pittsburnt reports a modelled Heat Exposure Score in At-risk
              Pedestrian Minutes. It compares the same city before and after
              an intervention. It does not predict any individual&apos;s health
              outcome, and it is not a heatstroke probability.
            </p>
          </div>

          <Section title="What the score means">
            Sun exposure raises the apparent temperature (the NWS Heat Index is
            a shade measure; full sun adds about 8 °C). Severity is scaled 0 at
            the NWS Caution threshold to 1.0 at Danger, then multiplied by the
            minutes each population spends on each segment. Slower walkers
            accumulate more exposure because they are outside longer — there is
            no physiological multiplier.
          </Section>

          <Section title="Planning weight">
            Weighting a vulnerable population above the average walker is a
            statement about who a heat plan should protect first, not a claim
            about anyone&apos;s physiology. Unweighted exposure is reported
            alongside every weighted figure.
          </Section>

          <Section title="Climate scenarios">
            <b>Today</b> is observed, not modelled: {m.baseline}.<br />
            <span className="text-slate-500">{m.baseline_source}</span>
            <br />
            <b>Futures</b>: {m.projection_source}.
            <br />
            <span className="text-amber-700">{m.extrapolation_note}</span>
            <br />
            {m.humidity_assumption}.
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

          <Section title="What this model does not count">
            Exposure is scored for people <b>walking</b>. Time spent standing
            still — waiting at a stop, queuing, sitting outside — is not in the
            model, so interventions that mainly protect stationary people are
            not represented here.
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
