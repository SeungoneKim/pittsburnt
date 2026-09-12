# Pittsburnt — a crash test for cities

Cars are crash-tested before people drive them. Pittsburnt stress-tests
**Oakland, Pittsburgh** before residents walk through the next heatwave.

It does not ask "where is Pittsburgh hottest?" It asks **where do people
accumulate the most heat while moving through the city, and what is the
highest-impact intervention per dollar?**

```
CRASH TEST  2035 heatwave · 3 PM · older adults    2,082 at-risk pedestrian-minutes
ADAPT       $250,000                               208 street trees
RE-TEST     identical scenario                     1,974   →  −5.2%
```

## The model

```
effective heat index = HI(scenario, hour) + 8 °C × sun_exposure(segment, hour)
exposure(segment)    = severity(effective HI) × minutes(segment, persona, hour)
                                              × planning_weight(persona)
```

Sun raises the *heat index* rather than scaling the score, because the NWS
Heat Index is a shade measure and full sun adds roughly 8 °C to apparent
temperature. Multiplying by sun exposure directly — as a literal reading of
the brief suggests — would make a fully shaded street score exactly zero and
any intervention look infinitely effective. Here, shading the entire network
still leaves 1,250 of 2,082 at-risk pedestrian-minutes.

The output is a **modelled Heat Exposure Score in At-risk Pedestrian
Minutes**: a relative measure for comparing the same city before and after an
intervention. It is not a medical forecast and not a heatstroke probability.

## Quick start

Two terminals:

```bash
make api     # FastAPI engine on :8000
make web     # Next.js frontend on :3000  ->  open http://localhost:3000
```

Then: pick a time / population / scenario, hit **RUN CRASH TEST**, then
**ADAPT PITTSBURGH**.

The frontend works with the API down — it falls back to a precomputed static
bundle in `web/public/data` and says so in the UI.

Set `NEXT_PUBLIC_MAPBOX_TOKEN` in `web/.env.local` for Mapbox styling;
without it the map renders via MapLibre on OpenStreetMap tiles.

## Rebuilding the data

Each step caches its artifacts, so steps only re-run when you want them to.

`make pipeline` runs everything in order, or run a single step:

```bash
make step1   # OSM walk graph → 2,409 corridor-labelled segments
make step2   # building footprints + tiered height estimates
make step3   # shadows at 8/12/15/18 → sun exposure
make step4   # tree canopy raster → final sun exposure
make step5   # 1,493 deterministic synthetic trips across 5 personas
make step6   # observed hot day + CMIP6 ensemble → heat scenarios
make step8   # static fallback bundle for the web app
```

You do not need to run these to demo: every artifact they produce is
committed, so a fresh clone can go straight to `make api` / `make web`.

## Supervising the work

```bash
make check             # verify + test-engine together
make verify            # 50 assertions over every cached artifact
make test-engine       # 13 engine property tests
make check-determinism # proves the same seed reproduces the same trips
make inspect           # visual QA map of the pipeline's geometry
```

`make verify` re-opens each artifact cold and checks what downstream code
depends on — that shade sources never double-count, that low sun shades more
than high sun, that hero corridors exist. `make test-engine` asserts the
claims the demo makes on stage: hotter scenarios must score higher, shade
must reduce but never zero exposure, the optimizer must respect its budget.

## Data sources

| Layer | Source | Note |
|---|---|---|
| Walking network | OpenStreetMap via OSMnx | Oakland's main streets are `sidewalk=separate`, so corridor names are recovered by matching sidewalks to drive-network centrelines |
| Building heights | OSM 3D `building:part`, `height`, `building:levels`; Allegheny County assessment `STORIES` | 59.5% measured; the rest modelled by type and footprint size. No authoritative height dataset exists for the county — PASDA publishes no DSM |
| Tree canopy | Allegheny County Urban Tree Canopy (Tree Pittsburgh / Univ. of Vermont) | **2010 vintage.** 32% cover. The City street-tree inventory covers only the public right-of-way and yields 0.6% |
| Street trees | City of Pittsburgh tree inventory | Per-tree crown width and height |
| Solar position | pvlib | |
| Observed climate | Open-Meteo archive (ERA5), 2005–2024 | Median diurnal profile of the hottest 5% of summer days |
| Projections | CMIP6 downscaled, 7-model ensemble via Open-Meteo | 2035 uses the 2025–2049 window; 2050 is a trend extrapolation past the source's cutoff |
| Heat index | NWS Rothfusz regression | Spot-checked against the published table |

Pedestrian demand is **synthetic**, generated from a fixed seed so the before
and after comparison runs the identical people over the identical geometry.
