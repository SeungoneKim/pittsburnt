/**
 * One shared answer to "where may a floating thing go?"
 *
 * Persistent panels are fixed and known; the trouble was everything else -
 * a map popup, a stage banner - choosing its own position and landing on top
 * of a panel at the exact width the demo is shown at. So the reserved
 * rectangles live here, and anything transient asks before it opens.
 *
 * Coordinates are viewport pixels. The numbers match the panels' own CSS
 * (left-4 / right-4 / top-4 is 16 px) and are asserted by the release gates
 * rather than trusted.
 */
export const GUTTER = 16;

/** Persistent panel widths. Changing these here changes the reserved zones. */
export const SETUP_W = 292;
export const RESULT_W = 320;
/** Height of the centre-bottom call to action, plus its breathing room. */
export const CTA_H = 128;

export interface Rect { x: number; y: number; w: number; h: number }

export function zones(vw: number, vh: number): {
  left: Rect; right: Rect; cta: Rect; safe: Rect;
} {
  const left: Rect = { x: GUTTER, y: GUTTER, w: SETUP_W, h: vh - GUTTER * 2 };
  const right: Rect = {
    x: vw - GUTTER - RESULT_W, y: GUTTER, w: RESULT_W, h: vh - GUTTER * 2,
  };
  const cta: Rect = { x: vw / 2 - 90, y: vh - CTA_H, w: 180, h: CTA_H };
  // The strip a popup may occupy without covering anything persistent.
  const safe: Rect = {
    x: left.x + left.w + GUTTER,
    y: GUTTER,
    w: right.x - (left.x + left.w) - GUTTER * 2,
    h: vh - CTA_H - GUTTER,
  };
  return { left, right, cta, safe };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w
    && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Map padding so `fitBounds` centres on the strip a person can actually see,
 * not on the window behind the panels.
 */
export function mapPadding(): {
  left: number; right: number; top: number; bottom: number;
} {
  return {
    left: GUTTER + SETUP_W + GUTTER,
    right: GUTTER + RESULT_W + GUTTER,
    top: GUTTER,
    bottom: CTA_H,
  };
}

/**
 * Place a transient popup near `anchor` without covering a persistent panel.
 *
 * Tries each preferred side, takes the first that lands wholly inside the
 * safe strip, and otherwise clamps into it - so the worst case is a popup
 * that moved, never one that hides the result a person is reading.
 */
export function placePopover(
  anchor: { x: number; y: number }, size: { w: number; h: number },
  vw: number, vh: number,
  preferred: ("top" | "bottom" | "left" | "right")[] = ["top", "right", "left", "bottom"],
): Rect {
  const { safe } = zones(vw, vh);
  const gap = 12;
  const candidates: Record<string, Rect> = {
    top: { x: anchor.x - size.w / 2, y: anchor.y - size.h - gap, ...size },
    bottom: { x: anchor.x - size.w / 2, y: anchor.y + gap, ...size },
    left: { x: anchor.x - size.w - gap, y: anchor.y - size.h / 2, ...size },
    right: { x: anchor.x + gap, y: anchor.y - size.h / 2, ...size },
  };
  const inside = (r: Rect) => r.x >= safe.x && r.y >= safe.y
    && r.x + r.w <= safe.x + safe.w && r.y + r.h <= safe.y + safe.h;

  for (const side of preferred) {
    const r = candidates[side];
    if (inside(r)) return r;
  }
  const fallback = candidates[preferred[0]];
  return {
    ...size,
    x: Math.min(Math.max(fallback.x, safe.x), safe.x + safe.w - size.w),
    y: Math.min(Math.max(fallback.y, safe.y), safe.y + safe.h - size.h),
  };
}
