"use client";

import { useState } from "react";

/**
 * A floating surface with Minimize and Restore.
 *
 * The map is the subject, so every panel over it has to be able to get out
 * of the way. Minimizing collapses the whole card to a labelled pill that
 * says what it is and restores on click - a panel that can only be closed
 * forces a person to rebuild state to see it again.
 *
 * `onClose` is optional and only appears on dismissible overlays: the setup
 * and result cards are the tool, not a notification, so they minimize rather
 * than disappear.
 */
export default function Panel({
  title, icon, width, children, onClose, defaultOpen = true, tone = "light",
}: {
  title: string;
  icon: string;
  width: number;
  children: React.ReactNode;
  onClose?: () => void;
  defaultOpen?: boolean;
  tone?: "light" | "result";
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label={`Restore ${title}`}
        className="pointer-events-auto flex items-center gap-2 rounded-full
          border border-slate-200 bg-white/95 py-2 pl-3 pr-4 text-[13px]
          font-semibold text-slate-700 shadow-lg backdrop-blur
          transition hover:bg-white"
      >
        <span aria-hidden className="text-[14px]">{icon}</span>
        {title}
        <span aria-hidden className="text-[11px] text-slate-400">restore</span>
      </button>
    );
  }

  return (
    <div
      style={{ width }}
      className={`pointer-events-auto overflow-hidden rounded-3xl border
        shadow-2xl shadow-slate-900/10 backdrop-blur-md ${tone === "result"
          ? "border-white/70 bg-white/92"
          : "border-slate-200/80 bg-white/95"}`}
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <span aria-hidden className="text-[13px]">{icon}</span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em]
          text-slate-400">{title}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setOpen(false)}
            aria-label={`Minimize ${title}`}
            title="Minimize"
            className="grid h-6 w-6 place-items-center rounded-md text-[15px]
              leading-none text-slate-400 transition hover:bg-slate-100
              hover:text-slate-700"
          >
            −
          </button>
          {onClose && (
            <button
              onClick={onClose}
              aria-label={`Close ${title}`}
              title="Close"
              className="grid h-6 w-6 place-items-center rounded-md text-[14px]
                leading-none text-slate-400 transition hover:bg-slate-100
                hover:text-slate-700"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
