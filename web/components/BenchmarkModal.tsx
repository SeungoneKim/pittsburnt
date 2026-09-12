"use client";

import { useEffect } from "react";

/** One measure, deployed on its own at the shared budget. */
export interface BenchmarkMeasure {
  key: string;
  label: string;
  is_custom: boolean;
  mechanism: string;
  unit_cost_usd: number;
  units: number;
  spent_usd: number;
  after_severe: number;
  after_heat_load: number;
  after_experienced_utci_c: number;
  d_severe: number;
  d_heat_load: number;
  d_experienced_utci_c: number;
  efficiency_per_10k: number;
}

export interface Benchmark {
  budget_usd: number;
  scenario: string;
  hour: number;
  persona: string;
  before: { severe: number; heat_load: number; experienced_utci_c: number };
  measures: BenchmarkMeasure[];
  optimiser_picks: {
    counts: Record<string, number>; custom_units: number;
    spent_usd: number; after_severe: number; reduction_pct: number;
  };
  unbought: { kind: string; label: string; reason: string }[];
}

const fmt = (n: number) => Math.round(n).toLocaleString();

/** Each measure keeps the identity it has on the map. */
function palette(m: BenchmarkMeasure) {
  if (m.is_custom) return { bar: "#8b5cf6", ink: "text-violet-900",
    wash: "bg-violet-50", edge: "border-violet-200" };
  if (m.key === "shaded_shelter") return { bar: "#14b8a6",
    ink: "text-teal-900", wash: "bg-teal-50", edge: "border-teal-200" };
  return { bar: "#22c55e", ink: "text-emerald-900", wash: "bg-emerald-50",
    edge: "border-emerald-200" };
}

