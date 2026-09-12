"use client";

import type { Hour, Meta, Selection, SourceMode } from "@/lib/types";

const HOUR_LABEL: Record<number, string> = { 8: "8 AM", 12: "12 PM", 15: "3 PM", 18: "6 PM" };

interface Props {
  meta: Meta;
  sel: Selection;
  onChange: (patch: Partial<Selection>) => void;
  layers: {
    shadow: boolean; canopy: boolean; trees: boolean;
    buildings: boolean; trips: boolean;
  };
  onLayers: (patch: Partial<Props["layers"]>) => void;
  mode: SourceMode;
  busy: boolean;
  hasResult: boolean;
  onCrashTest: () => void;
  onAdapt: () => void;
  onReset: () => void;
}

function Row({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-slate-200 px-4 py-3">
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        <span className="grid h-4 w-4 place-items-center rounded bg-slate-200 text-[9px] text-slate-600">
          {n}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Choice<T extends string | number>({
  value, options, onSelect,
}: {
  value: T;
  options: { key: T; label: string; hint?: string }[];
  onSelect: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.key)}
          onClick={() => onSelect(o.key)}
          title={o.hint}
          className={`rounded-md border px-2.5 py-1.5 text-xs transition ${
            o.key === value
              ? "border-slate-900 bg-slate-900 font-medium text-white"
              : "border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function ControlPanel({
  meta, sel, onChange, layers, onLayers, mode, busy, hasResult,
  onCrashTest, onAdapt, onReset,
}: Props) {
  const persona = meta.personas.find((p) => p.key === sel.persona);
  const scenario = meta.scenarios.find((s) => s.key === sel.scenario);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-white">
      <header className="border-b border-slate-200 px-4 py-3.5">
        <h1 className="text-lg font-bold tracking-tight">
          MEET <span className="text-red-600">PITTSBURNT</span>
        </h1>
        <p className="text-[11px] uppercase tracking-wider text-blue-700">
          A crash test for cities
        </p>
        <div className="mt-2 flex items-center gap-1.5 text-[10px]">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              mode === "live" ? "bg-emerald-500" : "bg-amber-500"
            }`}
          />
          <span className="text-slate-500">
            {mode === "live" ? "live engine" : "cached fallback (API unreachable)"}
          </span>
        </div>
      </header>

      <Row n={1} title="Map / scope">
        <p className="text-xs text-slate-600">
          Oakland, Pittsburgh · {meta.seg_ids.length.toLocaleString()} walking
          segments · Forbes / Fifth / Craig corridors
        </p>
      </Row>

      <Row n={2} title="Time">
        <Choice<Hour>
          value={sel.hour}
          options={meta.hours.map((h) => ({ key: h, label: HOUR_LABEL[h] }))}
          onSelect={(hour) => onChange({ hour })}
        />
      </Row>

      <Row n={3} title="Existing protection">
        <div className="grid grid-cols-2 gap-1.5">
          {([
            ["shadow", "Building shade"],
            ["canopy", "Tree canopy"],
            ["trees", "City trees"],
            ["buildings", "Buildings"],
            ["trips", "Walking routes"],
          ] as const).map(([key, label]) => (
            <label
              key={key}
              className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-700"
            >
              <input
                type="checkbox"
                checked={layers[key]}
                onChange={(e) => onLayers({ [key]: e.target.checked })}
                className="h-3.5 w-3.5 accent-slate-900"
              />
              {label}
            </label>
          ))}
        </div>
      </Row>

      <Row n={4} title="Who">
        <Choice
          value={sel.persona}
          options={meta.personas.map((p) => ({
            key: p.key,
            label: p.label,
            hint: `${p.speed_mps} m/s · planning weight ${p.planning_weight} · ${p.trips} trips`,
          }))}
          onSelect={(persona) => onChange({ persona })}
        />
        {persona && (
          <p className="mt-1.5 text-[11px] text-slate-500">
            {persona.speed_mps} m/s · {persona.trips} synthetic trips · planning
            weight {persona.planning_weight}
            {persona.planning_weight !== 1 && (
              <span className="text-amber-700"> (a city priority, not a risk coefficient)</span>
            )}
          </p>
        )}
      </Row>

      <Row n={5} title="Future scenario">
        <Choice
          value={sel.scenario}
          options={meta.scenarios.map((s) => ({ key: s.key, label: s.label }))}
          onSelect={(scenario) => onChange({ scenario })}
        />
        {scenario && scenario.delta_c > 0 && (
          <p className="mt-1.5 text-[11px] text-slate-500">
            +{scenario.delta_c.toFixed(2)} °C on the observed hot day
            {scenario.is_extrapolated && (
              <span className="text-amber-700"> · trend extrapolation</span>
            )}
          </p>
        )}
      </Row>

      <Row n={6} title="Adapt budget">
        <Choice
          value={sel.budget}
          options={meta.budgets.map((b) => ({
            key: b,
            label: b >= 1e6 ? `$${b / 1e6}M` : `$${b / 1000}K`,
          }))}
          onSelect={(budget) => onChange({ budget })}
        />
        <div className="mt-2.5">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">
            Spend it on
          </div>
          <Choice
            value={sel.variant}
            options={[
              { key: "all", label: "Optimise across all" },
              ...Object.entries(meta.interventions).map(([k, v]) => ({
                key: k,
                label: v.label,
                hint: `$${v.cost_usd.toLocaleString()} each · shades ~${v.shade_m} m`,
              })),
            ]}
            onSelect={(variant) => onChange({ variant })}
          />
          {sel.variant !== "all" && meta.interventions[sel.variant] && (
            <p className="mt-1.5 text-[11px] text-slate-500">
              ${meta.interventions[sel.variant].cost_usd.toLocaleString()} each ·
              shades ~{meta.interventions[sel.variant].shade_m} m of footway
            </p>
          )}
        </div>
      </Row>

      {/* Spacer so the sticky action bar never covers the last control row. */}
      <div className="h-2 shrink-0" />

      <div className="sticky bottom-0 mt-auto space-y-2 border-t border-slate-200 bg-white p-4 shadow-[0_-4px_12px_rgba(0,0,0,0.04)]">
        <button
          onClick={onCrashTest}
          disabled={busy}
          className="w-full rounded-lg bg-red-600 py-2.5 text-sm font-bold tracking-wide text-white transition hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? "RUNNING…" : "RUN CRASH TEST"}
        </button>
        <button
          onClick={onAdapt}
          disabled={busy || !hasResult}
          className="w-full rounded-lg bg-emerald-700 py-2.5 text-sm font-bold tracking-wide text-white transition hover:bg-emerald-800 disabled:opacity-40"
        >
          ADAPT PITTSBURGH
        </button>
        <button
          onClick={onReset}
          className="w-full rounded-lg border border-slate-300 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
