"use client";

import type { DayHour, Hour } from "@/lib/types";

const LABEL: Record<number, string> = { 8: "8 AM", 12: "12 PM", 15: "3 PM", 18: "6 PM" };

/**
 * The day's shape, not just the selected hour.
 *
 * Two thirds of scenario-hour combinations legitimately produce zero severe
 * minutes, and a bare 0 reads as a broken product rather than as the finding
 * it is. Showing when the day does and does not cross the threshold makes a
 * zero legible — "not at this hour, and here is how close" — and doubles as
 * the hour control.
 */
export default function DayProfile({ profile, hour, threshold, onPick }: {
  profile: DayHour[];
  hour: Hour;
  threshold: number;
  onPick: (h: Hour) => void;
}) {
  if (!profile?.length) return null;
  const peak = Math.max(...profile.map((d) => d.severe), 1);
  const anyCrosses = profile.some((d) => d.crosses);

  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        Across the day
      </div>
      <div className="flex gap-1">
        {profile.map((d) => {
          const selected = d.hour === hour;
          const h = d.severe > 0 ? Math.max(8, (d.severe / peak) * 42) : 3;
          return (
            <button
              key={d.hour}
              onClick={() => onPick(d.hour as Hour)}
              title={d.crosses
                ? `${Math.round(d.severe).toLocaleString()} severe person-minutes · `
                  + `UTCI ${d.utci_sun_c.toFixed(1)} °C in sun`
                : `Nobody crosses ${threshold} °C · peak UTCI `
                  + `${d.utci_sun_c.toFixed(1)} °C, ${Math.abs(d.headroom_c).toFixed(1)} °C below`}
              className={`flex-1 rounded-md border px-1 pb-1 pt-1.5 transition ${
                selected
                  ? "border-slate-900 bg-slate-50"
                  : "border-slate-200 hover:border-slate-400"
              }`}
            >
              <div className="flex h-[46px] items-end justify-center">
                <div
                  className={`w-full rounded-sm ${
                    d.crosses ? "bg-red-600" : "bg-slate-300"
                  }`}
                  style={{ height: `${h}px` }}
                />
              </div>
              <div className={`mt-1 text-[10px] ${
                selected ? "font-semibold text-slate-900" : "text-slate-500"}`}>
                {LABEL[d.hour] ?? `${d.hour}h`}
              </div>
              <div className="text-[9px] tabular-nums text-slate-500">
                {d.crosses
                  ? Math.round(d.severe).toLocaleString()
                  : `${d.headroom_c.toFixed(1)}°`}
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-slate-500">
        {anyCrosses
          ? `Red hours cross ${threshold} °C. Grey hours show how far below it they sit.`
          : `No hour crosses ${threshold} °C in this scenario — the figures are `
            + `degrees of headroom before it would.`}
      </p>
    </div>
  );
}
