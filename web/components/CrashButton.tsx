"use client";

/**
 * The primary action, centre-bottom, large enough to read from the back of a
 * room. It is the only call to action on screen: it is disabled until a
 * question exists, and after a crash test it morphs into ADJUST rather than
 * a second button appearing beside it.
 */
export default function CrashButton({ mode, missing, busy, onClick }: {
  mode: "crash" | "adjust";
  missing: string[];
  busy: boolean;
  onClick: () => void;
}) {
  const blocked = missing.length > 0;
  const label = busy
    ? "RUNNING"
    : blocked
      ? `CHOOSE ${missing.length} INPUT${missing.length > 1 ? "S" : ""}`
      : mode === "crash" ? "RUN CRASH TEST" : "ADJUST";

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-2">
      <button
        onClick={onClick}
        disabled={blocked || busy}
        aria-label={label}
        className={`grid h-[112px] w-[112px] place-items-center rounded-full
          text-center text-[13px] font-bold uppercase leading-tight tracking-wide
          text-white shadow-2xl transition
          ${blocked
            ? "cursor-not-allowed bg-slate-400/90"
            : busy
              ? "bg-red-500"
              : mode === "crash"
                ? "animate-[pulse_2.4s_ease-in-out_infinite] bg-red-600 hover:bg-red-700"
                : "bg-emerald-700 hover:bg-emerald-800"}`}
      >
        <span className="px-3">{label}</span>
      </button>
      {blocked && (
        <span className="rounded-full bg-white/95 px-3 py-1 text-[12px]
          text-slate-600 shadow">
          Pick {missing.join(", ")}
        </span>
      )}
    </div>
  );
}
