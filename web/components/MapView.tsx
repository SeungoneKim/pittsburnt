"use client";

import { useEffect, useRef, useState } from "react";

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
 * current run. The stress classes are published, so a quiet scenario looks
 * quiet rather than renormalising itself back to red.
 *
 * Continuous, deliberately. An earlier version stepped hard at 38 C, which
 * made cooling from 37.9 to 34 invisible while cooling from 38.1 to 37.9
 * looked dramatic - a false cliff. 38 C is still the published entry to Very
 * Strong Heat Stress; it is marked on the legend rather than drawn as a wall.
 */
const UTCI_RAMP: [number, string][] = [
  [22, "#8fc7a4"],   // comfortable
  [26, "#bfe0a8"],   // Moderate begins
  [30, "#f2e394"],
  [32, "#f7d070"],   // Strong begins
  [35, "#f3944a"],
  [38, "#e8562a"],   // Very Strong begins - marked, not a cliff
  [42, "#c81e1e"],
  [46, "#7f0000"],   // Extreme
];

/** Basemap. Without a Mapbox token we fall back to open raster tiles, so a
 *  missing or dead token degrades the styling and nothing else. */
/**
 * Map sprites, drawn once at runtime.
 *
 * Mapbox cannot render operating-system emoji in a text-field, and the spec
 * asks for bundled sprites anyway so the icons look identical on whichever
 * machine drives the demo. Drawing them into a canvas keeps them dependency
 * free and deterministic.
 */
function makeSprite(draw: (c: CanvasRenderingContext2D, s: number) => void,
  size = 64): ImageData | null {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const c = cv.getContext("2d");
  if (!c) return null;
  draw(c, size);
  return c.getImageData(0, 0, size, size);
}

function registerSprites(m: GLMap) {
  const add = (id: string, img: ImageData | null) => {
    if (img && !m.hasImage(id)) m.addImage(id, img, { pixelRatio: 2 });
  };

  add("pb-tree", makeSprite((c, s) => {
    const k = s / 64;
    c.fillStyle = "#6b4423";
    c.fillRect(s / 2 - 3 * k, s * 0.6, 6 * k, s * 0.3);
    for (const [dx, dy, r, col] of [
      [0, -6, 17, "#2f8f4e"], [-9, 2, 13, "#3da35d"], [9, 2, 13, "#3da35d"],
      [0, 6, 12, "#57b86f"],
    ] as [number, number, number, string][]) {
      c.beginPath();
      c.arc(s / 2 + dx * k, s * 0.42 + dy * k, r * k, 0, Math.PI * 2);
      c.fillStyle = col; c.fill();
    }
  }), );

  add("pb-shelter", makeSprite((c, s) => {
    const k = s / 64;
    c.strokeStyle = "#0f766e"; c.lineWidth = 4 * k;
    c.beginPath();
    c.moveTo(s * 0.16, s * 0.86); c.lineTo(s * 0.16, s * 0.48);
    c.moveTo(s * 0.84, s * 0.86); c.lineTo(s * 0.84, s * 0.48);
    c.stroke();
    c.beginPath();
    c.moveTo(s * 0.08, s * 0.5); c.lineTo(s / 2, s * 0.16);
    c.lineTo(s * 0.92, s * 0.5); c.closePath();
    c.fillStyle = "#14b8a6"; c.fill();
    c.strokeStyle = "#0f766e"; c.lineWidth = 3 * k; c.stroke();
  }));

  // One walker per UTCI band, so colour comes from the sprite rather than
  // from tinting a glyph the renderer will not recolour.
  for (const [id, col] of [
    ["pb-walk-neutral", "#7c8798"], ["pb-walk-cool", "#4aa96c"],
    ["pb-walk-warm", "#f0a13c"], ["pb-walk-hot", "#e8562a"],
    ["pb-walk-severe", "#c81e1e"],
  ] as [string, string][]) {
    add(id, makeSprite((c, s) => {
      const k = s / 64;
      c.strokeStyle = "#ffffff"; c.lineWidth = 9 * k; c.lineCap = "round";
      const body = () => {
        c.beginPath();
        c.arc(s / 2, s * 0.22, 7 * k, 0, Math.PI * 2);
        c.moveTo(s / 2, s * 0.32); c.lineTo(s / 2, s * 0.6);
        c.moveTo(s / 2, s * 0.6); c.lineTo(s * 0.34, s * 0.86);
        c.moveTo(s / 2, s * 0.6); c.lineTo(s * 0.68, s * 0.84);
        c.moveTo(s / 2, s * 0.4); c.lineTo(s * 0.3, s * 0.52);
        c.moveTo(s / 2, s * 0.4); c.lineTo(s * 0.72, s * 0.46);
      };
      body(); c.stroke();
      c.strokeStyle = col; c.lineWidth = 5.5 * k;
      body(); c.stroke();
      c.fillStyle = col;
      c.beginPath(); c.arc(s / 2, s * 0.22, 6 * k, 0, Math.PI * 2); c.fill();
    }));
  }
}

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

