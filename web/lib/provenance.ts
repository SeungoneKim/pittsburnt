/**
 * The browser half of the snapshot contract.
 *
 * This must produce byte-identical hashes to api/provenance.py. The runtime
 * rule is that a cached answer may only be shown when its input_hash equals
 * the hash of the request actually made - so the $250K plan can never appear
 * for a $137,500 budget, and a stale bundle from an older pipeline build is
 * refused rather than silently reused.
 */
export type ValueStatus = "source" | "computed" | "assumption" | "missing";

export interface ValueMeta {
  status: ValueStatus;
  sourceLabel: string;
  sourceUrl?: string | null;
  method?: string | null;
  confidence: "high" | "medium" | "low";
}

/** 32-bit FNV-1a as lowercase hex. Twin of the Python implementation. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) {
    h ^= b;
    // Multiply by 0x01000193 in 32-bit space without losing precision.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

type Part = string | number | boolean | null | string[];

/** Stable string for hashing: sorted keys, no whitespace, ordered lists. */
export function canonical(parts: Record<string, Part>): string {
  const norm = (v: Part): unknown => {
    if (Array.isArray(v)) return [...v].sort();
    if (typeof v === "number") return Number.isInteger(v) ? v : Number(v.toFixed(6));
    return v;
  };
  const keys = Object.keys(parts).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(norm(parts[k]))}`);
  return `{${body.join(",")}}`;
}

export function inputHash(args: {
  datasetVersion: string;
  scenario: string;
  hour: number;
  persona: string;
  budgetUsd?: number | null;
  kinds?: string[] | null;
}): string {
  return fnv1a(canonical({
    dataset: args.datasetVersion,
    scenario: args.scenario,
    hour: Math.trunc(args.hour),
    persona: args.persona,
    // A crash test has no budget; the field stays present so the two request
    // shapes can never collide on the same hash.
    budget: args.budgetUsd == null ? null : Math.round(args.budgetUsd),
    kinds: args.kinds && args.kinds.length ? args.kinds : ["*"],
  }));
}

export interface SnapshotCheck {
  ok: boolean;
  reason: string | null;
}

/**
 * A snapshot is usable only if it is complete and answers the exact question
 * asked. Anything else is reported, never displayed.
 */
export function validateSnapshot(
  snapshot: { input_hash?: string; status?: string } | null | undefined,
  expectedHash: string,
): SnapshotCheck {
  if (!snapshot) return { ok: false, reason: "No snapshot returned" };
  if (snapshot.status && snapshot.status !== "complete") {
    return { ok: false, reason: `Snapshot status is "${snapshot.status}"` };
  }
  if (!snapshot.input_hash) {
    return { ok: false, reason: "Snapshot carries no input hash" };
  }
  if (snapshot.input_hash !== expectedHash) {
    return {
      ok: false,
      reason: `Snapshot ${snapshot.input_hash} does not match this request `
        + `(${expectedHash}) — refusing to show a result for different inputs`,
    };
  }
  return { ok: true, reason: null };
}

export const STATUS_LABEL: Record<ValueStatus, string> = {
  source: "Source",
  computed: "Computed",
  assumption: "Assumption",
  missing: "Missing",
};

export const STATUS_STYLE: Record<ValueStatus, string> = {
  source: "bg-sky-100 text-sky-800",
  computed: "bg-slate-100 text-slate-700",
  assumption: "bg-amber-100 text-amber-800",
  missing: "bg-red-100 text-red-800",
};
