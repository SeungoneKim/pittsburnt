"use client";

import { useEffect, useState } from "react";

import { formatBudget, parseBudget } from "@/lib/budget";
import type { Meta, Selection } from "@/lib/types";

/**
 * Budget and policy, in a focused overlay opened after a crash test.
 *
 * The budget panel is deliberately absent until there is a result to improve:
 * spending money is the second question, and showing it first invites people
 * to answer it before they know what the problem is.
 */
export default function AdjustModal({
  meta, sel, onChange, onRun, onClose, cachedOnly, onOpenLab,
}: {
  meta: Meta;
  sel: Selection;
  onChange: (p: Partial<Selection>) => void;
  onRun: () => void;
  onClose: () => void;
  cachedOnly: boolean;
  onOpenLab: () => void;
}) {
  const [text, setText] = useState(formatBudget(sel.budget));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const commit = (): number | null => {
    const { usd, error: err } = parseBudget(text);
    if (usd === null) { setError(err); return null; }
    if (cachedOnly && !meta.budgets.includes(usd)) {
      setError("Cached mode answers the preset budgets only");
      return null;
    }
    setError(null);
    setText(formatBudget(usd));
    onChange({ budget: usd });
    return usd;
  };

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 grid place-items-center
      bg-slate-900/25 backdrop-blur-[2px]" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[440px] rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-[20px] font-bold tracking-tight">Build the plan</h2>
          <button onClick={onClose}
            className="text-[13px] text-slate-400 hover:text-slate-700">Close</button>
        </div>

        <label className="mt-4 block text-[12px] uppercase tracking-wider text-slate-500">
          Budget
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            aria-label="Adapt budget in US dollars"
            className={`w-40 rounded-lg border px-3 py-2 text-[18px] tabular-nums
              outline-none focus:ring-2 ${error
                ? "border-red-400 focus:ring-red-200"
                : "border-slate-300 focus:ring-slate-300"}`}
          />
          <div className="flex flex-wrap gap-1 self-center">
            {meta.budgets.map((b) => (
              <button key={b}
                onClick={() => { setText(formatBudget(b)); setError(null); onChange({ budget: b }); }}
                className={`rounded px-2 py-1 text-[12px] ${
                  b === sel.budget ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"}`}
              >{formatBudget(b)}</button>
            ))}
          </div>
        </div>
        {error && <p className="mt-1 text-[12px] text-red-600">{error}</p>}
        <p className="mt-1 text-[12px] text-slate-500">
          Any amount — &ldquo;$250K&rdquo;, &ldquo;250,000&rdquo; and
          &ldquo;0.25M&rdquo; all mean the same thing.
        </p>

        <label className="mt-5 block text-[12px] uppercase tracking-wider text-slate-500">
          Allocation policy
        </label>
        <div className="mt-1.5 space-y-2">
          {([
            ["balanced_protection", "Balanced Protection",
              "One shaded shelter at the worst unsheltered stop on each hero corridor, then spend the rest by marginal benefit."],
            ["pure_efficiency", "Pure marginal efficiency",
              "Spend every dollar on whatever avoids the most severe minutes. Buys no shelters at this hour."],
          ] as const).map(([key, label, blurb]) => (
            <button key={key}
              onClick={() => onChange({ policy: key })}
              className={`w-full rounded-xl border p-3 text-left transition ${
                sel.policy === key
                  ? "border-slate-900 bg-slate-50"
                  : "border-slate-200 hover:border-slate-400"}`}
            >
              <div className="text-[14px] font-semibold text-slate-900">{label}</div>
              <div className="text-[12px] leading-snug text-slate-600">{blurb}</div>
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          A policy choice, not an unconstrained discovery — waiting is a small
          share of exposure, so pure efficiency never protects a waiting rider.
        </p>

        {/* The two built-ins are the demo. A custom solution is a Beta side
            door: it never blocks, and never changes, the main loop. */}
        <button
          onClick={onOpenLab}
          className="mt-4 w-full rounded-xl border border-violet-200
            bg-violet-50 px-3 py-2 text-left transition hover:border-violet-400"
        >
          <span className="text-[13px] font-semibold text-violet-900">
            Add a solution
            <span className="ml-1.5 rounded bg-violet-200 px-1 py-0.5
              text-[9px] font-bold uppercase tracking-wide text-violet-900">
              Beta
            </span>
          </span>
          <span className="block text-[11.5px] leading-snug text-violet-900/70">
            Research a measure with Gemini, then let the engine decide whether
            it can honestly be simulated.
          </span>
        </button>

        <button
          onClick={() => { if (commit() !== null) onRun(); }}
          className="mt-5 w-full rounded-xl bg-emerald-700 py-3 text-[15px]
            font-bold uppercase tracking-wide text-white hover:bg-emerald-800"
        >
          Build the plan
        </button>
      </div>
    </div>
  );
}
