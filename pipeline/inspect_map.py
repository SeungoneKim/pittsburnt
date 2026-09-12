"""Visual QA - renders whatever the pipeline has produced so far to one
self-contained HTML file. No token, no server, no build step: open it and
look. Numbers in verify.py can pass while the geometry is quietly wrong, so
this is the other half of supervision.
"""
from __future__ import annotations

import json

import geopandas as gpd

from config import CACHE, CENTER, CORRIDORS, CRS_METRIC, CRS_WGS84

OUT = CACHE / "inspect.html"

TEMPLATE = """<!doctype html><html><head><meta charset="utf-8">
<title>Pittsburnt - pipeline inspection</title>
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<style>
 html,body{margin:0;height:100%;font:13px/1.45 ui-sans-serif,system-ui,sans-serif}
 #map{position:absolute;inset:0}
 #panel{position:absolute;top:12px;left:12px;z-index:2;background:#fff;
   border-radius:10px;padding:14px 16px;box-shadow:0 2px 14px rgba(0,0,0,.18);
   max-width:290px}
 h1{font-size:15px;margin:0 0 2px}
 .sub{color:#666;font-size:11px;margin-bottom:10px}
 .row{display:flex;align-items:center;gap:8px;margin:5px 0}
 .sw{width:22px;height:4px;border-radius:2px;flex:none}
 .n{margin-left:auto;color:#888;font-variant-numeric:tabular-nums;font-size:11px}
 label{display:flex;align-items:center;gap:6px;margin:5px 0;cursor:pointer}
 hr{border:0;border-top:1px solid #eee;margin:10px 0}
 #hint{color:#888;font-size:11px}
 #pop{font:12px ui-monospace,monospace}
</style></head><body>
<div id="map"></div>
<div id="panel">
  <h1>Pipeline inspection</h1>
  <div class="sub">__SUB__</div>
  <div id="legend"></div>
  <hr>
  <label><input type="checkbox" id="corronly"> hero corridors only</label>
  <label><input type="checkbox" id="showcl" checked> road centrelines (grey)</label>
  <label><input type="checkbox" id="showbld" checked> buildings (shaded by height)</label>
  <label><input type="checkbox" id="showmod" checked>
    <span style="border-bottom:2px dashed #e0431f">dash</span> = height is modelled, not measured</label>
  <div id="hint">Click any segment for its properties.</div>
</div>
<script>
const SEGMENTS = __SEGMENTS__;
const BUILDINGS = __BUILDINGS__;
const CENTRELINES = __CENTRELINES__;
const HERO = __HERO__;
const COLORS = __COLORS__;

const map = new maplibregl.Map({
  container:'map',
  style:{version:8,sources:{carto:{type:'raster',
    tiles:['https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png'],
    tileSize:256,attribution:'&copy; OpenStreetMap &copy; CARTO'}},
    layers:[{id:'bg',type:'raster',source:'carto'}]},
  center:__CENTER__, zoom:14.2
});

map.on('load',()=>{
  if(BUILDINGS){
    map.addSource('bld',{type:'geojson',data:BUILDINGS});
    // Height drives the fill ramp; measured vs modelled drives the outline,
    // so you can see at a glance how much of the massing is inferred.
    map.addLayer({id:'bld',type:'fill',source:'bld',paint:{
      'fill-color':['interpolate',['linear'],['get','height_m'],
        3,'#f2efe9', 10,'#dcd6c8', 25,'#b9ad95', 60,'#8e7f63', 120,'#5f523c'],
      'fill-opacity':.85}});
    map.addLayer({id:'bldmod',type:'line',source:'bld',
      filter:['==',['get','height_is_measured'],false],
      paint:{'line-color':'#e0431f','line-width':1,'line-dasharray':[2,2],
             'line-opacity':.9}});
    map.on('click','bld',e=>{
      const p=e.features[0].properties;
      new maplibregl.Popup({maxWidth:'320px'}).setLngLat(e.lngLat)
        .setHTML('<div id="pop">'+Object.entries(p)
          .map(([k,v])=>`<b>${k}</b>: ${v===null?'<i>null</i>':v}`).join('<br>')
        +'</div>').addTo(map);
    });
  }
  map.addSource('cl',{type:'geojson',data:CENTRELINES});
  map.addLayer({id:'cl',type:'line',source:'cl',
    paint:{'line-color':'#b9b9c2','line-width':3,'line-opacity':.55}});

  map.addSource('seg',{type:'geojson',data:SEGMENTS});
  // Colour by hero corridor first, then fall back to walk class.
  const colourExpr = ['case'];
  for(const [name,c] of Object.entries(COLORS.corridor))
    colourExpr.push(['==',['get','corridor'],name], c);
  colourExpr.push(['match',['get','walk_class'],
    ...Object.entries(COLORS.klass).flat(), '#999']);

  map.addLayer({id:'seg',type:'line',source:'seg',
    paint:{'line-color':colourExpr,
      'line-width':['interpolate',['linear'],['zoom'],13,1.6,17,5],
      'line-opacity':.95}});
  // Alternating tint so you can see where one segment ends and the next
  // begins - a single flat colour hides bad splits.
  map.addLayer({id:'segalt',type:'line',source:'seg',
    filter:['==',['%',['to-number',['slice',['get','seg_id'],-1]],2],1],
    paint:{'line-color':'#ffffff','line-width':
      ['interpolate',['linear'],['zoom'],13,.5,17,1.6],'line-opacity':.75}});

  map.on('click','seg',e=>{
    const p=e.features[0].properties;
    new maplibregl.Popup({maxWidth:'320px'}).setLngLat(e.lngLat)
      .setHTML('<div id="pop">'+Object.entries(p)
        .map(([k,v])=>`<b>${k}</b>: ${v===null?'<i>null</i>':v}`).join('<br>')
      +'</div>').addTo(map);
  });
  map.on('mouseenter','seg',()=>map.getCanvas().style.cursor='pointer');
  map.on('mouseleave','seg',()=>map.getCanvas().style.cursor='');

  document.getElementById('corronly').onchange=e=>{
    const f = e.target.checked ? ['in',['get','corridor'],['literal',HERO]] : null;
    map.setFilter('seg', f);
  };
  document.getElementById('showcl').onchange=e=>
    map.setLayoutProperty('cl','visibility',e.target.checked?'visible':'none');
  document.getElementById('showbld').onchange=e=>
    map.setLayoutProperty('bld','visibility',e.target.checked?'visible':'none');
  document.getElementById('showmod').onchange=e=>
    map.setLayoutProperty('bldmod','visibility',e.target.checked?'visible':'none');
});

const leg=document.getElementById('legend');
leg.innerHTML = __LEGEND__.map(([c,label,n])=>
  `<div class="row"><span class="sw" style="background:${c}"></span>${label}<span class="n">${n}</span></div>`
).join('');
</script></body></html>"""