/** Published UTCI stress class for a value. Never a renamed percentile. */
function bandName(u: number): string {
  if (u >= 46) return "Extreme Heat Stress";
  if (u >= 38) return "Very Strong Heat Stress";
  if (u >= 32) return "Strong Heat Stress";
  if (u >= 26) return "Moderate Heat Stress";
  return "No Thermal Stress";
}

interface Inspect {
  kind: "agent" | "unit";
  title: string;
  rows: [string, string][];
  note: string;
  sweat?: boolean;
  tone?: "cool" | "warm" | "hot";
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
  const frozenU = useRef(0);

  /**
   * Zoom Easter egg: human-scale cause and effect.
   *
   * Below zoom 16 the map is a planning view and nothing on it is clickable
   * except a street. At 16 and above, after a crash test has run, the walkers
   * and the purchased units become inspectable - one walker's own route time,
   * local UTCI band and accumulated dose, or one unit's actual modelled shade
   * footprint. It reads the returned snapshot and never mutates it: no route,
   * count, optimiser decision or headline number changes.
   */
  const [zoom, setZoom] = useState(14.1);
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const frozen = useRef<number | null>(null);
  const resultRef = useRef<CrashResult | null>(null);
  const adaptedRef = useRef<AdaptResult | null>(null);
  const metaRef = useRef(meta);
  const interactive = useRef(false);

