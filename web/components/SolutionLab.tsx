"use client";

import { useEffect, useState } from "react";

import type { AdaptResult, Selection, SolutionComparison } from "@/lib/types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface Verdict {
  can_simulate: boolean;
  status: string;
  reasons: string[];
  missing: string[];
  questions: string[];
  mechanism_note: string;
}

interface Draft {
  name: string;
  mechanism: string;
  geometry?: string;
  eligibleSite?: string;
  unitCost?: { capexUsd?: number; annualOpexUsd?: number; sourceStatus?: string };
  effect?: { parameter: string; value: number; unit: string; sourceStatus: string }[];
  confidence?: string;
  openQuestions?: string[];
}

interface Provider {
  configured: boolean;
  base_url: string;
  model: string;
  /** True only if the provider can retrieve and cite live sources. */
  grounded: boolean;
}

interface ChatReply {
  mode: "live" | "cached";
  reason?: string;
  provider?: Provider;
  draft?: Draft;
  verdict?: Verdict;
  /** Claims the model called "sourced" that were downgraded server-side. */
  downgraded?: string[];
  examples?: { draft: Draft; verdict: Verdict }[];
}

/** The plan the engine built, in the shape the map already renders. */
type SimResult = AdaptResult & {
  custom: { key: string; label: string; cost_usd: number; shade_m: number };
  comparison: SolutionComparison;
  segments: { severe_minutes: number; heat_load: number }[];
};

const STATUS_COPY: Record<string, { label: string; cls: string }> = {
  can_simulate: { label: "Can simulate", cls: "bg-emerald-100 text-emerald-900" },
  cannot_simulate: { label: "Evidence missing", cls: "bg-amber-100 text-amber-900" },
  guarded: { label: "Needs measured Tmrt", cls: "bg-amber-100 text-amber-900" },
  new_adapter: { label: "No adapter in this build", cls: "bg-slate-200 text-slate-700" },
  access_only: { label: "Access benefit, not thermal", cls: "bg-sky-100 text-sky-900" },
  unknown_mechanism: { label: "Unknown mechanism", cls: "bg-red-100 text-red-900" },
};

/**
 * Add New Solution (Beta).
 *
 * The point of this panel is the refusals. A language model drafts a proposed
 * measure into typed fields; a deterministic gate then decides whether this
 * engine can honestly represent that physics, and says exactly which evidence
 * is missing when it cannot. Only a draft that clears the gate, and that a
 * person confirms, reaches the optimiser - and every placement and impact
 * number in the result is the engine's, not the model's.
 *
 * The provider has no retrieval tool, so any figure the model calls "sourced"
 * is downgraded to an assumption before it is shown. That downgrade happens
 * on the server, and this panel says when it happened.
 *
 * It degrades on purpose: with no key or no network it returns cached example
 * drafts, so the core Crash -> Adjust -> Re-test loop is never at risk.
 */