CORRIDOR_COLORS = {
    "Forbes Avenue": "#d7263d",
    "Fifth Avenue": "#1b6ca8",
    "South Craig Street": "#f2a104",
}
CLASS_COLORS = {
    "sidewalk": "#7f8c9b",
    "street": "#2f3b4a",
    "steps": "#9b59b6",
    "service": "#cfd6de",
}


def main() -> None:
    seg = gpd.read_file(CACHE / "segments.geojson")
    cl = gpd.read_file(CACHE / "corridors.geojson")
    bld_path = CACHE / "buildings.geojson"
    bld = gpd.read_file(bld_path) if bld_path.exists() else None

    legend = []
    for name, colour in CORRIDOR_COLORS.items():
        g = seg[seg["corridor"] == name]
        legend.append([colour, name, f"{len(g)} · {g.length_m.sum()/1000:.2f} km"])
    for klass, colour in CLASS_COLORS.items():
        g = seg[seg["walk_class"] == klass]
        legend.append([colour, klass, f"{len(g)} · {g.length_m.sum()/1000:.2f} km"])

    sub = (f"{len(seg)} segments · {seg.length_m.sum()/1000:.1f} km · "
           f"median {seg.length_m.median():.0f} m")
    if bld is not None:
        sub += (f"<br>{len(bld)} buildings · "
                f"{bld.height_is_measured.mean()*100:.0f}% measured height")
        # Simplify to keep the standalone file openable; 0.5 m is far below
        # what matters for a shadow at this scale.
        bld = bld.to_crs(CRS_METRIC)
        bld["geometry"] = bld.geometry.simplify(0.5)
        bld = bld.to_crs(CRS_WGS84)

    html = (TEMPLATE
            .replace("__SEGMENTS__", seg.to_json())
            .replace("__CENTRELINES__", cl.to_json())
            .replace("__BUILDINGS__", bld.to_json() if bld is not None else "null")
            .replace("__HERO__", json.dumps(CORRIDORS))
            .replace("__COLORS__", json.dumps({"corridor": CORRIDOR_COLORS,
                                               "klass": CLASS_COLORS}))
            .replace("__CENTER__", json.dumps([CENTER[1], CENTER[0]]))
            .replace("__LEGEND__", json.dumps(legend))
            .replace("__SUB__", sub))
    OUT.write_text(html)
    print(f"  wrote {OUT}  ({len(html)/1024:.0f} KB)")
    print(f"  open with:  open {OUT}")


if __name__ == "__main__":
    main()
