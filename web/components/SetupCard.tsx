"use client";

import { useState } from "react";

import type { Hour, Meta, Selection } from "@/lib/types";

const HOUR_LABEL: Record<number, string> = {
  8: "8 AM", 12: "12 PM", 15: "3 PM", 18: "6 PM",
};

export interface Layers {
  shadow: boolean; canopy: boolean; trees: boolean;
  buildings: boolean; trips: boolean; agents: boolean;
}

interface Props {
  meta: Meta;
  sel: Selection;
  onChange: (p: Partial<Selection>) => void;
  layers: Layers;
  onLayers: (p: Partial<Layers>) => void;
  locked: boolean;
  onOpenSources: (key?: string) => void;
}

/**
 * The setup card: the three choices that define a question, plus the
 * protection layers already on the ground.
 *
 * Everything explanatory has moved to Sources. What stays here is what a
 * person has to touch, at a size that reads from across a room.
 */
export default function SetupCard({
  meta, sel, onChange, layers, onLayers, locked, onOpenSources,
}: Props) {
  return (
    <div className="pointer-events-auto w-[376px] overflow-hidden rounded-2xl
      border border-slate-200/80 bg-white/95 shadow-xl shadow-slate-900/5
      backdrop-blur">
      <header className="px-5 pb-3 pt-4">
        <h1 className="text-[22px] font-bold leading-none tracking-tight">
          MEET <span className="text-red-600">PITTSBURNT</span>
        </h1>
        <p className="mt-1 text-[12px] uppercase tracking-[0.14em] text-blue-700">
          A crash test for cities
        </p>
      </header>

      <div className="max-h-[calc(100dvh-300px)] overflow-y-auto px-5 pb-5">
        <Section n={1} title="Time" help="time" onHelp={onOpenSources}>
          <Pills
            value={sel.hour}
            options={meta.hours.map((h) => ({ key: h, label: HOUR_LABEL[h] }))}
            onSelect={(hour) => onChange({ hour })}
            disabled={locked}
          />
        </Section>

        <Section n={2} title="Who is walking" help="personas" onHelp={onOpenSources}>
          <Pills
            value={sel.persona}
            options={meta.personas.map((p) => ({ key: p.key, label: p.label }))}
            onSelect={(persona) => onChange({ persona })}
            disabled={locked}
          />
        </Section>

        <Section n={3} title="Climate scenario" help="climate" onHelp={onOpenSources}>
          <Pills
            value={sel.scenario}
            options={meta.scenarios.map((s) => ({ key: s.key, label: s.label }))}
            onSelect={(scenario) => onChange({ scenario })}
            disabled={locked}
          />
        </Section>

        <Section n={4} title="Existing protection" help="protection" onHelp={onOpenSources}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {([
              ["canopy", "Existing Canopy Coverage"],
              ["trees", "Existing Tree Inventory"],
              ["shadow", "Building shade"],
              ["buildings", "Buildings"],
              ["agents", "Moving People"],
              ["trips", "Walking routes"],
            ] as const).map(([key, label]) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 text-[13px]
                  leading-tight text-slate-700"
              >
                <input
                  type="checkbox"
                  checked={layers[key]}
                  onChange={(e) => onLayers({ [key]: e.target.checked })}
                  className="h-4 w-4 shrink-0 accent-slate-900"
                />
                {label}
              </label>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ n, title, help, onHelp, children }: {
  n: number; title: string; help: string;
  onHelp: (k?: string) => void; children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <section
      className="border-t border-slate-100 py-3 first:border-0 first:pt-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-5 w-5 place-items-center rounded-md bg-slate-900
          text-[11px] font-semibold text-white">
          {n}
        </span>
        <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
        {/* Help appears on hover or focus, so it is discoverable without
            occupying the resting surface. */}
        <button
          onClick={() => onHelp(help)}
          className={`ml-auto text-[11px] underline decoration-dotted
            underline-offset-2 transition ${
              hover ? "text-slate-500 opacity-100" : "text-slate-400 opacity-0"
            } focus:opacity-100`}
        >
          how this works
        </button>
      </div>
      {children}
    </section>
  );
}

function Pills<T extends string | number>({ value, options, onSelect, disabled }: {
  value: T | null;
  options: { key: T; label: string }[];
  onSelect: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={String(o.key)}
            disabled={disabled}
            onClick={() => onSelect(o.key)}
            className={`rounded-lg border px-3 py-2 text-[13px] transition
              disabled:cursor-not-allowed disabled:opacity-50 ${
                on
                  ? "border-slate-900 bg-slate-900 font-semibold text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-slate-500 hover:bg-slate-50"
              }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