  // The map's event handlers are registered once and outlive every render,
  // so they read the current snapshot through refs rather than through a
  // closure over the props they were created with.
  useEffect(() => {
    resultRef.current = result;
    adaptedRef.current = adapted;
    metaRef.current = meta;
    interactive.current = zoom >= 16 && !!result;
  }, [result, adapted, meta, zoom]);

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
        registerSprites(m);
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
        // A walking figure, not a dot: the layer is about people, and a
        // glyph says so without a legend entry.
        m.addLayer({
          id: "agent-dot", type: "symbol", source: "agents",
          layout: {
            visibility: "none",
            "icon-image": [
              "case",
              ["<", ["get", "utci"], 0], "pb-walk-neutral",
              ["<", ["get", "utci"], 30], "pb-walk-cool",
              ["<", ["get", "utci"], 34], "pb-walk-warm",
              ["<", ["get", "utci"], 38], "pb-walk-hot",
              "pb-walk-severe",
            ],
            "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.3, 15, 0.5, 17, 0.72],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
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
              "shaded_shelter", "#14b8a6", "#34d399"],
            "fill-opacity": ["*", 0.34, ["coalesce", ["get", "bloom"], 0]],
          },
        });
        m.addLayer({
          id: "shade-glow", type: "line", source: "shade-footprints",
          paint: {
            "line-color": ["match", ["get", "kind"],
              "shaded_shelter", "#0d9488", "#22c55e"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 6, 17, 22],
            "line-opacity": ["*", 0.22, ["coalesce", ["get", "bloom"], 0]],
            "line-blur": 12,
          },
        });
        m.addLayer({
          id: "unit-highlight", type: "line", source: "shade-footprints",
          filter: ["==", ["get", "unitId"], "__none__"],
          paint: {
            "line-color": "#0f172a", "line-width": 2.5, "line-opacity": 0.9,
          },
        });
        m.addSource("placed", {
          type: "geojson", data: { type: "FeatureCollection", features: [] },
        });
        m.addLayer({
          id: "placed", type: "symbol", source: "placed",
          layout: {
            "icon-image": ["match", ["get", "kind"],
              "shaded_shelter", "pb-shelter", "pb-tree"],
            // "zoom" must be the top-level input to interpolate, so the pop
            // scale multiplies inside each stop rather than wrapping it.
            "icon-size": ["interpolate", ["linear"], ["zoom"],
              12, ["*", 0.34, ["coalesce", ["get", "pop"], 1]],
              15, ["*", 0.58, ["coalesce", ["get", "pop"], 1]],
              17, ["*", 0.92, ["coalesce", ["get", "pop"], 1]]],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
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

        m.on("zoom", () => setZoom(m.getZoom()));

        // --- the zoom Easter egg ---------------------------------------
        for (const id of ["agent-dot", "placed"]) {
          m.on("mouseenter", id, () => {
            if (interactive.current) m.getCanvas().style.cursor = "pointer";
          });
          m.on("mouseleave", id, () => { m.getCanvas().style.cursor = ""; });
        }

        m.on("click", "agent-dot", (e: any) => {
          if (!interactive.current) return;
          e.originalEvent?.stopPropagation?.();
          const f = e.features?.[0];
          const res = resultRef.current;
          if (!f || !res) return;
          const idx = Number(f.properties.idx);
          const r = agents.current[idx];
          if (!r) return;
          // Freeze this one walker where it stands. Everyone else keeps
          // moving; the model is untouched either way.
          frozen.current = frozen.current === idx ? null : idx;
          const utci = Number(f.properties.utci);
          setInspect(frozen.current === null ? null : {
            kind: "agent",
            title: "One modelled walker",
            rows: [
              ["Route time", `${r.minutes.toFixed(1)} min at ` +
                `${(r.minutes > 0 ? (r.visualDurationMs / 1000) : 0).toFixed(1)} s on screen`],
              ["Local UTCI", utci >= 0 ? `${utci.toFixed(1)} °C · ${bandName(utci)}`
                : "not yet scored"],
              ["Exposure so far",
                `${Number(f.properties.severe).toFixed(2)} severe person-min`],
            ],
            note: "A modelled trip, not an individual medical outcome.",
            sweat: utci >= 38,
          });
        });

        m.on("click", "placed", (e: any) => {
          if (!interactive.current) return;
          e.originalEvent?.stopPropagation?.();
          const f = e.features?.[0];
          const ad = adaptedRef.current;
          const res = resultRef.current;
          if (!f || !ad || !res) return;
          const unitId = String(f.properties.unitId);
          const unit = ad.unit_placements.find((u) => u.unitId === unitId);
          if (!unit) return;
          const i = metaRef.current.seg_ids.indexOf(unit.segmentId);
          const after = i >= 0 ? ad.after_utci_c[i] : res.utci_sun_c;
          const before = i >= 0
            ? res.sun[i] * res.utci_sun_c + (1 - res.sun[i]) * res.utci_shade_c
            : res.utci_sun_c;
          const dim = metaRef.current.footprint_m?.[unit.kind];
          // Highlight the footprint this unit actually casts.
          m.setFilter("unit-highlight", ["==", ["get", "unitId"], unitId]);
          setInspect({
            kind: "unit",
            title: unit.kind === "tree" ? "Street tree" : "Shaded waiting shelter",
            rows: [
              ["Shade footprint", dim
                ? `${dim.along_m} m along the footway × ${dim.across_m} m across`
                : "—"],
              ["Protects", unit.kind === "tree"
                ? "walking time on this segment"
                : `waiting time at ${unit.stopId ?? "this stop"}`],
              ["Segment UTCI", `${before.toFixed(1)} → ${after.toFixed(1)} °C`],
              ["Reaches", bandName(after)],
            ],
            note: unit.kind === "shaded_shelter"
              ? "A shelter covers waiting at its stop. It does not cool the street."
              : "One tree shades its own length of footway, not the whole street.",
            tone: after < 32 ? "cool" : after < 38 ? "warm" : "hot",
          });
        });

        // Clicking empty map clears the inspection.
        m.on("click", (e: any) => {
          if (m.queryRenderedFeatures(e.point,
            { layers: ["agent-dot", "placed"] }).length) return;
          frozen.current = null;
          setInspect(null);
          if (m.getLayer("unit-highlight")) {
            m.setFilter("unit-highlight", ["==", ["get", "unitId"], "__none__"]);
          }
        });

        // Reset contract: cancel animation, clear every feature-state key,
        // and empty every dynamic source. A reset that leaves a halo or a
        // stale agent behind is not a reset.
        registerReset(() => {
          if (raf.current !== null) cancelAnimationFrame(raf.current);
          raf.current = null;
          agents.current = [];
          doses.current = [];
          frozen.current = null;
          setInspect(null);
          if (m.getLayer("unit-highlight")) {
            m.setFilter("unit-highlight", ["==", ["get", "unitId"], "__none__"]);
          }
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
    //
    // The geometry is the engine's: an oriented rectangle covering the
    // footway a tree's crown actually shades, or the roof over a stop. The
    // previous version drew a fixed circle, which is decoration - at this
    // scale it also overstated a shelter by several times its real roof.
    const bloom = adaptStage === "grow" ? stageProgress
      : ["cool", "retest", "land", "complete"].includes(adaptStage) ? 1 : 0;
    const shown_ids = new Set(visible.map((u) => u.unitId));
    foot.setData({
      type: "FeatureCollection",
      features: (adapted.shade_footprints?.features ?? [])
        .filter((f) => shown_ids.has(String(f.properties?.unitId)))
        .map((f) => ({ ...f, properties: { ...f.properties, bloom } })),
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
        // visibly takes longer over the same ground. A frozen walker holds
        // its last position - it is paused for inspection, not rewound.
        const u = frozen.current === i ? frozenU.current : progressAt(r, t);
        if (frozen.current !== i) frozenU.current = u;
        const st = sampleRoute(r, u, result ?? BLANK);
        const dose = (coloured || afterColoured) && doses.current[i]
          ? doseAt(r, doses.current[i], u) : 0;
        return {
          type: "Feature" as const,
          properties: {
            idx: i,
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

      {/* The Easter egg announces itself once it is available, rather than
          being a secret only the author knows about. */}
      {result && zoom >= 16 && !inspect && (
        <div className="pointer-events-none absolute bottom-28 left-1/2
          -translate-x-1/2 rounded-full bg-slate-900/80 px-3 py-1.5
          text-[12px] font-medium text-white shadow-lg">
          Click a walker, a tree or a shelter to inspect it
        </div>
      )}

      {inspect && (
        <div className="pointer-events-auto absolute left-1/2 top-20 z-20
          w-[300px] -translate-x-1/2 rounded-2xl border border-slate-200
          bg-white/96 p-4 shadow-2xl backdrop-blur">
          <div className="flex items-center gap-2">
            {inspect.sweat && (
              <span className="relative flex h-3 w-3" aria-hidden>
                <span className="absolute inline-flex h-full w-full
                  animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full
                  bg-red-500" />
              </span>
            )}
            <h3 className="text-[15px] font-bold tracking-tight text-slate-900">
              {inspect.title}
            </h3>
            <button
              onClick={() => {
                frozen.current = null;
                setInspect(null);
                const m = map.current;
                if (m?.getLayer("unit-highlight")) {
                  m.setFilter("unit-highlight",
                    ["==", ["get", "unitId"], "__none__"]);
                }
              }}
              className="ml-auto text-[13px] text-slate-400 hover:text-slate-800"
            >
              Close
            </button>
          </div>
          <dl className="mt-2 space-y-1">
            {inspect.rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 text-[12.5px]">
                <dt className="shrink-0 text-slate-500">{k}</dt>
                <dd className="text-right font-medium tabular-nums text-slate-900">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {/* Colour follows the computed band and stops where the model
              stops: a unit that only reaches Strong stress is not drawn
              green. */}
          {inspect.tone && (
            <div className={`mt-2 rounded-lg px-2 py-1 text-[11.5px] font-semibold
              ${inspect.tone === "cool" ? "bg-emerald-50 text-emerald-800"
                : inspect.tone === "warm" ? "bg-amber-50 text-amber-800"
                  : "bg-orange-50 text-orange-800"}`}>
              {inspect.tone === "cool"
                ? "Cooled below Strong Heat Stress here"
                : inspect.tone === "warm"
                  ? "Still Strong Heat Stress here — real relief, not safety"
                  : "Still above the severe threshold here"}
            </div>
          )}
          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            {inspect.note}
          </p>
        </div>
      )}
    </div>
  );
}
