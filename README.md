# Pittsburnt — a crash test for cities

Cars are crash-tested before people drive them. Pittsburnt stress-tests
**Oakland, Pittsburgh** before residents walk through the next heatwave.

It does not ask "where is Pittsburgh hottest?" It asks **where do people
accumulate the most heat while moving through the city, and what is the
highest-impact intervention per dollar?**

```
CRASH TEST  2035 heatwave · 3 PM · older adults    950 severe person-minutes
ADAPT       $250,000                               208 street trees
RE-TEST     identical scenario                     820  →  −20.7% corridors / −13.6% network
```

**The finding that matters:** at 2035 / 3 PM, a pedestrian in sun is at
**UTCI 38.9 °C — "Very Strong Heat Stress"** — while one in shade is at
35.1 °C, below it. Shade does not shave a percentage off an index; it moves
someone across a published thermal-stress threshold.

And the climate escalation falls out of the data, not out of a slide:

```
Observed hot-day baseline   peak UTCI 36.4 °C   never crosses 38 °C
2035 Heatwave               peak UTCI 38.9 °C   crosses at 1 of 4 hours
2050 Heatwave               peak UTCI 40.8 °C   crosses at 3 of 4 hours
```

## The model

Thermal stress is **UTCI**, computed from air temperature, humidity, wind and
mean radiant temperature. Sun enters through Tmrt, where it physically
belongs: a pedestrian in shade receives diffuse sky radiation, one in sun also
receives the direct beam.

```
Tmrt(segment, hour)  = radiant budget with the direct beam scaled by sun exposure
UTCI(segment, hour)  = f(air temp, humidity, wind, Tmrt)
severe_person_min    = walking minutes + waiting minutes, where UTCI >= 38 °C
```

`sun_exposure` is a *spatial fraction* — how much of a segment is unshaded —
so a walker spends that share of their time in sun and the rest in shade, and
each part is scored on its own UTCI. That is what makes shade act smoothly
rather than as a switch.

Exposure counts **walking and waiting**. Someone at an unshaded bus stop is
standing still and cannot leave, and that is exactly the time a shaded
shelter protects.

The primary metric is **unweighted**. Planning priority for a vulnerable
population is reported beside it, labelled a policy choice, and never folded
into it. UTCI 38 °C is a published thermal-stress class — not a diagnosis,
not a heatstroke probability.

## Quick start

Two terminals:

```bash
make api     # FastAPI engine on :8000
make web     # Next.js frontend on :3000  ->  open http://localhost:3000
```

It opens on a context map with nothing pre-answered. Pick a time, a
population and a future scenario; the walkers start moving as soon as the
first two are set. Then **RUN CRASH TEST**, and the same button morphs into
**ADJUST**.

The frontend works with the API down — it falls back to a precomputed static
bundle in `web/public/data` and says so in the UI.

Set `NEXT_PUBLIC_MAPBOX_TOKEN` in `web/.env.local` for Mapbox styling;
without it the map renders via MapLibre on OpenStreetMap tiles.

### Add a solution (Beta) — optional

The Adjust panel has a Beta side door. A language model drafts a proposed
measure into typed fields and asks for what it could not fill in; a
deterministic gate in `api/solutions.py` then decides whether this engine can
honestly represent that physics. Only a draft that clears the gate, and that
a person confirms, reaches the optimiser — every placement and impact number
in the result is still the engine's.

Any OpenAI-compatible chat endpoint works. To enable it:

```bash
cp .env.example .env          # then fill in the three IFM_ values
set -a; . ./.env; set +a      # export them into this shell
make api
```

```
IFM_BASE_URL=https://…        # the provider's /v1 base URL
IFM_API_KEY=…                 # server-side secret
IFM_MODEL=k2-horizon
```

**These are server-side secrets.** They are read by `api/llm.py` and must
never be given a `NEXT_PUBLIC_` prefix or put in `web/.env.local`, because
anything so prefixed is compiled into the browser bundle and is visible to
everyone who opens the page. `.env` is gitignored; `.env.example` is the only
one committed, and it is empty.

No `pip install` is needed — `api/llm.py` speaks the OpenAI wire format over
stdlib HTTP, so a machine that cannot install packages can still run this.

**On grounding.** A plain chat completion has no retrieval tool, so the model
answers from its weights and cannot show you where a figure came from. Every
claim it marks `sourced` is therefore downgraded to `user_assumption`
server-side, before the panel renders it, and the panel says when that
happened. A recalled number is a suggestion, not a citation.

**Measured against `IFM/K2-Horizon-375B-A23B`**, which is a reasoning model,
and two things follow from that:

- Every call asks for `response_format: json_object`. The same prompt as
  free-form text spent 4,494 completion tokens thinking and took 42 s;
  in JSON mode it finished in 628 tokens and 6.8 s.
- **No `max_tokens` is sent.** The cap is charged against reasoning tokens, so
  the model spends the entire budget thinking and returns *empty* content with
  `finish_reason: "length"` — measured identically at 900, 1,600 and 2,500.
  Unbounded, it stops on its own.

