/**
 * Budget input parsing.
 *
 * The revision spec requires that "$250K", "$250,000" and "0.25M" all
 * normalise to 250000 USD, and that any other valid budget works too - the
 * preset buttons are shortcuts, not the only options.
 */
export interface ParsedBudget {
  usd: number | null;
  error: string | null;
}

const PATTERN = /^\$?\s*([0-9]+(?:[0-9,]*)?(?:\.[0-9]+)?)\s*([kKmM])?\s*$/;

export function parseBudget(raw: string): ParsedBudget {
  const text = raw.trim();
  if (!text) return { usd: null, error: "Enter a budget" };

  const m = PATTERN.exec(text.replace(/\s+/g, " "));
  if (!m) return { usd: null, error: "Use a number, optionally with K or M" };

  const value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return { usd: null, error: "Not a number" };

  const suffix = m[2]?.toLowerCase();
  const usd = suffix === "k" ? value * 1_000
    : suffix === "m" ? value * 1_000_000
      : value;

  if (usd <= 0) return { usd: null, error: "Budget must be above zero" };
  if (usd > 1_000_000_000) return { usd: null, error: "That is above $1B" };
  // Below the cheapest intervention nothing can be bought at all, and a plan
  // that buys nothing is not a useful answer to show.
  if (usd < 1_000) return { usd: null, error: "Too small to buy anything" };
  return { usd: Math.round(usd), error: null };
}

export function formatBudget(usd: number): string {
  if (usd >= 1_000_000 && usd % 100_000 === 0) {
    return `$${(usd / 1_000_000).toFixed(usd % 1_000_000 === 0 ? 0 : 2)}M`;
  }
  if (usd >= 1_000 && usd % 1_000 === 0) return `$${usd / 1_000}K`;
  return `$${usd.toLocaleString()}`;
}
