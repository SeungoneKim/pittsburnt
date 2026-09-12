/**
 * Stated optimisation programs.
 *
 * The 2.6 Adjust step asked two questions: how much money, and which of two
 * hard-coded policies. "Balanced Protection" was a for-loop that put one
 * shelter on each of three corridors named in the source, because pure
 * efficiency gives 57 of the 67 walked corridors nothing and we did not like
 * how that looked.
 *
 * This replaces the policy dropdown with a sentence. A language model
 * compiles that sentence into a typed program - an objective, the cells it
 * applies to, and a list of declarative constraints - and a MILP solves the
 * program exactly. The model never places a unit, prices anything or scores a
 * plan; it only decides what question to ask. The solver decides the answer,
 * and reports how far from optimal it is.
 */
import type { AdaptResult } from "./types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface Cell {
  scenario: string; hour: number; persona: string; weight?: number;
}

export type Scope = { corridor?: string; corridors?: string[] }
  | string | string[];

export interface Constraint {
  type: "corridor_floor" | "spend_cap" | "spend_floor" | "focus"
    | "kind_floor" | "kind_cap";
  scope?: Scope;
  weight?: number;
  kind?: string;
  min_units?: number;
  max_units?: number;
  max_fraction?: number;
  min_fraction?: number;
}

/** Every corridor a scope names, in the order the program stated them. */
function scopeNames(scope: Scope | undefined): string[] {
  if (!scope) return [];
  if (typeof scope === "string") return [scope];
  if (Array.isArray(scope)) return scope.flatMap(scopeNames);
  return [...(scope.corridor ? [scope.corridor] : []),
    ...(scope.corridors ?? [])];
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface ProgramSpec {
  objective: "min_heat_load" | "min_severe";
  budget_usd: number;
  cells: Cell[];
  constraints: Constraint[];
  restated?: string;
  unsupported?: string[];
}

export interface CompileReply {
  spec: ProgramSpec;
  repaired: boolean;
  restated: string | null;
  unsupported: string[];
  verdict: {
    ok: boolean; reasons: string[]; missing: string[]; questions: string[];
    /** Short street names the engine expanded, and why. */
    resolved: { wrote: string; meant: string; why: string }[];
    /** Real corridors an ambiguous reference could have meant. */
    candidates: string[];
  };
  /** How the program checked out against the sentence it came from. */
  audit: { kind: string; chose: string; candidates: string[]; message: string }[];
}

/** What the solver did, and how sure it is. */
export interface SolverInfo {
  backend: string;
  variables: number;
  constraints: number;
  integer_variables: number;
  mip_gap: number | null;
  objective: string;
  certificate: string;
}

/** What became of one stated constraint. The slack ones matter as much. */
export interface ConstraintOutcome {
  type: string;
  status?: string;
  note?: string;
  scope?: string[];
  used_usd?: number;
  limit_usd?: number;
  corridors?: number;
  skipped?: string[];
  floor_cost_usd?: number;
}

export interface ProgramResult extends AdaptResult {
  spec: ProgramSpec;
  solver: SolverInfo;
  constraint_report: ConstraintOutcome[];
}

export interface Vocabulary {
  objectives: string[];
  corridors: string[];
  personas: string[];
  hours: number[];
  scenarios: string[];
  provider: { configured: boolean; model: string; grounded: boolean };
  boundary: string;
}

export async function vocabulary(q: {
  scenario: string; hour: number; persona: string; budget: number;
}): Promise<Vocabulary> {
  const u = new URL(`${API}/program/vocabulary`);
  u.searchParams.set("scenario", q.scenario);
  u.searchParams.set("hour", String(q.hour));
  u.searchParams.set("persona", q.persona);
  u.searchParams.set("budget_usd", String(q.budget));
  const r = await fetch(u);
  if (!r.ok) throw new Error("the engine is not reachable");
  return r.json();
}

export async function compile(text: string, d: {
  scenario: string; hour: number; persona: string; budget: number;
}): Promise<CompileReply> {
  const r = await fetch(`${API}/program/compile`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text, scenario: d.scenario, hour: d.hour, persona: d.persona,
      budget_usd: d.budget,
    }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? "could not compile");
  return r.json();
}

interface RawSolve {
  status: string;
  segments: { severe_minutes: number; heat_load: number }[];
  placements: { seg_id: string; kind: string }[];
  metric_used: string;
  solver: SolverInfo;
  [k: string]: unknown;
}

export async function solve(spec: ProgramSpec): Promise<ProgramResult> {
  const r = await fetch(`${API}/program/solve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? "the program was refused");
  const d = (await r.json()) as RawSolve;
  if (d.status !== "complete") {
    throw new Error(String((d.solver as unknown as { note?: string })?.note
      ?? "no plan satisfies every stated constraint"));
  }
  // Same derivations the greedy path makes, so a stated plan and a preset
  // plan render through identical code.
  const useSevere = d.metric_used === "severe_person_minutes";
  const tally = new Map<string, { seg_id: string; kind: string; count: number }>();
  for (const p of d.placements) {
    const k = `${p.seg_id}|${p.kind}`;
    const cur = tally.get(k);
    if (cur) cur.count += 1;
    else tally.set(k, { seg_id: p.seg_id, kind: p.kind, count: 1 });
  }
  return {
    ...(d as unknown as ProgramResult),
    metric_values: d.segments.map((s) => (useSevere ? s.severe_minutes : s.heat_load)),
    placements: [...tally.values()],
  };
}

/** Plain-language rendering of one constraint, for people who do not read JSON. */
export function describe(c: Constraint): string {
  const names = scopeNames(c.scope);
  const where = names.length ? list(names) : "every corridor";
  const n = c.min_units ?? 1;
  const unit = `${n} unit${n === 1 ? "" : "s"}`;
  const kind = (c.kind ?? "").replace(/_/g, " ");
  switch (c.type) {
    case "focus":
      return `Weight benefit on ${where} ×${c.weight ?? 1}`;
    case "corridor_floor":
      // A floor scoped to named streets is NOT a promise about every street,
      // and saying so would misrepresent the plan in the one place a person
      // reads it before it runs.
      return names.length
        ? `${list(names)} each receive at least ${unit}`
        : `Every walked corridor receives at least ${unit}`;
    case "kind_floor":
      return `At least ${unit} of ${kind}`;
    case "kind_cap":
      return `At most ${c.max_units ?? 0} ${kind}${
        (c.max_units ?? 0) === 1 ? "" : "s"}`;
    case "spend_cap":
      return `At most ${Math.round((c.max_fraction ?? 1) * 100)}% of the budget on ${where}`;
    case "spend_floor":
      return `At least ${Math.round((c.min_fraction ?? 0) * 100)}% of the budget on ${where}`;
    default:
      return c.type;
  }
}
