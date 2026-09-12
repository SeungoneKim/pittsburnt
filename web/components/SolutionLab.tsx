"use client";

import { useEffect, useState } from "react";

import type { Selection } from "@/lib/types";

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

interface SimResult {
  custom: { key: string; label: string; cost_usd: number; shade_m: number };
  counts: Record<string, number>;
  spent_usd: number;
  before_severe: number;
  after_severe: number;
  before_experienced_utci_c: number;
  after_experienced_utci_c: number;
  reduction_pct: number;
  rank_trace?: { unbought?: { kind: string; reason: string }[] };
}

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
export default function SolutionLab({ sel, onClose }: {
  sel: Selection; onClose: () => void;
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
      setSim(await r.json());
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
            <div className="rounded-xl border-l-4 border-emerald-500
              bg-emerald-50 p-3">
              <h3 className="text-[14px] font-semibold text-emerald-900">
                {sim.custom.label} priced against the built-ins
              </h3>
              <div className="mt-1 space-y-0.5 text-[12px] text-emerald-900/85">
                {Object.entries(sim.counts).map(([k, n]) => (
                  <div key={k} className="flex justify-between">
                    <span>{k.replace(/_/g, " ")}</span>
                    <span className="tabular-nums font-semibold">{n}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t
                  border-emerald-200 pt-0.5">
                  <span>Severe exposure</span>
                  <span className="tabular-nums font-semibold">
                    {Math.round(sim.before_severe)} →{" "}
                    {Math.round(sim.after_severe)} ({sim.reduction_pct}%)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Experienced UTCI</span>
                  <span className="tabular-nums font-semibold">
                    {sim.before_experienced_utci_c.toFixed(2)} →{" "}
                    {sim.after_experienced_utci_c.toFixed(2)} °C
                  </span>
                </div>
              </div>
              {sim.rank_trace?.unbought?.map((u) => (
                <p key={u.kind} className="mt-1.5 text-[11px] leading-snug
                  text-emerald-900/70">{u.reason}</p>
              ))}
              <p className="mt-1.5 text-[11px] text-emerald-900/70">
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
