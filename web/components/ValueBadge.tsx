"use client";

import { STATUS_LABEL, STATUS_STYLE } from "@/lib/provenance";
import type { ValueMeta } from "@/lib/provenance";

/**
 * A small status chip next to a number, saying what kind of number it is.
 *
 * The point is not decoration: a viewer should be able to tell at a glance
 * whether a figure was loaded from a dataset, derived from one, or assumed
 * because no local calibration exists. Hovering gives the source and method.
 */
export default function ValueBadge({ meta, compact = false }: {
  meta: ValueMeta | undefined;
  compact?: boolean;
}) {
  if (!meta) return null;
  const title = [
    `${STATUS_LABEL[meta.status]} · ${meta.confidence} confidence`,
    meta.sourceLabel,
    meta.method,
    meta.sourceUrl,
  ].filter(Boolean).join("\n");

  return (
    <span
      title={title}
      className={`ml-1 inline-block cursor-help rounded px-1 align-middle
        ${compact ? "text-[8px]" : "text-[9px]"} font-medium uppercase
        tracking-wide ${STATUS_STYLE[meta.status]}`}
    >
      {compact ? STATUS_LABEL[meta.status].slice(0, 3) : STATUS_LABEL[meta.status]}
    </span>
  );
}
