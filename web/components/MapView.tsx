"use client";

import { useEffect, useRef } from "react";

import {
  buildRoutes, doseAt, doseProfile, progressAt, sampleRoute,
} from "@/lib/agents";
import type { AgentRoute } from "@/lib/agents";

/** Used only to position a neutral agent before any snapshot exists. */
const BLANK = { utci_sun_c: 0, utci_shade_c: 0 } as unknown as CrashResult;
import "mapbox-gl/dist/mapbox-gl.css";
import "maplibre-gl/dist/maplibre-gl.css";
import type { AdaptResult, CrashResult, Hour, Meta } from "@/lib/types";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

/**
 * Renderer choice. Mapbox GL JS v3 refuses to start without a valid access
 * token even for a non-Mapbox style, so a missing or revoked token would
 * leave the demo with an empty map. MapLibre is API-compatible for
 * everything this component uses, so it renders the same layers off open
 * raster tiles when no token is configured. The demo cannot lose its map.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type GLNamespace = any;
type GLMap = any;

async function loadRenderer(): Promise<GLNamespace> {
  if (TOKEN) {
    const mod = await import("mapbox-gl");
    const GL: GLNamespace = mod.default ?? mod;
    GL.accessToken = TOKEN;
    return GL;
  }
  const mod = await import("maplibre-gl");
  return (mod as { default?: unknown }).default ?? mod;
}

/**
 * Thermal colour ramp, keyed to ABSOLUTE UTCI, not to a percentile of the
 * current run. The stress classes are published, so a quiet scenario must
 * look quiet rather than renormalising itself back to red. Red begins at
 * 38 C, the "Very Strong Heat Stress" threshold.
 */
const UTCI_RAMP: [number, string][] = [
  [20, "#9fb4c4"],     // no thermal stress - deliberately muted
  [26, "#b7c3bd"],     // moderate
  [32, "#e2d3a4"],     // strong
  [37.99, "#efb183"],  // still below the threshold
  [38, "#d7301f"],     // VERY STRONG - a hard step, not a gradient
  [46, "#7f0000"],     // extreme
];

/** Basemap. Without a Mapbox token we fall back to open raster tiles, so a
 *  missing or dead token degrades the styling and nothing else. */
function style(): any {
  if (TOKEN) return "mapbox://styles/mapbox/light-v11";
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      },
    },
    layers: [
      { id: "bg", type: "raster", source: "osm",
        // Fade the basemap so the exposure ramp reads as the subject.
        paint: { "raster-opacity": 0.45, "raster-saturation": -0.7 } },
    ],
  };
}

interface Props {
  meta: Meta;
  result: CrashResult | null;
  adapted: AdaptResult | null;
  hour: Hour | null;
  layers: {
    shadow: boolean; canopy: boolean; trees: boolean;
    buildings: boolean; trips: boolean; agents: boolean;
  };
  persona: string | null;
  crashStage: string;
  adaptStage: string;
  stageProgress: number;
  placedFraction: number;
  /** Hand the page a way to clear every dynamic layer on reset. */
  registerReset: (fn: () => void) => void;
  onSegmentClick?: (segId: string, index: number) => void;
}

