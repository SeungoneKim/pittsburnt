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
        <h1 className="text-[24px] font-extrabold leading-none tracking-tight">
          MEET <span className="text-red-600">PITTSBURNT</span>
        </h1>
        <p className="mt-1 text-[12px] uppercase tracking-[0.16em] text-slate-400">
          A crash test for cities
        </p>
      </header>

      <div className="max-h-[calc(100dvh-300px)] overflow-y-auto px-5 pb-5">
        <Section icon="⏱" title="Time" help="time" onHelp={onOpenSources}>
          <Drop
            value={sel.hour}
            placeholder="Choose a time"
            options={meta.hours.map((h) => ({ key: h, label: HOUR_LABEL[h] }))}
            onSelect={(hour) => onChange({ hour })}
            disabled={locked}
          />
        </Section>

        <Section icon="👥" title="Who" help="personas" onHelp={onOpenSources}>
          <Drop
            value={sel.persona}
            placeholder="Choose a population"
            options={meta.personas.map((p) => ({ key: p.key, label: p.label }))}
            onSelect={(persona) => onChange({ persona })}
            disabled={locked}
          />
        </Section>

        <Section icon="📈" title="Future scenario" help="climate" onHelp={onOpenSources}>
          <Drop
            value={sel.scenario}
            placeholder="Choose a scenario"
            options={meta.scenarios.map((s) => ({ key: s.key, label: s.label }))}
            onSelect={(scenario) => onChange({ scenario })}
            disabled={locked}
          />
        </Section>

        <Section icon="🍃" title="Existing protection" help="protection"
          onHelp={onOpenSources}>
          <div className="flex flex-wrap gap-1.5">
            {([
              ["trees", "Tree Inventory", "🌳"],
              ["canopy", "Canopy Coverage", "🌲"],
              ["shadow", "Building Shade", "🏢"],
              ["agents", "Moving People", "🚶"],
              ["trips", "Walking Routes", "🗺"],
            ] as const).map(([key, label, icon]) => (
              <button
                key={key}
                onClick={() => onLayers({ [key]: !layers[key] })}
                aria-pressed={layers[key]}
                className={`flex items-center gap-1.5 rounded-full border px-3
                  py-1.5 text-[12.5px] transition ${
                    layers[key]
                      ? "border-emerald-300 bg-emerald-50 font-medium text-emerald-900"
                      : "border-slate-200 bg-white text-slate-500 hover:border-slate-400"
                  }`}
              >
                <span aria-hidden>{icon}</span>{label}
              </button>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ icon, title, help, onHelp, children }: {
  icon: string; title: string; help: string;
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
        <span aria-hidden className="text-[14px]">{icon}</span>
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em]
          text-slate-500">{title}</h2>
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

/**
 * A large native select. Native is deliberate: it is keyboard- and
 * screen-reader-correct for free, and at this size it reads from across a
 * room without a custom listbox to maintain.
 */
function Drop<T extends string | number>({
  value, options, onSelect, disabled, placeholder,
}: {
  value: T | null;
  options: { key: T; label: string }[];
  onSelect: (v: T) => void;
  disabled: boolean;
  placeholder: string;
}) {
  const numeric = typeof options[0]?.key === "number";
  return (
    <div className="relative">
      <select
        disabled={disabled}
        value={value === null ? "" : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") return;
          onSelect((numeric ? Number(v) : v) as T);
        }}
        className={`w-full appearance-none rounded-xl border px-3.5 py-3
          pr-10 text-[17px] font-semibold transition
          disabled:cursor-not-allowed disabled:opacity-60 ${
            value === null
              ? "border-slate-200 bg-slate-50 text-slate-400"
              : "border-slate-300 bg-white text-slate-900"
          }`}
      >
        <option value="" disabled>{placeholder}</option>
        {options.map((o) => (
          <option key={String(o.key)} value={String(o.key)}>{o.label}</option>
        ))}
      </select>
      <span aria-hidden
        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2
          text-[13px] text-slate-400">
        ▾
      </span>
    </div>
  );
}
