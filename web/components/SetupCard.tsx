"use client";

import { useState } from "react";

import Panel from "@/components/Panel";
import type { Meta, Selection } from "@/lib/types";

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
  /** Moving People cannot render before we know who is walking, and when. */
  peopleReady: boolean;
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
  meta, sel, onChange, layers, onLayers, locked, onOpenSources, peopleReady,
}: Props) {
  return (
    <Panel title="Set up the test" icon="🔧" width={292}>
      <header className="px-4 pb-2 pt-1">
        <h1 className="text-[23px] font-extrabold leading-none tracking-tight">
          MEET <span className="text-red-600">PITTSBURNT</span>
        </h1>
        <p className="mt-1 text-[11.5px] uppercase tracking-[0.16em] text-slate-400">
          A crash test for cities
        </p>
      </header>

      {/* Internal scrolling only, and only when the viewport is short: the
          panel never grows past the window and never clips at 1366x768. */}
      {/* Existing protection leads: turning on Trees, Canopy or Building
          Shade is a satisfying map reveal, and it is the one thing a person
          can do before answering any question.

          The height is sized so all three selectors fit without scrolling at
          1366x768 - the demo's worst case. Moving this section to the top
          made the card taller, and at 292px wide the long pill labels each
          took a whole row, which pushed Future Scenario below the fold. */}
      <div className="max-h-[calc(100dvh-190px)] overflow-y-auto px-4 pb-4">
        <Section icon="🍃" title="Existing protection" help="protection"
          onHelp={onOpenSources}>
          <div className="grid grid-cols-2 gap-1.5">
            {([
              ["trees", "Tree Inventory", "🌳"],
              ["canopy", "Canopy Cover", "🌲"],
              ["shadow", "Building Shade", "🏢"],
              ["agents", "Moving People", "🚶"],
              ["trips", "Walking Routes", "🗺"],
            ] as const).map(([key, label, icon]) => {
              const blocked = key === "agents" && !peopleReady;
              return (
                <button
                  key={key}
                  onClick={() => onLayers({ [key]: !layers[key] })}
                  aria-pressed={layers[key]}
                  disabled={blocked}
                  title={blocked ? "Choose Who and Time first" : undefined}
                  className={`flex items-center gap-1 overflow-hidden rounded-full
                    border px-2.5 py-1.5 text-[11.5px] whitespace-nowrap transition ${
                      blocked
                        ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-300"
                        : layers[key]
                          ? "border-emerald-300 bg-emerald-50 font-medium text-emerald-900"
                          : "border-slate-200 bg-white text-slate-500 hover:border-slate-400"
                    }`}
                >
                  <span aria-hidden>{icon}</span>{label}
                </button>
              );
            })}
          </div>
          {!peopleReady && (
            <p className="mt-1.5 text-[11.5px] text-slate-400">
              Choose Who and Time first to see people moving.
            </p>
          )}
        </Section>

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

      </div>
    </Panel>
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
        <h2 className="shrink-0 whitespace-nowrap text-[12.5px] font-semibold
          uppercase tracking-[0.07em] text-slate-500">{title}</h2>
        {/* Help appears on hover or focus, so it is discoverable without
            occupying the resting surface. */}
        <button
          onClick={() => onHelp(help)}
          className={`ml-auto min-w-0 truncate text-[11px] underline decoration-dotted
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
          pr-10 text-[16.5px] font-semibold transition
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
