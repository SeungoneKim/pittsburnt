"use client";

import { useState } from "react";

import { GUTTER, RESULT_W, SETUP_W } from "@/lib/zones";
import type { AdaptResult, Meta } from "@/lib/types";

interface Props {
  headline: string | null;
  detail: string | null;
  progress: number;
  running: boolean;
  onSkip: () => void;
  onReplay: () => void;
  canReplay: boolean;
  /** Live spend during the Adjust choreography, if one is running. */
  budget?: { spent: number; total: number; counts: Record<string, number> } | null;
  meta: Meta;
  adapted?: AdaptResult | null;
}

const fmt = (n: number) => Math.round(n).toLocaleString();

export default function StageOverlay({
  headline, detail, progress, running, onSkip, onReplay, canReplay,
  budget, meta, adapted,
}: Props) {
  const [open, setOpen] = useState(true);
  if (!headline && !canReplay) return null;

  // Minimized, it is a pill in the same reserved strip - the spec's rule is
  // that every persistent surface can get out of the way of the map, and
  // this was the only one that could not.
  if (!open) {
    return (
      <div className="pointer-events-none absolute top-4 z-10 flex justify-center"
        style={{ left: GUTTER + SETUP_W + GUTTER,
          right: GUTTER + RESULT_W + GUTTER }}>
        <button onClick={() => setOpen(true)}
          aria-label="Restore Plan complete"
          className="pointer-events-auto rounded-full border border-slate-200
            bg-white/95 px-3.5 py-1.5 text-[12.5px] font-semibold text-slate-700
            shadow-lg backdrop-blur hover:bg-white">
          {headline ?? "Plan"} · restore
        </button>
      </div>
    );
  }

  return (
    // Inside the centre safe zone: left of the result panel, right of the
    // setup panel, so at 1366x768 the three bounding boxes cannot intersect.
    <div className="pointer-events-none absolute top-4 z-10 mx-auto
      max-w-[460px]"
      style={{ left: GUTTER + SETUP_W + GUTTER,
        right: GUTTER + RESULT_W + GUTTER }}>
      {headline && (
        <div data-panel="Stage"
          className="rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              {/* One large headline, readable from projection distance. */}
              <div className="text-lg font-bold tracking-tight text-slate-900">
                {headline}
              </div>
              {detail && (
                <div className="text-xs text-slate-600">{detail}</div>
              )}
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Minimize Plan complete"
              title="Minimize"
              className="pointer-events-auto order-last shrink-0 grid h-6 w-6
                place-items-center rounded-md text-[15px] leading-none
                text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              −
            </button>
            {running && (
              <button
                onClick={onSkip}
                className="pointer-events-auto shrink-0 rounded-md border border-slate-300
                  px-2.5 py-1 text-[11px] text-slate-600 transition hover:bg-slate-50"
              >
                Skip
              </button>
            )}
            {!running && canReplay && (
              <button
                onClick={onReplay}
                className="pointer-events-auto shrink-0 rounded-md border border-slate-300
                  px-2.5 py-1 text-[11px] text-slate-600 transition hover:bg-slate-50"
              >
                Replay
              </button>
            )}
          </div>

          <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-slate-800 transition-[width] duration-100"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>

          {/* Persistent spend bar during ADAPT, per the spec. */}
          {budget && (
            <div className="mt-2.5 border-t border-slate-200 pt-2">
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-slate-600">
                  Spent{" "}
                  <b className="tabular-nums text-slate-900">
                    ${fmt(budget.spent)}
                  </b>{" "}
                  of ${fmt(budget.total)}
                </span>
                <span className="tabular-nums text-slate-600">
                  {Object.entries(budget.counts)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) =>
                      `${n} ${meta.interventions[k]?.label.toLowerCase() ?? k}`)
                    .join(" · ") || "nothing placed yet"}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-emerald-600"
                  style={{
                    width: `${Math.min(100, (budget.spent / budget.total) * 100)}%`,
                  }}
                />
              </div>
              {/* The spec: if zero of a type were bought, say why. This
                  explains the GREEDY objective, so it must not appear over a
                  stated program - that plan bought what its own constraints
                  asked for, and the solver reports its own reasons. */}
              {adapted && !running && adapted.counts.shaded_shelter === 0
                && adapted.policy !== "stated_program" && (
                <p className="mt-1 text-[10px] leading-snug text-slate-500">
                  No shelters selected: a tree removes more severe minutes per
                  dollar here, because waiting is{" "}
                  {Math.round(
                    (adapted.before_waiting_severe
                      / Math.max(adapted.before_severe, 1)) * 100,
                  )}
                  % of exposure at this hour.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
