"use client";

import { useEffect, useRef } from "react";
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
 * Colour ramp for modelled exposure: low -> elevated -> high -> hotspot.
 * Red is the top of the scale, per the brief. Values are normalised against
 * the *baseline* peak so that an intervention visibly cools the map rather
 * than rescaling itself back to red.
 */
const RAMP: [number, string][] = [
  [0.0, "#2c7bb6"],
  [0.25, "#abd9e9"],
  [0.5, "#ffffbf"],
  [0.75, "#fdae61"],
  [1.0, "#d7191c"],
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
  scaleMax: number;
  hour: Hour;
  layers: {
    shadow: boolean; canopy: boolean; trees: boolean;
    buildings: boolean; trips: boolean;
  };
  onSegmentClick?: (segId: string, index: number) => void;
}

export default function MapView({
  meta, result, adapted, scaleMax, hour, layers, onSegmentClick,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const map = useRef<GLMap | null>(null);
  const ready = useRef(false);
  // Keep our own handle on the segment geometry. Reading it back out of the
  // renderer means touching a private field that Mapbox and MapLibre spell
  // differently, which is exactly the kind of thing that breaks on stage.
  const segGeo = useRef<GeoJSON.FeatureCollection | null>(null);

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
              ["interpolate", ["linear"], ["feature-state", "intensity"],
                ...RAMP.flatMap(([stop, colour]) => [stop, colour])],
              "rgba(0,0,0,0)",
            ],
            "line-width": [
              "interpolate", ["linear"], ["zoom"],
              13, ["+", 1.4, ["*", 2.2, ["coalesce", ["feature-state", "intensity"], 0]]],
              17, ["+", 3.0, ["*", 5.0, ["coalesce", ["feature-state", "intensity"], 0]]],
            ],
            "line-opacity": 0.95,
          },
        });

        // Where the optimiser actually spent the money.
        m.addSource("placed", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
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
    const active = adapted?.exposure ?? result?.exposure;
    const sun = result?.sun;

    if (!active) {
      for (let i = 0; i < meta.seg_ids.length; i += 1) {
        m.setFeatureState({ source: "segments", id: i }, { scored: false, intensity: 0 });
      }
      return;
    }
    const peak = scaleMax || 1;
    for (let i = 0; i < active.length; i += 1) {
      // A segment nobody walks has no exposure to report. Colouring it at the
      // bottom of the ramp would read as "safe" when it really means "no
      // modelled pedestrian demand", so it stays on the grey base layer.
      m.setFeatureState({ source: "segments", id: i }, {
        scored: active[i] > 0,
        intensity: Math.min(1, active[i] / peak),
        exposure: active[i],
        sun: sun?.[i] ?? 0,
      });
    }
  }, [result, adapted, scaleMax, meta.seg_ids.length]);

  // --- highlight where money was spent ------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const src = m.getSource("placed");
    if (!src) return;
    if (!adapted) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const data = segGeo.current;
    if (!data) return;
    const wanted = new Set(adapted.placements.map((p) => p.seg_id));
    src.setData({
      type: "FeatureCollection",
      features: data.features.filter(
        (f) => wanted.has(String((f.properties as Record<string, unknown>).seg_id))),
    });
  }, [adapted]);

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
    for (const h of meta.hours) set(`shadow-${h}`, layers.shadow && h === hour);
  }, [layers, hour, meta.hours]);

  // The renderer stamps .maplibregl-map / .mapboxgl-map onto the container,
  // and both stylesheets set position:relative on it - which would override
  // an `absolute inset-0` here and collapse the map to zero height. So the
  // positioning lives on a wrapper and the container just fills it.
  return (
    <div className="absolute inset-0">
      <div ref={ref} className="h-full w-full" />
    </div>
  );
}