export default function MapView({
  meta, result, adapted, hour, layers, persona, crashStage, adaptStage,
  stageProgress, placedFraction, registerReset, onSegmentClick,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const map = useRef<GLMap | null>(null);
  const ready = useRef(false);
  // Keep our own handle on the segment geometry. Reading it back out of the
  // renderer means touching a private field that Mapbox and MapLibre spell
  // differently, which is exactly the kind of thing that breaks on stage.
  const segGeo = useRef<GeoJSON.FeatureCollection | null>(null);
  const tripGeo = useRef<GeoJSON.FeatureCollection | null>(null);
  const agents = useRef<AgentRoute[]>([]);
  const doses = useRef<number[][]>([]);
  const raf = useRef<number | null>(null);

  // --- create the map once -------------------------------------------------
  useEffect(() => {
    if (map.current || !ref.current) return;
    let disposed = false;

    (async () => {
      const GL = await loadRenderer();
      if (disposed || !ref.current) return;

      const m: GLMap = new GL.Map({
        container: ref.current,
        style: style(),
        center: [meta.center.lon, meta.center.lat],
        zoom: 14.1,
        attributionControl: true,
      });
      map.current = m;
      m.addControl(new GL.NavigationControl({ showCompass: false }), "bottom-right");

      m.on("load", async () => {
        const [segments, buildings, trees, trips] = await Promise.all([
          fetch("/data/segments.geojson").then((r) => r.json()),
          fetch("/data/buildings.geojson").then((r) => r.json()),
          fetch("/data/trees.geojson").then((r) => r.json()),
          fetch("/data/trips.geojson").then((r) => r.json()),
        ]);
        // Numeric ids let us push 2,400 score updates through feature-state
        // instead of re-serialising the whole FeatureCollection each run.
        segments.features.forEach((f: GeoJSON.Feature, i: number) => { f.id = i; });
        segGeo.current = segments;

        m.addSource("buildings", { type: "geojson", data: buildings });
        m.addLayer({
          id: "buildings", type: "fill", source: "buildings",
          layout: { visibility: "none" },
          paint: {
            "fill-color": [
              "interpolate", ["linear"], ["get", "height_m"],
              3, "#ece7df", 20, "#d5ccbd", 60, "#a99c84", 140, "#7d7059",
            ],
            "fill-opacity": 0.75,
          },
        });

        for (const h of meta.hours) {
          const sh = await fetch(`/data/shadow_${String(h).padStart(2, "0")}.geojson`)
            .then((r) => r.json());
          m.addSource(`shadow-${h}`, { type: "geojson", data: sh });
          m.addLayer({
            id: `shadow-${h}`, type: "fill", source: `shadow-${h}`,
            layout: { visibility: "none" },
            paint: { "fill-color": "#31456b", "fill-opacity": 0.2 },
          });
        }

          // Canopy is a 1 m raster, and at 3 PM it shades roughly twice what
        // buildings do - the core of the argument for planting trees, so it
        // has to be visible, not just an input.
        if (meta.canopy) {
          m.addSource("canopy", {
            type: "image", url: "/data/canopy.png", coordinates: meta.canopy.bounds,
          });
          m.addLayer({
            id: "canopy", type: "raster", source: "canopy",
            layout: { visibility: "none" },
            paint: { "raster-opacity": 0.55 },
          });
        }


      m.addSource("trees", { type: "geojson", data: trees });
        m.addLayer({
          id: "trees", type: "circle", source: "trees",
          layout: { visibility: "none" },
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 1.4, 17, 4],
            "circle-color": "#2f7a43", "circle-opacity": 0.65,
          },
        });

        tripGeo.current = trips;
        m.addSource("trips", { type: "geojson", data: trips });
        m.addLayer({
          id: "trips", type: "line", source: "trips",
          layout: { visibility: "none", "line-cap": "round" },
          paint: {
            "line-color": "#7b5ea7", "line-width": 1.2, "line-opacity": 0.35,
          },
        });

        // The modelled area, drawn as a thin outline. Without it a viewer
        // cannot tell "no exposure here" from "we did not model here", and
        // the canopy layer deliberately extends past it for context.
        const { west, south, east, north } = meta.scope;
        m.addSource("scope", {
          type: "geojson",
          data: {
            type: "Feature", properties: {},
            geometry: {
              type: "LineString",
              coordinates: [[west, south], [east, south], [east, north],
                            [west, north], [west, south]],
            },
          } as GeoJSON.Feature,
        });
        m.addLayer({
          id: "scope", type: "line", source: "scope",
          paint: {
            "line-color": "#64748b", "line-width": 1.2,
            "line-dasharray": [4, 3], "line-opacity": 0.7,
          },
        });

        m.addSource("segments", { type: "geojson", data: segments });
        // Grey baseline so the street network is legible before any run.
        m.addLayer({
          id: "segments-base", type: "line", source: "segments",
          layout: { "line-cap": "round" },
          paint: {
            "line-color": "#b9bcc4",
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1.2, 17, 3.5],
            "line-opacity": 0.9,
          },
        });
        m.addLayer({
          id: "segments", type: "line", source: "segments",
          layout: { "line-cap": "round" },
          paint: {
            "line-color": [
              "case",
              ["==", ["feature-state", "scored"], true],
              ["interpolate", ["linear"], ["feature-state", "utci"],
                ...UTCI_RAMP.flatMap(([stop, colour]) => [stop, colour])],
              "rgba(0,0,0,0)",
            ],
            // A zoom expression may not contain feature-state, so width is
            // zoom-only and the thermal class is carried entirely by colour.
            "line-width": ["interpolate", ["linear"], ["zoom"],
              13, 2.2, 15, 3.4, 17, 6],
            "line-opacity": 0.95,
          },
        });

        // Where the optimiser actually spent the money.
        // Moving people. Neutral until a validated snapshot exists to colour
        // them; the halo then grows with accumulated severe dose.
        m.addSource("agents", {
          type: "geojson", data: { type: "FeatureCollection", features: [] },
        });
        m.addLayer({
          id: "agent-halo", type: "circle", source: "agents",
          layout: { visibility: "none" },
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["get", "severe"],
              0, 0, 20, 18],
            "circle-color": "#d7301f", "circle-opacity": 0.15,
            "circle-blur": 0.6,
          },
        });
        m.addLayer({
          id: "agent-dot", type: "circle", source: "agents",
          layout: { visibility: "none" },
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3, 17, 6],
            "circle-color": [
              "case",
              ["<", ["get", "utci"], 0], "#64748b",   // neutral, pre-Crash
              ["interpolate", ["linear"], ["get", "utci"],
                ...UTCI_RAMP.flatMap(([stop, colour]) => [stop, colour])],
            ],
            "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.2,
          },
        });

        // One point per purchased unit, at its exact coordinate, plus the
        // shade footprint that unit actually casts. Highlighting a whole
        // segment for "a tree went somewhere on this street" is not a
        // placement.
        m.addSource("shade-footprints", {
          type: "geojson", data: { type: "FeatureCollection", features: [] },
        });
        m.addLayer({
          id: "shade-footprints", type: "fill", source: "shade-footprints",
          paint: {
            "fill-color": ["match", ["get", "kind"],
              "shaded_shelter", "#0f766e", "#15803d"],
            "fill-opacity": ["*", 0.28, ["coalesce", ["get", "bloom"], 0]],
          },
        });
        m.addSource("placed", {
          type: "geojson", data: { type: "FeatureCollection", features: [] },
        });
        m.addLayer({
          id: "placed", type: "circle", source: "placed",
          paint: {
            // "zoom" must be the top-level input to interpolate, so the pop
            // scale multiplies inside each stop rather than wrapping it.
            "circle-radius": ["interpolate", ["linear"], ["zoom"],
              13, ["*", 5, ["coalesce", ["get", "pop"], 1]],
              17, ["*", 11, ["coalesce", ["get", "pop"], 1]]],
            "circle-color": ["match", ["get", "kind"],
              "shaded_shelter", "#0f766e", "#15803d"],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          },
        });
        m.addLayer({
          id: "placed-glyph", type: "symbol", source: "placed",
          layout: {
            "text-field": ["match", ["get", "kind"], "shaded_shelter", "\u26E9", "\u2663"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 13, 8, 17, 14],
            "text-allow-overlap": true,
          },
          paint: { "text-color": "#ffffff" },
        });

        // feature-state is not permitted in a layer filter, only in paint,
        // so visibility runs through opacity.
        m.addLayer({
          id: "hotspot-halo", type: "line", source: "segments",
          paint: {
            "line-color": "#7f0000",
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 7, 17, 16],
            "line-opacity": [
              "case", ["==", ["feature-state", "hotspot"], true], 0.2, 0,
            ],
            "line-blur": 2,
          },
        });

        const popup = new GL.Popup({ closeButton: false, maxWidth: "260px" });
        m.on("click", "segments", (e: any) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as Record<string, unknown>;
          onSegmentClick?.(String(p.seg_id), Number(f.id));
          const st = m.getFeatureState({ source: "segments", id: f.id as number }) as
            Record<string, number>;
          popup.setLngLat(e.lngLat).setHTML(
            `<div style="font:12px ui-sans-serif,system-ui">
               <b>${p.corridor ?? "Unnamed path"}</b><br>
               <span style="color:#666">${p.walk_class} · ${p.length_m} m</span><br>
               exposure <b>${(st?.exposure ?? 0).toFixed(2)}</b> at-risk ped-min<br>
               sun exposure <b>${((st?.sun ?? 0) * 100).toFixed(0)}%</b>
             </div>`).addTo(m);
        });
        m.on("mouseenter", "segments", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "segments", () => { m.getCanvas().style.cursor = ""; });

        // Reset contract: cancel animation, clear every feature-state key,
        // and empty every dynamic source. A reset that leaves a halo or a
        // stale agent behind is not a reset.
        registerReset(() => {
          if (raf.current !== null) cancelAnimationFrame(raf.current);
          raf.current = null;
          agents.current = [];
          doses.current = [];
          for (const id of ["agents", "placed", "shade-footprints"]) {
            const src = m.getSource(id);
            if (src) src.setData({ type: "FeatureCollection", features: [] });
          }
          m.removeFeatureState({ source: "segments" });
          for (const l of ["canopy", "trees", "trips", "buildings"]) {
            if (m.getLayer(l)) m.setLayoutProperty(l, "visibility", "none");
          }
          for (const h of meta.hours) {
            if (m.getLayer(`shadow-${h}`)) {
              m.setLayoutProperty(`shadow-${h}`, "visibility", "none");
            }
          }
          m.easeTo({
            center: [meta.center.lon, meta.center.lat], zoom: 14.1,
            duration: 600,
          });
        });

        ready.current = true;
        // Handy for inspecting a live map from the browser console.
        (window as unknown as Record<string, unknown>).__map = m;
        // Lets the acceptance test assert the reset contract from outside.
        (window as unknown as Record<string, unknown>).__mapState = () => {
          const count = (id: string) => {
            const src = m.getSource(id);
            const d = src && (src as unknown as { _data?: GeoJSON.FeatureCollection })._data;
            return d?.features?.length ?? 0;
          };
          let stateful = 0;
          for (let i = 0; i < meta.seg_ids.length; i += 1) {
            if (Object.keys(m.getFeatureState({ source: "segments", id: i })).length) {
              stateful += 1;
            }
          }
          return {
            dynamicSourceFeatureCount:
              count("agents") + count("placed") + count("shade-footprints"),
            segmentsWithFeatureState: stateful,
            animationRunning: raf.current !== null,
          };
        };
      });
    })();

    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
      ready.current = false;
    };
    // Deliberately mount-only: the map is imperative and manages its own updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- push scores into feature-state -------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    // Each beat reveals its own layer. Nothing here computes: the engine
    // returned every value before the sequence started.
    const showThermal = ["thermal", "people", "hotspot", "complete"]
      .includes(crashStage);
    const showHalo = ["hotspot", "complete"].includes(crashStage);
    if (!result || !showThermal) {
      // Clear, do not write zeros: writing {scored:false} to every segment
      // is still feature-state, and a reset that leaves it behind has not
      // reset anything.
      m.removeFeatureState({ source: "segments" });
      return;
    }

    // After ADAPT the engine supplies the post-intervention environment
    // directly. Backing it out of a ratio of exposure scores, as the previous
    // version did, is a reconstruction rather than a result.
    const cooled = adapted && ["cool", "retest", "land", "complete"]
      .includes(adaptStage);
    const utciArr = cooled ? adapted.after_utci_c : null;
    const sunArr = cooled ? adapted.after_sun : result.sun;
    const severe = adapted?.metric_values ?? result.severe_minutes;

    const ranked = severe
      .map((v, i) => [v, i] as [number, number])
      .filter(([v]) => v > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 25);
    const isHotspot = new Set(ranked.map(([, i]) => i));

    for (let i = 0; i < meta.seg_ids.length; i += 1) {
      const sun = sunArr[i];
      const utci = utciArr
        ? utciArr[i]
        : sun * result.utci_sun_c + (1 - sun) * result.utci_shade_c;
      m.setFeatureState({ source: "segments", id: i }, {
        scored: result.minutes[i] > 0,
        utci,
        severe: severe[i],
        sun,
        hotspot: showHalo && isHotspot.has(i),
      });
    }
  }, [result, adapted, meta.seg_ids.length, crashStage, adaptStage, stageProgress]);

  // --- exact placements ----------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const pts = m.getSource("placed");
    const foot = m.getSource("shade-footprints");
    if (!pts || !foot) return;

    const show = !["idle", "loading", "lock", "rank"].includes(adaptStage);
    if (!adapted || !show) {
      pts.setData({ type: "FeatureCollection", features: [] });
      foot.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    // Units land in optimiser order across the "place" beat.
    const units = adapted.unit_placements;
    const shown = Math.max(1, Math.round(units.length * placedFraction));
    const visible = units.slice(0, shown);

    pts.setData({
      type: "FeatureCollection",
      features: visible.map((u, i) => {
        // Stagger the pop so the first few read individually.
        const age = shown - i;
        const pop = age < 3 ? 0.25 + 0.75 * Math.min(1, age / 2.5) : 1;
        return {
          type: "Feature" as const,
          properties: { kind: u.kind, pop, unitId: u.unitId },
          geometry: { type: "Point" as const, coordinates: [u.lon, u.lat] },
        };
      }),
    });

    // Shade blooms during "grow" and stays afterwards.
    const bloom = adaptStage === "grow" ? stageProgress
      : ["cool", "retest", "land", "complete"].includes(adaptStage) ? 1 : 0;
    const R = 0.00008;   // ~9 m, roughly a mature crown
    foot.setData({
      type: "FeatureCollection",
      features: visible.map((u) => {
        const r = R * (u.kind === "shaded_shelter" ? 0.55 : 1) * bloom;
        const ring = Array.from({ length: 17 }, (_, k) => {
          const a = (k / 16) * Math.PI * 2;
          return [u.lon + Math.cos(a) * r * 1.3, u.lat + Math.sin(a) * r];
        });
        return {
          type: "Feature" as const,
          properties: { kind: u.kind, bloom },
          geometry: { type: "Polygon" as const, coordinates: [ring] },
        };
      }),
    });
  }, [adapted, adaptStage, stageProgress, placedFraction]);

  // --- layer toggles -------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const set = (id: string, on: boolean) => {
      if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    set("buildings", layers.buildings);
    set("canopy", layers.canopy);
    set("trees", layers.trees);
    set("trips", layers.trips);
    set("agent-halo", layers.agents);
    set("agent-dot", layers.agents);
    for (const h of meta.hours) set(`shadow-${h}`, layers.shadow && h === hour);
  }, [layers, hour, meta.hours]);

  // The renderer stamps .maplibregl-map / .mapboxgl-map onto the container,
  // and both stylesheets set position:relative on it - which would override
  // an `absolute inset-0` here and collapse the map to zero height. So the
  // positioning lives on a wrapper and the container just fills it.
  // --- moving agents -------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    const stop = () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
    // People appear as soon as we know who and when - before any Crash Test.
    // They are neutral until a validated snapshot exists to colour them.
    const havePeople = persona !== null && hour !== null;
    if (!m || !ready.current || !havePeople || !layers.agents || !tripGeo.current) {
      stop();
      return stop;
    }
    const coloured = !!result && ["people", "hotspot", "complete"].includes(crashStage);
    const afterColoured = !!result && ["retest", "land", "complete"].includes(adaptStage);

    agents.current = buildRoutes(tripGeo.current, persona, hour);
    doses.current = result
      ? agents.current.map((r) => doseProfile(r, result, meta.severe_threshold_utci_c))
      : [];
    const src = m.getSource("agents");
    if (!src || !agents.current.length) return stop;

    const start = performance.now();
    const tick = (now: number) => {
      const t = now - start;
      const features = agents.current.map((r, i) => {
        // Each agent runs on its own real duration, so a slower cohort
        // visibly takes longer over the same ground.
        const u = progressAt(r, t);
        const st = sampleRoute(r, u, result ?? BLANK, meta.severe_threshold_utci_c);
        const dose = (coloured || afterColoured) && doses.current[i]
          ? doseAt(r, doses.current[i], u) : 0;
        return {
          type: "Feature" as const,
          properties: {
            utci: coloured || afterColoured ? st.utci : -1,
            severe: dose,
          },
          geometry: { type: "Point" as const, coordinates: [st.lon, st.lat] },
        };
      });
      src.setData({ type: "FeatureCollection", features });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return stop;
  }, [layers.agents, result, persona, hour, meta.severe_threshold_utci_c,
      crashStage, adaptStage]);

  return (
    <div className="absolute inset-0">
      <div ref={ref} className="h-full w-full" />
    </div>
  );
}
