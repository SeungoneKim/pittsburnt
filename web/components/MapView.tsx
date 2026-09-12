"use client";

import { useEffect, useRef } from "react";

import {
  buildRoutes, doseAt, doseProfile, progressAt, sampleRoute,
} from "@/lib/agents";
import type { AgentRoute } from "@/lib/agents";
import { mapPadding, placePopover, zones } from "@/lib/zones";

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

  // A custom solution gets its own mark in the Beta panel's violet, because
  // drawing a shade sail with the tree sprite would misreport what was built.
  add("pb-custom", makeSprite((c, s) => {
    const k = s / 64;
    c.strokeStyle = "#5b21b6"; c.lineWidth = 4 * k; c.lineCap = "round";
    c.beginPath();
    c.moveTo(s * 0.16, s * 0.88); c.lineTo(s * 0.16, s * 0.44);
    c.moveTo(s * 0.84, s * 0.88); c.lineTo(s * 0.84, s * 0.44);
    c.stroke();
    // A slack sail between the posts, not a flat roof.
    c.beginPath();
    c.moveTo(s * 0.10, s * 0.44);
    c.quadraticCurveTo(s * 0.5, s * 0.12, s * 0.90, s * 0.44);
    c.quadraticCurveTo(s * 0.5, s * 0.34, s * 0.10, s * 0.44);
    c.closePath();
    c.fillStyle = "#8b5cf6"; c.fill();
    c.strokeStyle = "#5b21b6"; c.lineWidth = 3 * k; c.stroke();
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

/** Which mark a purchased unit is drawn with. */
function spriteFor(kind: string): string {
  if (kind === "shaded_shelter") return "pb-shelter";
  if (kind === "tree") return "pb-tree";
  return "pb-custom";          // anything a person added themselves
}
function tintFor(kind: string): string {
  if (kind === "shaded_shelter") return "#14b8a6";
  if (kind === "tree") return "#34d399";
  return "#a78bfa";
}
function glowFor(kind: string): string {
  if (kind === "shaded_shelter") return "#0d9488";
  if (kind === "tree") return "#22c55e";
  return "#7c3aed";
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
  /**
   * How many visible agents are currently in severe heat, out of how many are
   * drawn. A property of this frame and these representative icons - never a
   * population rate, and never the severe-exposure metric, which is
   * accumulated person-minutes and has no headcount in it at all.
   */
  onVisibleSevere?: (inSevere: number, total: number) => void;
  onSegmentClick?: (segId: string, index: number) => void;
}

export default function MapView({
  meta, result, adapted, hour, layers, persona, crashStage, adaptStage,
  stageProgress, placedFraction, registerReset, onSegmentClick,
  onVisibleSevere,
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
  // Reported on a timer, not every frame: at 60 fps a live count flickers
  // between adjacent integers and reads as noise.
  const lastReport = useRef(0);
  const report = useRef(onVisibleSevere);
  // The animation loop outlives every render, so it reads the current
  // callback through a ref rather than closing over the one it was born with.
  useEffect(() => { report.current = onVisibleSevere; }, [onVisibleSevere]);
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
        // A backplate under every walker.
        //
        // The sprite carries a white stroke, but at demo icon sizes that
        // stroke is roughly a pixel and disappears against a pale road or a
        // red thermal line - which is why the map read as empty. An opaque
        // circle behind the glyph gives it a silhouette that survives any
        // background, and it is a separate layer so it scales with zoom
        // independently of the icon.
        m.addLayer({
          id: "agent-shadow", type: "circle", source: "agents",
          layout: { visibility: "none" },
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"],
              12, 4, 15, 7, 17, 10],
            "circle-color": "rgba(255,255,255,0.92)",
            "circle-stroke-color": "rgba(15,23,42,0.45)",
            "circle-stroke-width": 1.2,
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
            // Roughly a third larger than 2.6 at every stop: the walkers are
            // the subject of this layer and were being lost in the ramp.
            "icon-size": ["interpolate", ["linear"], ["zoom"],
              12, 0.42, 15, 0.68, 17, 0.92],
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
            "fill-color": ["coalesce", ["get", "tint"], "#34d399"],
            "fill-opacity": ["*", 0.34, ["coalesce", ["get", "bloom"], 0]],
          },
        });
        m.addLayer({
          id: "shade-glow", type: "line", source: "shade-footprints",
          paint: {
            "line-color": ["coalesce", ["get", "glow"], "#22c55e"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 6, 17, 22],
            "line-opacity": ["*", 0.22, ["coalesce", ["get", "bloom"], 0]],
            "line-blur": 12,
          },
        });
        m.addSource("placed", {
          type: "geojson", data: { type: "FeatureCollection", features: [] },
        });
        m.addLayer({
          id: "placed", type: "symbol", source: "placed",
          layout: {
            // The sprite is chosen per unit when the features are built, so a
            // kind the map has never heard of - a custom solution - still
            // draws as itself instead of falling through to a tree.
            "icon-image": ["coalesce", ["get", "sprite"], "pb-tree"],
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

        // At most one contextual popup, and it opens inside the strip the
        // panels leave free. Letting the renderer pick an anchor put it under
        // the result card at 1366x768 - the one width the demo is shown at.
        const popup = new GL.Popup({
          closeButton: true, closeOnClick: true, maxWidth: "260px",
        });
        m.on("click", "segments", (e: any) => {
          const f = e.features?.[0];
          if (!f) return;
          const { safe } = zones(window.innerWidth, window.innerHeight);
          const want = placePopover(
            { x: e.point.x, y: e.point.y }, { w: 260, h: 130 },
            window.innerWidth, window.innerHeight);
          // A popup the shared rule had to move opens on the side it was
          // moved to, rather than fighting the renderer's own anchor.
          popup.options.anchor = want.y + want.h <= e.point.y ? "bottom"
            : want.x > e.point.x ? "left"
              : want.x + want.w < e.point.x ? "right" : "top";
          void safe;
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
          // Recentre on the visible strip, not on the window behind the
          // panels, so "reset" does not park Oakland under the result card.
          m.easeTo({
            center: [meta.center.lon, meta.center.lat], zoom: 14.1,
            padding: mapPadding(), duration: 600,
          });
        });

        // People sit above the roads they walk on. The thermal ramp and the
        // hotspot halo are drawn after the agent layers are created, so the
        // agents are lifted back to the top once every layer exists.
        for (const id of ["agent-halo", "agent-shadow", "agent-dot"]) {
          if (m.getLayer(id)) m.moveLayer(id);
        }

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
          properties: { kind: u.kind, pop, unitId: u.unitId,
            sprite: spriteFor(u.kind) },
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
        .map((f) => {
          const kind = String(f.properties?.kind);
          return { ...f, properties: { ...f.properties, bloom,
            tint: tintFor(kind), glow: glowFor(kind) } };
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
    set("agent-shadow", layers.agents);
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
        const u = progressAt(r, t);
        const st = sampleRoute(r, u, result ?? BLANK);
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
      if (now - lastReport.current > 500) {
        lastReport.current = now;
        const hot = features.filter(
          (f) => f.properties.utci >= meta.severe_threshold_utci_c).length;
        report.current?.(hot, features.length);
      }
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
