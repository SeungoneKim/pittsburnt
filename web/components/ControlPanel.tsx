"use client";

import { useEffect, useState } from "react";

import { formatBudget, parseBudget } from "@/lib/budget";
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

/**
 * Any valid budget, not just the presets. "$250K", "250,000" and "0.25M" all
 * normalise to the same number.
 *
 * In cached-fallback mode only the precomputed budgets can be answered, and
 * the spec forbids serving one budget's cached plan for another - so an
 * off-preset value is refused with a reason rather than quietly rounded.
 */
function BudgetField({ value, presets, cachedOnly, onCommit }: {
  value: number;
  presets: number[];
  cachedOnly: boolean;
  onCommit: (usd: number) => void;
}) {
  const [text, setText] = useState(formatBudget(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setText(formatBudget(value)); setError(null); }, [value]);

  const commit = () => {
    const { usd, error: err } = parseBudget(text);
    if (usd === null) { setError(err); return; }
    if (cachedOnly && !presets.includes(usd)) {
      setError("Cached mode answers the preset budgets only");
      return;
    }
    setError(null);
    // Show the normalised form back, so "0.25M" visibly becomes "$250K".
    setText(formatBudget(usd));
    onCommit(usd);
  };

  return (
    <>
      <div className="flex gap-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
          aria-label="Adapt budget in US dollars"
          className={`w-28 rounded-md border px-2 py-1.5 text-xs tabular-nums
            outline-none focus:ring-1 ${error
              ? "border-red-400 focus:ring-red-300"
              : "border-slate-300 focus:ring-slate-400"}`}
        />
        <button
          onClick={commit}
          className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs
            text-slate-700 transition hover:bg-slate-50"
        >
          Set
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {presets.map((b) => (
          <button
            key={b}
            onClick={() => onCommit(b)}
            className={`rounded px-1.5 py-0.5 text-[11px] transition ${
              b === value
                ? "bg-slate-900 text-white"
                : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            {formatBudget(b)}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Any amount — &ldquo;$250K&rdquo;, &ldquo;250,000&rdquo; and
        &ldquo;0.25M&rdquo; all mean the same thing.
      </p>
    </>
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
        <p className="mt-1 text-[11px] text-slate-500">
          The dashed square on the map is the modelled area. Context layers
          extend past it; nothing outside it is scored.
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
            hint: `${p.speed_mps.toFixed(2)} m/s · planning priority x${p.planning_weight} · ${p.trips} agents`,
          }))}
          onSelect={(persona) => onChange({ persona })}
        />
        {persona && (
          <p className="mt-1.5 text-[11px] text-slate-500">
            {persona.speed_mps.toFixed(2)} m/s (planning assumption) ·{" "}
            {persona.trips}{" "}
            simulated agents
            {persona.planning_weight !== 1 && (
              <>
                {" "}· planning priority ×{persona.planning_weight}
                <span className="text-amber-700">
                  {" "}— a city priority, not a risk coefficient
                </span>
              </>
            )}
            {persona.derived && (
              <span className="text-slate-600">
                {" "}· sum of {persona.composition?.length ?? 0} cohorts, equal
                weight, not calibrated to census demographics
              </span>
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
        <BudgetField
          value={sel.budget}
          presets={meta.budgets}
          cachedOnly={mode === "fallback"}
          onCommit={(budget) => onChange({ budget })}
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