function Glyph({ m }: { m: BenchmarkMeasure }) {
  if (m.key === "tree") {
    return (
      <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
        <rect x="9" y="12" width="2" height="6" fill="#6b4423" />
        <circle cx="10" cy="7" r="5" fill="#2f8f4e" />
        <circle cx="6.5" cy="10" r="3.6" fill="#3da35d" />
        <circle cx="13.5" cy="10" r="3.6" fill="#3da35d" />
      </svg>
    );
  }
  if (m.key === "shaded_shelter") {
    return (
      <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
        <path d="M2 9 L10 3 L18 9 Z" fill="#14b8a6" />
        <path d="M4 9v8M16 9v8" stroke="#0f766e" strokeWidth="1.8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
      <path d="M3 9 Q10 3 17 9 Q10 7 3 9 Z" fill="#8b5cf6" />
      <path d="M4 9v8M16 9v8" stroke="#5b21b6" strokeWidth="1.8" />
    </svg>
  );
}

/**
 * Three measures, one budget, one honest axis.
 *
 * The comparison is deliberately of *deployments*, not of optimiser choices:
 * each measure spends the whole budget on its own best ground, so none of
 * them is quietly skipped for being unhelpful. That is what makes the
 * uncomfortable answer visible - a reflective surface can spend a quarter of
 * a million dollars and leave pedestrians hotter, because it lowers the
 * ground temperature and raises the radiant temperature a person standing on
 * it receives.
 *
 * Heat load is the axis because it is continuous. Severe person-minutes is a
 * threshold count and barely moves here, which would make a real effect look
 * like no effect.
 */
export default function BenchmarkModal({ benchmark, onClose }: {
  benchmark: Benchmark; onClose: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  // Positive = heat load avoided. A measure that adds heat goes negative,
  // and the axis shows it on the other side of zero rather than as a
  // suspiciously short bar.
  const avoided = benchmark.measures.map((m) => -m.d_heat_load);
  const span = Math.max(...avoided.map(Math.abs), 1);
  const custom = benchmark.measures.find((m) => m.is_custom);
  const best = benchmark.measures.reduce((a, b) =>
    (-b.d_heat_load > -a.d_heat_load ? b : a));
  const customHurts = !!custom && custom.d_heat_load > 0;

  return (
    <div className="pointer-events-auto absolute inset-0 z-50 grid
      place-items-center bg-slate-900/45 p-6 backdrop-blur-sm"
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="max-h-[calc(100dvh-48px)] w-[760px] overflow-y-auto
          rounded-3xl border border-white/70 bg-white shadow-2xl">

        <header className="sticky top-0 z-10 border-b border-slate-200
          bg-white/95 px-7 pb-4 pt-5 backdrop-blur">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[22px] font-extrabold tracking-tight
              text-slate-900">
              Same budget, three measures
            </h2>
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px]
              font-bold uppercase tracking-wide text-violet-800">Beta</span>
            <button onClick={onClose}
              className="ml-auto text-[13px] text-slate-500
                hover:text-slate-900">Close</button>
          </div>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            ${fmt(benchmark.budget_usd)} · {benchmark.hour}:00 ·{" "}
            {benchmark.persona.replace(/_/g, " ")} · {benchmark.scenario}.
            Each measure spends the whole budget on its own best ground.
          </p>
        </header>

        <div className="px-7 py-5">
          {/* The verdict, stated before the evidence rather than buried. */}
          {custom && (
            <div className={`rounded-2xl border-l-4 p-4 ${customHurts
              ? "border-red-500 bg-red-50" : "border-emerald-500 bg-emerald-50"}`}>
              <div className={`text-[15px] font-bold ${customHurts
                ? "text-red-900" : "text-emerald-900"}`}>
                {customHurts
                  ? `${custom.label} spends $${fmt(custom.spent_usd)} and leaves people hotter.`
                  : `${custom.label} helps, but ${best.label.toLowerCase()} helps more.`}
              </div>
              <p className={`mt-1 text-[12.5px] leading-snug ${customHurts
                ? "text-red-900/80" : "text-emerald-900/80"}`}>
                {customHurts ? (
                  <>Heat load rises by {fmt(Math.abs(custom.d_heat_load))} and
                    the experienced UTCI by{" "}
                    {Math.abs(custom.d_experienced_utci_c).toFixed(2)} °C. A
                    reflective surface lowers the temperature of the ground and
                    raises the radiant temperature a person standing on it
                    receives — the engine recomputes UTCI from mean radiant
                    temperature, so it reports that rather than assuming
                    &ldquo;cooler pavement, cooler people&rdquo;.</>
                ) : (
                  <>The same money in {best.label.toLowerCase()}s avoids{" "}
                    {fmt(-best.d_heat_load)} heat load against{" "}
                    {fmt(-custom.d_heat_load)}.</>
                )}
              </p>
            </div>
          )}

          <h3 className="mt-5 text-[11px] font-semibold uppercase
            tracking-wider text-slate-500">
            Heat load avoided across the modelled network
          </h3>

          {/* Diverging bars from a real zero, so "worse" looks worse. */}
          <div className="mt-3 space-y-3">
            {benchmark.measures.map((m, i) => {
              const c = palette(m);
              const v = avoided[i];
              const pct = (Math.abs(v) / span) * 50;
              return (
                <div key={m.key} className={`rounded-2xl border ${c.edge}
                  ${c.wash} p-3`}>
                  <div className="flex items-center gap-2">
                    <Glyph m={m} />
                    <span className={`text-[14px] font-bold ${c.ink}`}>
                      {m.label}
                    </span>
                    {m.is_custom && (
                      <span className="rounded bg-white/80 px-1.5 py-0.5
                        text-[9.5px] font-bold uppercase tracking-wide
                        text-violet-800">yours</span>
                    )}
                    <span className="ml-auto text-[12px] tabular-nums
                      text-slate-600">
                      {m.units} × ${fmt(m.unit_cost_usd)} ={" "}
                      <b className="text-slate-900">${fmt(m.spent_usd)}</b>
                    </span>
                  </div>

                  <div className="relative mt-2 h-7">
                    <div className="absolute inset-y-0 left-1/2 w-px
                      bg-slate-300" />
                    <div className="absolute inset-y-1 rounded"
                      style={{
                        background: v >= 0 ? c.bar : "#dc2626",
                        left: v >= 0 ? "50%" : `${50 - pct}%`,
                        width: `${pct}%`,
                      }} />
                    {/* The longest bar reaches the edge, so its label goes
                        inside rather than off the card. */}
                    <span className={`absolute top-1/2 -translate-y-1/2
                      text-[12.5px] font-bold tabular-nums ${
                        pct > 38 ? "text-white"
                          : v >= 0 ? "text-slate-900" : "text-red-700"}`}
                      style={pct > 38
                        ? (v >= 0
                          ? { left: `calc(50% + ${pct}% - 3.5rem)` }
                          : { right: `calc(50% + ${pct}% - 3.5rem)` })
                        : (v >= 0
                          ? { left: `calc(51% + ${pct}%)` }
                          : { right: `calc(51% + ${pct}%)` })}>
                      {v >= 0 ? `−${fmt(v)}` : `+${fmt(-v)}`}
                    </span>
                  </div>

                  <div className="mt-1 grid grid-cols-3 gap-2">
                    <Stat k="Experienced UTCI"
                      v={`${m.d_experienced_utci_c >= 0 ? "+" : ""}${
                        m.d_experienced_utci_c.toFixed(2)} °C`}
                      bad={m.d_experienced_utci_c > 0} />
                    <Stat k="Severe person-min"
                      v={`${m.d_severe >= 0 ? "+" : ""}${m.d_severe.toFixed(0)}`}
                      bad={m.d_severe > 0} />
                    <Stat k="Avoided per $10K"
                      v={m.efficiency_per_10k.toFixed(2)}
                      bad={m.efficiency_per_10k <= 0} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-2 flex justify-between text-[11px] text-slate-400">
            <span>← adds heat</span><span>avoids heat →</span>
          </div>

          {/* What the optimiser does when they compete for the same money. */}
          <div className="mt-5 rounded-2xl border border-slate-200 p-3.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider
              text-slate-500">
              And when they compete for the same money
            </h3>
            <p className="mt-1 text-[13px] text-slate-800">
              The optimiser buys{" "}
              {Object.entries(benchmark.optimiser_picks.counts)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
                .join(", ") || "nothing"} — and{" "}
              <b>{benchmark.optimiser_picks.custom_units}</b> of{" "}
              {custom?.label.toLowerCase()}.
            </p>
            {benchmark.unbought.map((u) => (
              <p key={u.kind} className="mt-1 text-[11.5px] leading-snug
                text-slate-500">{u.reason}</p>
            ))}
          </div>

          <p className="mt-4 text-[11px] leading-snug text-slate-500">
            Every figure here was computed by the deterministic engine over the
            identical scenario, hour, people and budget. The language model
            drafted the measure and asked for the evidence; it did not place a
            unit, price anything or decide what these numbers are.
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, bad }: { k: string; v: string; bad: boolean }) {
  return (
    <div className="rounded-lg bg-white/70 px-2 py-1.5">
      <div className="text-[9.5px] uppercase tracking-wide text-slate-500">
        {k}
      </div>
      <div className={`text-[14px] font-bold tabular-nums ${
        bad ? "text-red-700" : "text-slate-900"}`}>{v}</div>
    </div>
  );
}
