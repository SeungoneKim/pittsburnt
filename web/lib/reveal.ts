/**
 * Staged reveal machinery.
 *
 * An instant result is correct but it is not a demo: nobody can see what the
 * model did. So the snapshot is fetched and validated FIRST, and only then
 * revealed in stages. The animation never computes anything and never shows
 * an intermediate number that is not on the path to the real one - every
 * counter finishes on the exact value the engine returned, even if frames
 * are dropped or the viewer skips.
 */
export type CrashStage =
  | "idle" | "loading" | "climate" | "thermal" | "people" | "hotspot" | "complete";

export type AdaptStage =
  | "idle" | "loading" | "lock" | "rank" | "place" | "grow"
  | "cool" | "retest" | "land" | "complete";

export interface StageSpec<S> {
  stage: S;
  ms: number;
  /** Headline shown above the map while this stage runs. */
  headline: string;
  detail: string;
}

/** 5.6 s total. The spec calls for 5-6 s; past 8 s it reads as slow. */
export const CRASH_STAGES: StageSpec<CrashStage>[] = [
  { stage: "climate", ms: 1200, headline: "1 · The climate shifts",
    detail: "Air temperature, humidity and wind for this scenario" },
  { stage: "thermal", ms: 1200, headline: "2 · Thermal stress rises",
    detail: "Mean radiant temperature and UTCI, sun versus shade" },
  { stage: "people", ms: 2000, headline: "3 · People are exposed",
    detail: "The same simulated walkers, moving on their real routes" },
  { stage: "hotspot", ms: 1200, headline: "4 · The vulnerable streets",
    detail: "Where those people absorb the most" },
];

/** 8.0 s total, per the spec's Adjust choreography. */
export const ADAPT_STAGES: StageSpec<AdaptStage>[] = [
  { stage: "lock", ms: 600, headline: "Plan locked",
    detail: "Budget, objective and geography frozen" },
  { stage: "rank", ms: 800, headline: "1 · Siting solutions",
    detail: "Candidate sites ranked by exposure avoided per dollar" },
  { stage: "place", ms: 1600, headline: "2 · Adding shade",
    detail: "Each placement at its exact location" },
  { stage: "grow", ms: 1200, headline: "2 · Adding shade",
    detail: "Canopy at maturity; shelter roofs unfold" },
  { stage: "cool", ms: 1200, headline: "3 · Cooling locations",
    detail: "Only the affected geometry moves from Before to After" },
  { stage: "retest", ms: 2000, headline: "4 · Re-testing the same people",
    detail: "Identical agents, routes and weather" },
  { stage: "land", ms: 600, headline: "Result",
    detail: "Walking, waiting and total exposure avoided" },
];

export function totalMs<S>(stages: StageSpec<S>[]): number {
  return stages.reduce((a, s) => a + s.ms, 0);
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Ease a counter from 0 to its final value. Returns the exact target once
 * progress reaches 1, so a dropped frame can never leave a number slightly
 * wrong on screen.
 */
export function countTo(target: number, progress: number): number {
  if (progress >= 1) return target;
  if (progress <= 0) return 0;
  const eased = 1 - (1 - progress) ** 3;   // ease-out cubic
  return target * eased;
}

/** Interpolate between two known values; exact at both ends. */
export function lerpExact(from: number, to: number, progress: number): number {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  return from + (to - from) * (1 - (1 - progress) ** 3);
}

export interface RevealController<S> {
  stage: S;
  /** Progress within the current stage, 0..1. */
  stageProgress: number;
  /** Progress through the whole sequence, 0..1. */
  progress: number;
  running: boolean;
}

/**
 * Drive a stage sequence with requestAnimationFrame.
 *
 * `onUpdate` is called every frame. Calling the returned `skip` jumps
 * straight to the end state - the spec requires Skip and Replay, and that a
 * skipped run lands on exactly the same numbers as a watched one.
 */
export function runStages<S extends string>(
  stages: StageSpec<S>[],
  done: S,
  onUpdate: (c: RevealController<S>) => void,
  reducedMotion = false,
): { skip: () => void; cancel: () => void } {
  const total = totalMs(stages);
  // Reduced motion still sequences, just fast and without map travel.
  const scale = reducedMotion ? 0.35 : 1;
  const start = performance.now();
  let frame: number | null = null;
  let finished = false;

  const finish = () => {
    finished = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    onUpdate({ stage: done, stageProgress: 1, progress: 1, running: false });
  };

  const tick = (now: number) => {
    if (finished) return;
    const elapsed = (now - start) / scale;
    if (elapsed >= total) { finish(); return; }

    let acc = 0;
    for (const s of stages) {
      if (elapsed < acc + s.ms) {
        onUpdate({
          stage: s.stage,
          stageProgress: (elapsed - acc) / s.ms,
          progress: elapsed / total,
          running: true,
        });
        break;
      }
      acc += s.ms;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return {
    skip: finish,
    cancel: () => {
      finished = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

export function headlineFor<S>(stages: StageSpec<S>[], stage: S): StageSpec<S> | null {
  return stages.find((s) => s.stage === stage) ?? null;
}
