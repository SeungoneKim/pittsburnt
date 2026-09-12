/**
 * Moving agents for the map.
 *
 * Each agent is one of the routed synthetic trips, walking its own real path
 * at its cohort's own speed. Its colour is the UTCI where it actually is,
 * taken from the per-vertex sun exposure exported with the route - not a
 * decorative gradient. The spec is explicit that the animation may only
 * present values the model already computed.
 */
import type { CrashResult } from "./types";

export interface AgentRoute {
  persona: string;
  hour: number;
  /** Real walking duration for this route at this cohort's speed. */
  minutes: number;
  coords: [number, number][];
  sun: number[];
  /** Cumulative along-route distance at each vertex, normalised to 0..1. */
  t: number[];
  /** Wall-clock duration of one playback, derived from `minutes`. */
  visualDurationMs: number;
  /** Staggered start so a cohort does not move as one block. */
  startMs: number;
}

/**
 * Two presentation clocks, not one.
 *
 * Earlier versions used a single compression constant for everything, which
 * forced a choice between a busy street and legible movement: at 90x the map
 * was populated but every walker teleported, and at 15x each walker was
 * readable but the street looked deserted. Those are different questions and
 * they now have different answers.
 *
 * FLOW_TIME_COMPRESSION governs how much of the day's pedestrian flow is on
 * screen at once - the density of the crowd. Travel duration is derived from
 * it but clamped separately, so a walker crosses the screen slowly enough to
 * follow however dense the flow gets.
 *
 * Neither touches the model. Exposure is always computed from physical route
 * minutes with no compression at all, and zoom changes pixels per metre and
 * nothing else.
 */
export const FLOW_TIME_COMPRESSION = 70;

/** How many representative walkers to show. The spec asks for 60-80. */
export const VISIBLE_AGENT_TARGET = 72;

/** Longest a single route may take to cross the screen. */
const MAX_TRAVEL_MS = 18_000;

/**
 * Per-cohort minimum on-screen travel time.
 *
 * A floor is back, but a persona-dependent one, which is the opposite of the
 * flat 2-second floor removed in 2.6. That floor erased the speed difference
 * by making every short route equally fast; this one preserves the ordering
 * it exists to show - a 150 m trip takes an Older Adult 10.0 s against a
 * Student's 7.5 s - while keeping short routes readable at 70x flow.
 */
const MIN_TRAVEL_MS: Record<string, number> = {
  mobility_constrained: 12_000,
  older_adults: 10_000,
};
const DEFAULT_MIN_TRAVEL_MS = 7_500;

export interface AgentState {
  lon: number;
  lat: number;
  utci: number;
  /** Cumulative severe minutes this agent has absorbed so far. */
  severeSoFar: number;
}

/** On-screen travel time for one route, in wall-clock milliseconds. */
export function visualTravelDuration(routeMinutes: number,
  persona: string): number {
  const base = ((routeMinutes * 60_000) / FLOW_TIME_COMPRESSION) * 4;
  const minimum = MIN_TRAVEL_MS[persona] ?? DEFAULT_MIN_TRAVEL_MS;
  return Math.min(Math.max(base, minimum), MAX_TRAVEL_MS);
}

function cumulative(coords: [number, number][]): number[] {
  const t = [0];
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    // Planar distance is fine here: routes are under 2 km and this only
    // controls how fast a dot moves along its own line.
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    total += Math.hypot(dx, dy);
    t.push(total);
  }
  return total > 0 ? t.map((v) => v / total) : t.map(() => 0);
}

export function buildRoutes(
  fc: GeoJSON.FeatureCollection, persona: string, hour: number,
): AgentRoute[] {
  const wanted = fc.features.filter((f) => {
    const p = f.properties as Record<string, unknown>;
    // "All pedestrians" is the aggregation, so it draws from every cohort.
    const matchesPersona = persona === "all" || p.persona === persona;
    return matchesPersona && Number(p.hour) === hour;
  });

  const out: AgentRoute[] = [];
  for (const f of wanted) {
    const g = f.geometry;
    if (g.type !== "LineString") continue;
    const coords = g.coordinates as [number, number][];
    const p = f.properties as Record<string, unknown>;
    let sun: number[];
    try {
      sun = JSON.parse(String(p.sun)) as number[];
    } catch {
      continue;
    }
    if (sun.length !== coords.length || coords.length < 2) continue;
    const minutes = Number(p.minutes);
    out.push({
      persona: String(p.persona), hour: Number(p.hour),
      minutes, coords, sun, t: cumulative(coords),
      visualDurationMs: visualTravelDuration(minutes, String(p.persona)),
      // Deterministic stagger: same inputs, same phase offsets, every run.
      // Spread over the longest travel time so arrivals look continuous
      // rather than arriving as one block.
      startMs: (out.length * 617) % MAX_TRAVEL_MS,
    });
  }
  // Deterministic selection: the same inputs always show the same walkers.
  return out.slice(0, VISIBLE_AGENT_TARGET);
}

/** Progress of one agent at a wall-clock time, from its own real duration. */
export function progressAt(r: AgentRoute, nowMs: number): number {
  return ((nowMs + r.startMs) % r.visualDurationMs) / r.visualDurationMs;
}

/** Where an agent is, and how hot it is there, at progress `u` in [0, 1]. */
export function sampleRoute(
  r: AgentRoute, u: number, res: CrashResult,
): AgentState {
  const clamped = Math.min(Math.max(u, 0), 1);
  let i = 1;
  while (i < r.t.length - 1 && r.t[i] < clamped) i += 1;
  const span = r.t[i] - r.t[i - 1] || 1;
  const f = (clamped - r.t[i - 1]) / span;

  const lon = r.coords[i - 1][0] + (r.coords[i][0] - r.coords[i - 1][0]) * f;
  const lat = r.coords[i - 1][1] + (r.coords[i][1] - r.coords[i - 1][1]) * f;
  const sun = r.sun[i - 1] + (r.sun[i] - r.sun[i - 1]) * f;
  const utci = sun * res.utci_sun_c + (1 - sun) * res.utci_shade_c;

  return { lon, lat, utci, severeSoFar: 0 };
}

/**
 * Cumulative severe dose along a route, integrated once per agent.
 *
 * The previous version recomputed a halo from the *current* sample point, so
 * it snapped back to zero the moment a walker stepped into shade. Dose does
 * not un-accumulate: this integrates each interval and returns a monotonic
 * profile the animation can read.
 */
export function doseProfile(
  r: AgentRoute, res: CrashResult, severeThreshold: number,
): number[] {
  const out = [0];
  let acc = 0;
  for (let i = 1; i < r.sun.length; i += 1) {
    const midSun = (r.sun[i] + r.sun[i - 1]) / 2;
    const utci = midSun * res.utci_sun_c + (1 - midSun) * res.utci_shade_c;
    const share = r.t[i] - r.t[i - 1];
    if (utci >= severeThreshold) acc += r.minutes * share;
    out.push(acc);
  }
  return out;
}

/** Dose absorbed by progress `u`, interpolated within the interval. */
export function doseAt(r: AgentRoute, profile: number[], u: number): number {
  const clamped = Math.min(Math.max(u, 0), 1);
  let i = 1;
  while (i < r.t.length - 1 && r.t[i] < clamped) i += 1;
  const span = r.t[i] - r.t[i - 1] || 1;
  const f = (clamped - r.t[i - 1]) / span;
  return profile[i - 1] + (profile[i] - profile[i - 1]) * f;
}