export default function SolutionLab({ sel, onPlan, onClose }: {
  sel: Selection;
  /** Hand the confirmed plan to the map, exactly like any other plan. */
  onPlan: (p: AdaptResult) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ChatReply | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [sim, setSim] = useState<SimResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  useEffect(() => {
    fetch(`${API}/solutions/mechanisms`)
      .then((r) => r.json())
      .then((d) => {
        setProvider(d.provider ?? null);
        setReply({
          mode: "cached",
          reason: d.configured
            ? "Describe a measure to draft it, or start from an example below."
            : "No model is configured here — these are the cached examples.",
          examples: d.examples,
        });
      })
      .catch(() => setError("The engine is not reachable, so Beta is offline."));
  }, []);

  const ask = async () => {
    if (!text.trim()) return;
    setBusy(true); setError(null); setSim(null);
    try {
      const r = await fetch(`${API}/solutions/chat`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d: ChatReply = await r.json();
      if (d.provider) setProvider(d.provider);
      setReply(d);
      // Better questions arrive separately. The gate's own are already on
      // screen by now; folding this into the draft request took a 7 s answer
      // to 39 s, so it improves the panel rather than delaying it.
      if (d.mode === "live" && d.draft && d.verdict && !d.verdict.can_simulate
          && d.verdict.missing.length) {
        const draft = d.draft;
        fetch(`${API}/solutions/clarify`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, draft }),
        })
          .then((q) => q.json())
          .then((q: { questions?: string[] }) => {
            if (!q.questions?.length) return;
            setReply((prev) => (prev?.draft === draft && prev.verdict
              ? { ...prev, verdict: { ...prev.verdict, questions: q.questions! } }
              : prev));
          })
          .catch(() => { /* the gate's questions stand */ });
      }
    } catch {
      setError("Research is unavailable; the cached examples still work.");
    } finally { setBusy(false); }
  };

  const simulate = async (draft: Draft) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${API}/solutions/simulate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scenario: sel.scenario, hour: sel.hour, persona: sel.persona,
          budget_usd: sel.budget, policy: sel.policy, draft,
        }),
      });
      if (!r.ok) { setError((await r.json()).detail ?? "refused"); return; }
      const plan = (await r.json()) as SimResult;
      setSim(plan);
      // Same derivations every other plan gets, so the map, the choreography
      // and the result card render a custom solution without special cases.
      const useSevere = plan.metric_used === "severe_person_minutes";
      const tally = new Map<string, { seg_id: string; kind: string; count: number }>();
      for (const q of plan.placements as unknown as { seg_id: string; kind: string }[]) {
        const k = `${q.seg_id}|${q.kind}`;
        const cur = tally.get(k);
        if (cur) cur.count += 1; else tally.set(k, { ...q, count: 1 });
      }
      onPlan({
        ...plan,
        metric_values: plan.segments.map(
          (x) => (useSevere ? x.severe_minutes : x.heat_load)),
        placements: [...tally.values()],
      });
    } catch {
      setError("The engine is not reachable.");
    } finally { setBusy(false); }
  };

  const cards = reply?.draft
    ? [{ draft: reply.draft, verdict: reply.verdict as Verdict }]
    : (reply?.examples ?? []);

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex justify-end
      bg-slate-900/25 backdrop-blur-[2px]" onClick={onClose}>
      <aside onClick={(e) => e.stopPropagation()}
        className="h-full w-[520px] overflow-y-auto bg-white shadow-2xl">
        <header className="sticky top-0 z-10 flex items-baseline gap-2
          border-b border-slate-200 bg-white/95 px-6 py-4 backdrop-blur">
          <h2 className="text-[20px] font-bold tracking-tight">Add a solution</h2>
          <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px]
            font-bold uppercase tracking-wide text-violet-800">Beta</span>
          <button onClick={onClose}
            className="ml-auto text-[13px] text-slate-500 hover:text-slate-900">
            Close
          </button>
        </header>

        <div className="space-y-4 px-6 py-5 text-[13px] leading-relaxed">
          <p className="rounded-xl border-l-4 border-violet-400 bg-violet-50 p-3
            text-violet-900/85">
            A language model drafts your measure into typed fields and asks for
            what it could not fill in. It never invents an effect, picks a
            location or commits a cost. A deterministic gate then decides
            whether this engine can honestly represent that physics — and the
            refusals below are the point, not a failure.
          </p>

          {provider && (
            <p className="text-[11.5px] leading-snug text-slate-500">
              {provider.configured
                ? <>Drafting with <b className="font-semibold text-slate-700">
                  {provider.model}</b>. </>
                : "No model configured. "}
              {!provider.grounded && (
                <>This provider has no retrieval tool, so it answers from its
                  weights. Any figure it calls <i>sourced</i> is downgraded to
                  an assumption before you see it — a recalled number is a
                  suggestion, not a citation.</>
              )}
            </p>
          )}

          <div>
            <label className="block text-[12px] uppercase tracking-wider
              text-slate-500" htmlFor="sol">Describe a measure</label>
            <textarea id="sol" rows={2} value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Add misted rest shelters near busy stops."
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3
                py-2 text-[14px] outline-none focus:ring-2 focus:ring-violet-300" />
            <button onClick={ask} disabled={busy || !text.trim()}
              className="mt-2 rounded-lg bg-violet-700 px-4 py-2 text-[13px]
                font-bold uppercase tracking-wide text-white
                disabled:bg-slate-300">
              {busy ? "Drafting…" : "Draft it"}
            </button>
          </div>

          {reply?.reason && (
            <p className="text-[12px] text-slate-500">{reply.reason}</p>
          )}
          {error && (
            <p className="rounded-lg bg-red-50 p-2 text-[12px] text-red-800">
              {error}
            </p>
          )}

          {reply?.downgraded?.length ? (
            <p className="rounded-lg bg-amber-50 p-2 text-[12px] text-amber-900">
              The model claimed a source for{" "}
              <b>{reply.downgraded.join(", ")}</b>, but nothing was retrieved
              to check it against. Shown as an assumption for you to confirm
              or replace.
            </p>
          ) : null}

          {cards.map(({ draft, verdict }) => {
            const st = STATUS_COPY[verdict.status]
              ?? { label: verdict.status, cls: "bg-slate-100 text-slate-700" };
            return (
              <div key={draft.name}
                className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-[14px] font-semibold text-slate-900">
                    {draft.name}
                  </h3>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold
                    uppercase tracking-wide ${st.cls}`}>{st.label}</span>
                </div>
                <p className="text-[11.5px] text-slate-500">
                  {draft.mechanism.replace(/_/g, " ")}
                  {draft.unitCost?.capexUsd
                    ? ` · $${draft.unitCost.capexUsd.toLocaleString()} per unit`
                    : ""}
                </p>

                {draft.effect?.length ? (
                  <ul className="mt-1.5 space-y-0.5">
                    {draft.effect.map((e) => (
                      <li key={e.parameter}
                        className="flex justify-between gap-2 text-[12px]">
                        <span className="text-slate-600">
                          {e.parameter.replace(/_/g, " ")}
                        </span>
                        <span className="tabular-nums text-slate-900">
                          {e.value} {e.unit}
                          <em className={`ml-1.5 not-italic text-[10px]
                            font-semibold uppercase ${
                              e.sourceStatus === "sourced" ? "text-sky-700"
                                : e.sourceStatus === "user_assumption"
                                  ? "text-amber-700" : "text-red-700"}`}>
                            {e.sourceStatus === "sourced" ? "sou"
                              : e.sourceStatus === "user_assumption" ? "ass" : "uns"}
                          </em>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {verdict.reasons.map((r) => (
                  <p key={r} className="mt-1.5 text-[11.5px] leading-snug
                    text-slate-600">{r}</p>
                ))}
                {verdict.questions.length > 0 && (
                  <ul className="mt-1.5 list-disc pl-4 text-[11.5px] text-slate-600">
                    {verdict.questions.map((q) => <li key={q}>{q}</li>)}
                  </ul>
                )}

                {verdict.can_simulate && (
                  <button onClick={() => simulate(draft)} disabled={busy}
                    className="mt-2 rounded-lg bg-emerald-700 px-3 py-1.5
                      text-[12px] font-bold uppercase tracking-wide text-white
                      disabled:bg-slate-300">
                    Confirm these numbers and simulate
                  </button>
                )}
              </div>
            );
          })}

          {sim && (
            <div className="rounded-xl border-l-4 border-violet-500
              bg-violet-50 p-3">
              <h3 className="text-[14px] font-semibold text-violet-900">
                {sim.custom.label}, simulated two ways
              </h3>
              <p className="mt-0.5 text-[11.5px] text-violet-900/70">
                Same scenario, same budget, same people. The plan on its own
                is now drawn on the map behind this panel.
              </p>

              {/* On its own: what the measure does as the only option. */}
              <div className="mt-2 rounded-lg bg-white/70 p-2">
                <div className="text-[11px] font-semibold uppercase
                  tracking-wider text-violet-800">On its own</div>
                <Line k={`${sim.comparison.solo.units} units built`}
                  v={`$${Math.round(sim.comparison.solo.spent_usd).toLocaleString()}`} />
                <Line k="Severe exposure"
                  v={`${Math.round(sim.comparison.before_severe)} \u2192 `
                    + `${Math.round(sim.comparison.solo.after_severe)} `
                    + `(\u2212${sim.comparison.solo.reduction_pct}%)`} />
              </div>

              {/* Against the built-ins: usually the more interesting answer. */}
              <div className="mt-1.5 rounded-lg bg-white/70 p-2">
                <div className="text-[11px] font-semibold uppercase
                  tracking-wider text-violet-800">
                  Competing with trees and shelters
                </div>
                <Line k={`${sim.custom.label} bought`}
                  v={String(sim.comparison.mixed.custom_units)} />
                {Object.entries(sim.comparison.mixed.counts)
                  .filter(([k, n]) => n > 0 && k !== sim.custom.key)
                  .map(([k, n]) => (
                    <Line key={k} k={k.replace(/_/g, " ")} v={String(n)} />
                  ))}
                <Line k="Severe exposure"
                  v={`${Math.round(sim.comparison.before_severe)} \u2192 `
                    + `${Math.round(sim.comparison.mixed.after_severe)} `
                    + `(\u2212${sim.comparison.mixed.reduction_pct}%)`} />
              </div>

              {sim.comparison.unbought.map((u) => (
                <p key={u.kind} className="mt-1.5 text-[11px] leading-snug
                  text-violet-900/75">{u.reason}</p>
              ))}
              <p className="mt-1.5 text-[11px] text-violet-900/70">
                Every count, coordinate and impact number here was computed by
                the deterministic engine under the numbers you confirmed.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/** One labelled figure in the two-way comparison. */
function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2 text-[12px] text-violet-900/85">
      <span className="capitalize">{k}</span>
      <span className="shrink-0 tabular-nums font-semibold">{v}</span>
    </div>
  );
}