A draft takes roughly 8–20 s. The follow-up questions are a second call on
its own endpoint, because folding them into the draft request took a 7 s
answer to 39 s; the gate's own questions render immediately and the model's
replace them when they arrive.

`make gates-live` drives the whole panel against the configured model.

Without a key nothing breaks. The panel returns cached example drafts that
still demonstrate the whole gate — one measure that can be simulated and
three that honestly cannot, each naming the evidence it is missing — and the
Crash → Adjust → Re-test loop never touches the network.

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
make verify            # 71 assertions over every cached artifact
make test-engine       # 56 engine property tests
make check-determinism # proves the same seed reproduces the same trips
make inspect           # visual QA map of the pipeline's geometry
make gates             # 36 browser release gates (needs api + web running)
```

`make verify` re-opens each artifact cold and checks what downstream code
depends on — that shade sources never double-count, that low sun shades more
than high sun, that hero corridors exist. `make test-engine` asserts the
claims the demo makes on stage: hotter scenarios must score higher, shade
must reduce but never zero exposure, the optimizer must respect its budget,
two purchased trees on one street must be at least 10 m apart on the ground.

`make gates` drives a real browser. It asserts the six things a judge has to
see — an empty start, the 7.5 s crash sequence, people before numbers, three
headline metrics, one CTA that morphs, the 10 s Adjust — plus the reset
contract (no dynamic source feature, no segment feature-state, no running
timer) and that nothing clips at 1366×768 or 1920×1080.

## Data sources

| Layer | Source | Note |
|---|---|---|
| Thermal index | UTCI via `thermofeel` (ECMWF) | Severe threshold 38 °C, the published "Very Strong Heat Stress" class |
| Walking network | OpenStreetMap via OSMnx | Oakland's main streets are `sidewalk=separate`, so corridor names are recovered by matching sidewalks to drive-network centrelines |
| Building heights | OSM 3D `building:part`, `height`, `building:levels`; Allegheny County assessment `STORIES` | 59.5% measured; the rest modelled by type and footprint size. No authoritative height dataset exists for the county — PASDA publishes no DSM |
| Tree canopy | Allegheny County Urban Tree Canopy (Tree Pittsburgh / Univ. of Vermont) | **2010 vintage.** 32% cover. The City street-tree inventory covers only the public right-of-way and yields 0.6% |
| Street trees | City of Pittsburgh tree inventory | Per-tree crown width and height |
| Solar position | pvlib | |
| Observed climate | Open-Meteo archive (ERA5), 2005–2024 | Median diurnal profile of the hottest 5% of summer days |
| Projections | **CMIP6-LOCA2**, 27-model county release (USGS) | 2025–2049 (+1.99 °C) and 2050–2074 (+3.57 °C), paired per model against its own 1981–2010 run. Nothing extrapolated |
| Transit | PRT stop service frequency (WPRDC) + OSM shelter tags | 114 stops, 24 already sheltered; wait = half the headway |

Pedestrian demand is **synthetic**, generated from a fixed seed so the before
and after comparison runs the identical people over the identical geometry.

## What people actually feel

The headline thermal number is **Experienced UTCI**: person-minute-weighted
across walking and waiting, using the sheltered or unsheltered value each
waiting rider actually stood in. It is not the full-sun anchor, and it is not
an unweighted mean over 2,409 street segments — that would let empty kerbs
outvote the corridor everyone is on.

The animated burden counter is **heat load**, which is continuous above
26 °C. Severe exposure is reported beside it as the published-class count.
Both matter: at 3 PM the 2035 and 2050 scenarios have *identical* severe
totals, because the binary 38 °C threshold counts the same sun-exposed
minutes once both cross it. Only heat load can see the difference.

Playback runs at one declared 15× time compression for every persona, with no
minimum duration. A 150 m route therefore takes an older adult 11.1 s on
screen and a student 7.7 s — the difference is the point of the control.
Zoom changes pixels per metre and nothing else; exposure is always computed
in physical minutes.

Trees are bought onto a **candidate-site layer**: sites walked along each
centreline and kept only when at least 10 m from the previous one *in a
straight line*. Measuring along the polyline is not enough — on a curved
street two points 10 m apart along the kerb can be 7.8 m apart on the ground,
which would let two crowns overlap and double-count the person-minutes
underneath them. The shade each unit casts is returned by the engine as an
oriented rectangle, not drawn by the map as a decorative circle.

## Honesty machinery

Every displayed number carries a `ValueMeta` — `source`, `computed` or
`assumption` — with a reference and a confidence class. Four are sourced, six
computed, six assumed; the assumptions (synthetic trips, transit share,
planning weight, unit costs) say so on the number itself.

Every result carries an **input hash** over dataset version, scenario, hour,
persona, budget and intervention set. A cached answer is refused unless that
hash matches the request, so the $250K plan can never appear for a $137,500
budget. The hash is reimplemented in the browser and verified byte-identical
to the Python side.

Building heights carry record-level provenance — source, raw value,
conversion rule, assumed storey height, confidence. A modelled estimate stays
low-confidence and stays out of the measured count; `make verify` fails if
that ever changes.
