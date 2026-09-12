"use client";

import { useEffect, useRef } from "react";

import { AGENT_COUNT, buildRoutes, sampleRoute } from "@/lib/agents";
import type { AgentRoute } from "@/lib/agents";
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
  hour: Hour;
  layers: {
    shadow: boolean; canopy: boolean; trees: boolean;
    buildings: boolean; trips: boolean; agents: boolean;
  };
  persona: string;
  crashStage: string;
  adaptStage: string;
  stageProgress: number;
  onSegmentClick?: (segId: string, index: number) => void;
}

export default function MapView({
  meta, result, adapted, hour, layers, persona, crashStage, adaptStage,
  stageProgress, onSegmentClick,
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
        m.addSource("placed", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        // Segments in the Very Strong band, drawn over the tint so the
        // threshold reads as a class rather than as one more shade of orange.
        // Moving agents. A halo grows while an agent is above the severe
        // threshold, so its size means accumulated exposure rather than
        // elapsed time.
        m.addSource("agents", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        m.addLayer({
          id: "agent-halo", type: "circle", source: "agents",
          layout: { visibility: "none" },
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["get", "severe"],
              0, 0, 20, 16],
            "circle-color": "#d7301f", "circle-opacity": 0.16,
            "circle-blur": 0.5,
          },
        });
        m.addLayer({
          id: "agent-dot", type: "circle", source: "agents",
          layout: { visibility: "none" },
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.6, 17, 5.5],
            "circle-color": ["interpolate", ["linear"], ["get", "utci"],
              ...UTCI_RAMP.flatMap(([stop, colour]) => [stop, colour])],
            "circle-stroke-color": "#ffffff", "circle-stroke-width": 1,
          },
        });

        // Human-exposure hotspots. The thermal tint already says which
        // streets are in the Very Strong band - about half of them - so
        // emphasis is reserved for where people actually absorb the most.
        // A percentile may rank hotspots; it may not restate a stress class.
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

        m.addLayer({
          id: "placed", type: "line", source: "placed",
          layout: { "line-cap": "round" },
          paint: {
            "line-color": "#1f9d55",
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 3.5, 17, 8],
            "line-opacity": 0.85,
            "line-dasharray": [1, 1.1],
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

        ready.current = true;
        // Handy for inspecting a live map from the browser console.
        (window as unknown as Record<string, unknown>).__map = m;
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
    // Each beat reveals its own layer. Nothing here computes: the values
    // were all returned by the engine before the sequence started.
    const showThermal = ["thermal", "people", "hotspot", "complete"]
      .includes(crashStage);
    const showHalo = ["hotspot", "complete"].includes(crashStage);
    if (!result || !showThermal) {
      for (let i = 0; i < meta.seg_ids.length; i += 1) {
        m.setFeatureState({ source: "segments", id: i }, { scored: false, utci: 0 });
      }
      return;
    }
    const sun0 = result.sun;
    const severe = adapted?.metric_values ?? result.severe_minutes;
    const uSun = result.utci_sun_c;
    const uShade = result.utci_shade_c;

    // Top 25 by human exposure get the halo.
    const ranked = severe
      .map((v, i) => [v, i] as [number, number])
      .filter(([v]) => v > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 25);
    const isHotspot = new Set(ranked.map(([, i]) => i));

    for (let i = 0; i < meta.seg_ids.length; i += 1) {
      // After ADAPT, a segment's sun fraction has fallen; recover it from the
      // change in its severe minutes so the map cools where shade was added.
      let sun = sun0[i];
      if (adapted && result.severe_minutes[i] > 0) {
        sun = sun0[i] * (severe[i] / result.severe_minutes[i]);
      }
      const utci = sun * uSun + (1 - sun) * uShade;
      // A segment nobody walks has no human exposure to report; it stays on
      // the grey base layer rather than being coloured as if it were safe.
      m.setFeatureState({ source: "segments", id: i }, {
        scored: result.minutes[i] > 0,
        utci,
        severe: severe[i],
        sun,
        hotspot: showHalo && isHotspot.has(i),
      });
    }
  }, [result, adapted, meta.seg_ids.length, crashStage, adaptStage, stageProgress]);

  // --- highlight where money was spent ------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const src = m.getSource("placed");
    if (!src) return;
    const showPlacements = !["idle", "loading", "lock", "rank"]
      .includes(adaptStage);
    if (!adapted || !showPlacements) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const data = segGeo.current;
    if (!data) return;
    // Placements land in optimiser order over the "place" beat: the first
    // few individually, the rest in batches, so nobody waits through 208
    // identical pops.
    const frac = adaptStage === "place" ? stageProgress : 1;
    const shown = Math.max(1, Math.round(adapted.placements.length * frac));
    const wanted = new Set(
      adapted.placements.slice(0, shown).map((p) => p.seg_id));
    src.setData({
      type: "FeatureCollection",
      features: data.features.filter(
        (f) => wanted.has(String((f.properties as Record<string, unknown>).seg_id))),
    });
  }, [adapted, adaptStage, stageProgress]);

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
    const showAgents = ["people", "hotspot", "complete"].includes(crashStage)
      || ["retest", "land", "complete"].includes(adaptStage);
    if (!m || !ready.current || !layers.agents || !result || !tripGeo.current
        || !showAgents) {
      stop();
      return stop;
    }

    agents.current = buildRoutes(tripGeo.current, persona, hour);
    const src = m.getSource("agents");
    if (!src || !agents.current.length) return stop;

    // One full walk-through every 14 seconds, staggered so the cohort does
    // not move as a single block.
    const PERIOD = 14000;
    const start = performance.now();
    const tick = (now: number) => {
      const base = ((now - start) % PERIOD) / PERIOD;
      const features = agents.current.map((r, i) => {
        const u = (base + i / agents.current.length) % 1;
        const st = sampleRoute(r, u, result, meta.severe_threshold_utci_c);
        return {
          type: "Feature" as const,
          properties: { utci: st.utci, severe: st.severeSoFar },
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
