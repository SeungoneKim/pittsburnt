"use client";

import { useEffect, useState } from "react";

import { compile, describe, solve, vocabulary } from "@/lib/program";
import type { CompileReply, ProgramResult, Vocabulary } from "@/lib/program";
import type { ReadySelection } from "@/lib/types";

const EXAMPLES = [
  "Protect older adults on Forbes, don't let any corridor get nothing, "
  + "cap Forbes at half the budget",
  "Spread the money so nowhere gets left out",
  "Prioritise students at noon and spend at least a third on Fifth Avenue",
];

/**
 * State a goal; a solver answers it.
 *
 * Three visible steps, and the middle one is the point: the sentence becomes
 * a typed program you can read before anything is solved. If the model wrote
 * a program you did not mean, you can see that it did - and if the sentence
 * asked for something the engine cannot express, it is listed rather than
 * quietly approximated into a number.
 */
export default function ProgramPanel({ sel, onPlan, onClose }: {
  sel: ReadySelection;
  onPlan: (p: ProgramResult) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(EXAMPLES[0]);
  const [vocab, setVocab] = useState<Vocabulary | null>(null);
  const [reply, setReply] = useState<CompileReply | null>(null);
  const [result, setResult] = useState<ProgramResult | null>(null);
  const [stage, setStage] = useState<"idle" | "compiling" | "solving">("idle");
  const [error, setError] = useState<string | null>(null);

  const defaults = {
    scenario: sel.scenario, hour: sel.hour,
    persona: sel.persona, budget: sel.budget,
  };

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  useEffect(() => {
    vocabulary(defaults).then(setVocab).catch(() => setVocab(null));
    // The vocabulary depends on the question, which cannot change while this
    // panel is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    setStage("compiling"); setError(null); setReply(null); setResult(null);
    try {
      const c = await compile(text, defaults);
      setReply(c);
      if (!c.verdict.ok) { setStage("idle"); return; }
      setStage("solving");
      const plan = await solve(c.spec);
      setResult(plan);
      onPlan(plan);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setStage("idle"); }
  };

  const busy = stage !== "idle";

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex justify-end
      bg-slate-900/25 backdrop-blur-[2px]" onClick={onClose}>
      <aside onClick={(e) => e.stopPropagation()}
        className="h-full w-[560px] overflow-y-auto bg-white shadow-2xl">
        <header className="sticky top-0 z-10 flex items-baseline gap-2
          border-b border-slate-200 bg-white/95 px-6 py-4 backdrop-blur">
          <h2 className="text-[20px] font-bold tracking-tight">State a goal</h2>
          <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px]
            font-bold uppercase tracking-wide text-indigo-800">solver</span>
          <button onClick={onClose}
            className="ml-auto text-[13px] text-slate-500 hover:text-slate-900">
            Close
          </button>
        </header>

        <div className="space-y-4 px-6 py-5 text-[13px] leading-relaxed">
          <p className="rounded-xl border-l-4 border-indigo-400 bg-indigo-50 p-3
            text-indigo-900/85">
            Say what the plan has to achieve. A language model turns it into a
            formal program — you can read it below before anything runs — and a
            mixed-integer solver finds the <b>provably optimal</b> plan for
            exactly that program. The model never places a unit or scores a
            plan.
          </p>

          <div>
            <textarea rows={3} value={text} disabled={busy}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2
                text-[14px] outline-none focus:ring-2 focus:ring-indigo-300
                disabled:bg-slate-50" />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {EXAMPLES.slice(1).map((x) => (
                <button key={x} onClick={() => setText(x)} disabled={busy}
                  className="rounded-full border border-slate-200 px-2.5 py-1
                    text-[11.5px] text-slate-600 hover:border-slate-400">
                  {x.length > 46 ? `${x.slice(0, 44)}…` : x}
                </button>
              ))}
            </div>
            <button onClick={run} disabled={busy || !text.trim()}
              className="mt-2 rounded-lg bg-indigo-700 px-4 py-2 text-[13px]
                font-bold uppercase tracking-wide text-white
                disabled:bg-slate-300">
              {stage === "compiling" ? "Compiling…"
                : stage === "solving" ? "Solving…" : "Build the program"}
            </button>
            {vocab && (
              <p className="mt-1.5 text-[11px] text-slate-500">
                {vocab.provider.configured
                  ? <>Compiled by <b>{vocab.provider.model}</b> against{" "}
                    {vocab.corridors.length} real corridors, then solved by
                    HiGHS.</>
                  : "No model configured — compilation is unavailable."}
              </p>
            )}
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 p-2 text-[12px] text-red-800">
              {error}
            </p>
          )}

          {reply && (
            <div className="rounded-xl border border-slate-200 p-3">
              <h3 className="text-[12px] uppercase tracking-wider text-slate-500">
                The program it built {reply.repaired && (
                  <span className="ml-1 rounded bg-amber-100 px-1 text-[10px]
                    font-semibold text-amber-900">repaired once</span>)}
              </h3>
              {reply.restated && (
                <p className="mt-1 text-[13px] text-slate-800">{reply.restated}</p>
              )}
              <dl className="mt-2 space-y-1">
                <Row k="Objective" v={reply.spec.objective === "min_heat_load"
                  ? "Minimise heat load (continuous above 26 °C)"
                  : "Minimise person-minutes at or above 38 °C"} />
                {reply.spec.cells.map((c, i) => (
                  <Row key={i} k="For"
                    v={`${c.persona.replace(/_/g, " ")} · ${c.hour}:00 · ${c.scenario}`} />
                ))}
                <Row k="Budget" v={`$${reply.spec.budget_usd.toLocaleString()}`} />
              </dl>
              {reply.spec.constraints.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {reply.spec.constraints.map((c, i) => (
                    <li key={i} className="flex gap-2 text-[12.5px] text-slate-700">
                      <span className="text-indigo-500">▪</span>{describe(c)}
                    </li>
                  ))}
                </ul>
              )}

              {reply.unsupported.length > 0 && (
                <div className="mt-2 rounded-lg bg-amber-50 p-2">
                  <b className="text-[12px] text-amber-900">
                    Not expressible in this model, so left out:
                  </b>
                  <ul className="mt-0.5 list-disc pl-4 text-[11.5px] text-amber-900/85">
                    {reply.unsupported.map((u) => <li key={u}>{u}</li>)}
                  </ul>
                </div>
              )}

              {!reply.verdict.ok && (
                <div className="mt-2 rounded-lg bg-red-50 p-2 text-[12px] text-red-900">
                  <b>Refused.</b>
                  <ul className="mt-0.5 list-disc pl-4">
                    {reply.verdict.reasons.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {result && (
            <div className="rounded-xl border-l-4 border-emerald-500
              bg-emerald-50 p-3">
              <h3 className="text-[14px] font-semibold text-emerald-900">
                Solved — {result.counts.tree} trees,{" "}
                {result.counts.shaded_shelter} shelters, $
                {Math.round(result.spent_usd).toLocaleString()}
              </h3>
              <p className="mt-0.5 text-[11.5px] font-medium text-emerald-800">
                {result.solver.certificate} · {result.solver.integer_variables}{" "}
                integer variables, {result.solver.constraints} rows ·{" "}
                {result.solver.backend}
              </p>
              <div className="mt-2 space-y-0.5 text-[12px] text-emerald-900/85">
                <Line k="Heat load" a={result.before_heat_load} b={result.after_heat_load} />
                <Line k="Severe exposure" a={result.before_severe} b={result.after_severe} />
                <div className="flex justify-between">
                  <span>Experienced UTCI</span>
                  <span className="tabular-nums font-semibold">
                    {result.before_experienced_utci_c.toFixed(2)} →{" "}
                    {result.after_experienced_utci_c.toFixed(2)} °C
                  </span>
                </div>
              </div>

              <h4 className="mt-2.5 border-t border-emerald-200 pt-2 text-[11px]
                uppercase tracking-wider text-emerald-800">
                What each constraint did
              </h4>
              <ul className="mt-1 space-y-1">
                {result.constraint_report.map((c, i) => (
                  <li key={i} className="text-[11.5px] leading-snug
                    text-emerald-900/80">
                    <span className={`mr-1.5 rounded px-1 text-[9.5px]
                      font-bold uppercase ${
                        c.status === "binding" ? "bg-amber-200 text-amber-900"
                          : c.status === "slack" ? "bg-slate-200 text-slate-700"
                            : "bg-emerald-200 text-emerald-900"}`}>
                      {c.status ?? "applied"}
                    </span>
                    {c.note}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-emerald-900/70">
                Every coordinate and every number here came from the
                deterministic engine. The model chose the question; the solver
                proved the answer.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 text-[12.5px]">
      <dt className="shrink-0 text-slate-500">{k}</dt>
      <dd className="text-right text-slate-800">{v}</dd>
    </div>
  );
}

function Line({ k, a, b }: { k: string; a: number; b: number }) {
  const pct = a ? ((b - a) / a) * 100 : 0;
  return (
    <div className="flex justify-between">
      <span>{k}</span>
      <span className="tabular-nums font-semibold">
        {Math.round(a).toLocaleString()} → {Math.round(b).toLocaleString()}
        <span className="ml-1.5 text-emerald-700">{pct.toFixed(1)}%</span>
      </span>
    </div>
  );
}
