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

/** 7.5 s total, per the 2.5 choreography. */
export const CRASH_STAGES: StageSpec<CrashStage>[] = [
  { stage: "climate", ms: 1500, headline: "1 · The climate shifts",
    detail: "Air temperature rises. Humidity, wind and solar are held constant" },
  { stage: "thermal", ms: 1500, headline: "2 · Thermal stress rises",
    detail: "Mean radiant temperature and UTCI; the gradient crosses bands" },
  { stage: "people", ms: 2500, headline: "3 · People are exposed",
    detail: "The same walkers recolour; exposure dose accumulates" },
  { stage: "hotspot", ms: 2000, headline: "4 · The vulnerable streets",
    detail: "The highest human-exposure location pulses" },
];

/** 10.0 s total, per the 2.5 Adjust choreography. */
export const ADAPT_STAGES: StageSpec<AdaptStage>[] = [
  { stage: "lock", ms: 1000, headline: "Plan locked",
    detail: "Budget, policy, scenario, agents and input hash frozen" },
  { stage: "rank", ms: 0, headline: "Plan locked", detail: "" },
  { stage: "place", ms: 4000, headline: "1 · Siting solutions",
    detail: "Each purchased unit lands at its exact point, in optimiser order" },
  { stage: "grow", ms: 0, headline: "1 · Siting solutions", detail: "" },
  { stage: "cool", ms: 2000, headline: "2 · Protecting the ground",
    detail: "Tree shade blooms along footways; shelter roofs cover the stop" },
  { stage: "retest", ms: 2000, headline: "3 · Re-testing the same people",
    detail: "Identical agents, routes, waits and clock" },
  { stage: "land", ms: 1000, headline: "4 · Result",
    detail: "Baseline, future before, future after" },
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
