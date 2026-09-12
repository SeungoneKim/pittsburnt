"use client";

import type { AdaptResult, CrashResult, Meta, Selection } from "@/lib/types";

const fmt = (n: number) => Math.round(n).toLocaleString();
const f = (c: number) => `${(c * 9 / 5 + 32).toFixed(1)}°F`;

/**
 * Three states, side by side: today's observed hot day, the chosen future
 * before any intervention, and that same future after it.
 *
 * The middle column is the honest comparator. Reading the baseline against
 * the adjusted future would credit shade with undoing the warming as well,
 * so the intervention effect is only ever computed across the last two
 * columns - and the delta chips sit on that pair alone.
 */
export default function ThreeState({ meta, sel, result, adapted }: {
  meta: Meta; sel: Selection; result: CrashResult; adapted: AdaptResult | null;
}) {
  const b = result.baseline_state;
  const futureLabel = meta.scenarios.find((s) => s.key === sel.scenario)?.label
    ?? "Future";
  const isBaseline = sel.scenario === "baseline";

  const rows = [
    {
      icon: "temp", label: "Air temp",
      base: f(b.air_temp_c),
      before: f(result.conditions.air_temp_c),
      after: adapted ? f(result.conditions.air_temp_c) : null,
      // Weather is identical before and after: shade does not cool the air
      // mass, and pretending otherwise would be the easiest lie here. It is
      // reported neutral, never green - an unchanged number is not a win.
      delta: adapted ? "same weather" : null,
      deltaTone: "flat" as const,
    },
    {
      // The person-minute-weighted value, not the full-sun anchor and not
      // "local by segment", which was a label where a number belonged.
      icon: "sun", label: "Experienced UTCI",
      base: `${b.experienced_utci_c.toFixed(2)}°C`,
      before: `${(adapted?.before_experienced_utci_c
        ?? result.experienced_utci_c).toFixed(2)}°C`,
      after: adapted ? `${adapted.after_experienced_utci_c.toFixed(2)}°C` : null,
      delta: adapted
        ? `${(adapted.after_experienced_utci_c
          - adapted.before_experienced_utci_c).toFixed(2)} °C`
        : null,
      deltaTone: "good" as const,
    },
    {
      // The primary burden number. It is continuous, so cooling from 37.9 to
      // 34 registers; the severe count below it cannot, because both
      // scenarios cross 38 C and the binary class counts the same minutes.
      icon: "load", label: "Heat load",
      base: fmt(b.heat_load),
      before: fmt(adapted ? adapted.before_heat_load : result.heat_load_total),
      after: adapted ? fmt(adapted.after_heat_load) : null,
      delta: adapted
        ? `${pct(adapted.before_heat_load, adapted.after_heat_load)}`
        : null,
      deltaTone: "good" as const,
      primary: true,
    },
    {
      icon: "people", label: "Severe exposure",
      base: fmt(b.severe),
      before: fmt(adapted ? adapted.before_severe : result.severe_total),
      after: adapted ? fmt(adapted.after_severe) : null,
      delta: adapted && adapted.before_severe > 0
        ? `${pct(adapted.before_severe, adapted.after_severe)}`
        : null,
      deltaTone: "good" as const,
      unit: "person-min",
    },
  ];

  return (
    <div>
      <h2 className="text-[19px] font-extrabold tracking-tight text-slate-900">
        {isBaseline ? "Observed hot day" : futureLabel}
        {adapted && <span className="text-emerald-700"> after adjust</span>}
      </h2>

      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto_auto]
        gap-x-1 gap-y-1">
        <span />
        <Head>2026<br />base</Head>
        <Head>{isBaseline ? "—" : "future"}<br />before</Head>
        <Head active={!!adapted}>{isBaseline ? "—" : "future"}<br />after</Head>

        {rows.map((r) => (
          <Row key={r.label} {...r} />
        ))}
      </div>
      <p className="mt-2 text-[11.5px] leading-snug text-slate-500">
        Humidity {result.conditions.rh_pct.toFixed(0)}%, wind{" "}
        {result.conditions.wind_ms.toFixed(2)} m/s and solar radiation are{" "}
        <b className="font-semibold text-slate-600">held constant</b> across
        every column, so only air temperature carries the warming.
      </p>
      <p className="mt-1 text-[11.5px] leading-snug text-slate-500">
        The plan&apos;s effect is the change between the last two columns. The
        2026 column is context: comparing it with the adjusted future would
        credit shade with undoing the warming too.
      </p>
    </div>
  );
}

function pct(before: number, after: number): string {
  if (!before) return "—";
  return `${(((after - before) / before) * 100).toFixed(1)}%`;
}

function Head({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <div className={`px-1 text-center text-[9.5px] font-semibold uppercase
      leading-tight tracking-wide ${active ? "text-emerald-800" : "text-slate-400"}`}>
      {children}
    </div>
  );
}

function Row({ icon, label, base, before, after, delta, deltaTone, unit,
  primary }: {
  icon: string; label: string; base: string; before: string;
  after: string | null; delta: string | null;
  deltaTone: "good" | "flat"; unit?: string; primary?: boolean;
}) {
  return (
    <>
      <div className="flex min-w-0 items-baseline gap-1 py-1">
        <RowMark kind={icon} />
        <span className={`uppercase leading-tight tracking-wide ${primary
          ? "text-[12px] font-bold text-slate-900"
          : "text-[11.5px] text-slate-500"}`}>
          {label}
        </span>
        {unit && <span className="text-[9px] text-slate-400">{unit}</span>}
      </div>
      <Cell>{base}</Cell>
      <Cell strong={!after} primary={primary}>{before}</Cell>
      <Cell strong={!!after} active={!!after} primary={primary}>
        {after ?? "—"}
        {delta && (
          <span className={`mt-0.5 block text-[11px] font-semibold ${
            deltaTone === "good" ? "text-emerald-700" : "text-slate-500"}`}>
            {delta}
          </span>
        )}
      </Cell>
    </>
  );
}

function RowMark({ kind }: { kind: string }) {
  const d: Record<string, string> = {
    temp: "M10 3a2 2 0 0 1 2 2v7a4 4 0 1 1-4 0V5a2 2 0 0 1 2-2Z",
    sun: "M10 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
    load: "M3 16h3v-6H3zM8.5 16h3V5h-3zM14 16h3v-9h-3z",
    people: "M7 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm6 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2 16c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5Zm11.5-4.2c2.4.3 4.5 1.9 4.5 4.2h-4Z",
  };
  return (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0 fill-slate-400" aria-hidden>
      <path d={d[kind] ?? d.load} />
    </svg>
  );
}

function Cell({ children, strong, active, primary }: {
  children: React.ReactNode; strong?: boolean; active?: boolean;
  primary?: boolean;
}) {
  const size = primary
    ? (strong ? "text-[17px] font-extrabold text-slate-900"
      : "text-[14px] font-semibold text-slate-600")
    : (strong ? "text-[14.5px] font-bold text-slate-900"
      : "text-[12.5px] text-slate-500");
  return (
    <div className={`w-[60px] shrink-0 rounded-md px-1 py-1 text-center tabular-nums
      ${active ? "bg-emerald-50" : ""} ${size}`}>
      {children}
    </div>
  );
}
