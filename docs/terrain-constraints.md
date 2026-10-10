# Constrained physical frontage layouts

This additive fork extension tracks
[exterkamp/kriegsspiel#138](https://github.com/exterkamp/kriegsspiel/issues/138).
`constrained-frontage-v1` is a generic local layout solver behind the physical
`createSettlementModel` village boundary. It consumes an external terrain and
water authority. It does not generate elevation, import Kriegsspiel, use the
experimental `src/terrain/` modules, read a clock, or use ambient random draws.

Calls without `constraints` retain the existing physical village/city and legacy
village/city pipelines and draw sequences. The independent constrained path
reuses the reviewed dwelling deck, seating, glyph dimensions and census
allocation primitives, with a bounded street/frontage solver. It does not
generate an unconstrained village and delete already allocated houses.

## Public seam

```ts
createConstrainedSettlementModel(
  input: AzgaarBurgInput,
  options: SettlementOptions,
): ConstrainedSettlementResult;

validateConstrainedSettlementModel(
  input: AzgaarBurgInput,
  options: SettlementOptions,
  model: SettlementModel,
): ConstrainedSettlementResult;
```

`SettlementOptions` adds `constraints?: SettlementConstraints` and
`landscape?: boolean`. The ordinary physical function delegates when constraints
are supplied. It returns the model on success and throws
`SettlementConstraintError` on expected infeasibility; `error.result` contains
the same structured failure as the result API. Prefer the result API when
composition needs to account for failed attempts. `planSettlement` uses the same
physical boundary and therefore cannot render a failed constrained result.

Both result branches carry `work`, `population` and structured `diagnostics`.
Only success carries `model`. Every diagnostic has `code`, `stage`, `message`
and, where applicable, `featureId`. Invalid descriptors/types/topology throw
contextual `TypeError`; unexpected authority exceptions propagate unchanged.
They are not converted into unsuitable candidates. Resource exhaustion always
terminates the stage with `CONSTRAINT_RESOURCE_LIMIT`, including exhaustion
inside a callback. It is never silently skipped as an unsuitable crossing.

The constrained context requires an explicit safe-integer seed, version `1`,
terrain identity, finite bounds, a permissible polygon with holes, exclusion
polygons, identified water with grouped polygons/holes, exact entrances,
explicit crossing authority and both complete certifiers. Callback functions
are ephemeral; the composing engine records their terrain identity, versions,
recipe and source provenance rather than serializing functions.

```ts
certifyFootprint(request: FootprintRequest, budget: ConstraintBudget):
  { ok: boolean; maxGradient?: number; code?: string; message?: string };
certifyCorridor(request: CorridorRequest, budget: ConstraintBudget):
  { ok: boolean; maxGrade?: number; code?: string; message?: string };
heightAt?(point: ScenePoint, budget: ConstraintBudget): number;
```

Successful certificates must provide finite nonnegative maxima. A footprint
certificate covers the entire supplied polygon, including all clipped terrain
cells and interior extrema; checking its anchor or corners is insufficient.
A corridor certificate covers the entire reserved corridor, directional grade
through every terrain seam/interior extremum, and any supplied deck surface and
abutment continuity. Point height is optional routing cost only. The fork never
invents a second numerical height/gradient implementation or certifies an opaque
callback's mathematics. The composition gate must independently validate that
authority and the final world geometry.

Requests are detached and recursively frozen. The callback budget's `take`
charges the same caller-owned stage meter; callbacks must reserve their actual
sample/index preparation, geometric/numerical traversal and allocation work
before doing it. The fork charges request/result descriptor traversal and
request copying before invoking the authority. An outer composer must also
accumulate `result.work.total` on failures and successes across place retries;
one fresh per-place result does not reset the whole-map budget.

## Coordinates and entrances

Coordinates and widths are local metres: **x east, y south**, with heights
supplied by the external authority (**z up**). Bearings are compass degrees,
north `0`, increasing clockwise. This local output makes no RFC 7946 claim.
The existing scene scale remains exactly one metre per unit.

A world adapter transforms a local point by `world = origin + R * local`, and
queries authoritative height there. If it also exposes gradients, the local
gradient is `Rᵀ * worldGradient`. Transform every footprint/corridor vertex and
the exact entrance direction, rather than assuming axis-aligned world bounds or
using a circular entry radius. No such battlefield adapter is implemented in
this fork.

Each entrance preserves its `id`, ordered unique `routeIds`, exact supplied
`endpoint`, `bearingDeg`, reserved `widthM`, `surfaceWidthM` and `setbackM`.
The initial inward approach has length `widthM / 2 + planningSpacingM`; its
endpoint is computed along the supplied bearing, never projected onto a circle.
Computed lattice/approach intersections and ink-footprint vertices use decimal
six rounding. Supplied entrance endpoints retain their original numeric values.
Final certificates run after this rounding and graph planarization.

The default join tolerance is `0.01 m` (configurable down to zero). Final graph
endpoints share exact numeric coordinates. The bearing cross-component divided
by segment length must be at most `1e-6`, and the approach must point inward.
The external complete certificate can impose a stricter join/grade policy.

Reserved corridor containment has one explicit entrance exception. Outer
boundary overflow may be clipped only inside the finite entrance mouth swept
inward by `widthM / 2 + joinToleranceM`, at that entrance's reserved width.
This handles oblique and corner arrivals. The exemption follows approach
subsegments through planarization. **Permissible holes, exclusions and water
are never clipped away by this exception**, including closed boundary contact.
Road containment elsewhere and all building containment remain complete.

## Placement, streets and population

- `village` and `farm` require at least one supplied entrance. The deterministic
  four-neighbour A* lattice joins every entrance into a real graph and grows
  bounded connected frontage rows. Unsuitable rows are discarded before lots
  and census allocation; failed searches never return a truncated successful
  network. Stable numeric/ID ties do not depend on timing or callback order.
- `isolated` without entrances tests a single centred ordinary dwelling.
  With entrances it seats at most one ordinary dwelling on certified frontage.
  Demand above that dwelling's declared capacity is explicit infeasibility.
  A required temple without streets is `UNSUPPORTED_ISOLATED_LANDMARK`.
- Every seated dwelling and every attempted slide uses its actual final glyph
  bearing and ink dimensions. The whole footprint must lie in permissible land,
  avoid every exclusion/water polygon and satisfy the complete foundation
  gradient certificate. Overlapping houses and reserved street/setback intrusion
  reject before capacity is counted. Required temples use the same checks.
- Every non-isolated roadside building records an actual street ID and an
  independently certified `0.8 m` access corridor from its footprint boundary
  to a point on that street. Access corridors are structured metadata, not
  decorative street rendering; their final geometry is rechecked. An isolated
  dwelling without streets must have null street/access references.
- The solver performs no smoothing, post-placement relaxation, circular approach
  reshaping or landscape dressing. Final emitted roads, access paths, symbols,
  building accounts and bridge geometry are compared against their provenance
  and recertified. An independent graph walk checks every required entrance and
  all emitted streets. A malformed/disconnected graph is not successful merely
  because a candidate search once found a path.
- Housing capacity is the declared ordinary `edgeOccupancy` (default `4`) and
  is fixed before allocation. Required temple capacity is zero. The validator
  independently resolves the declared development and seed rather than trusting
  model capacity claims. Allocation preserves requested/assigned/capacity/
  unassigned totals. `POPULATION_CAPACITY` reports the complete suitable supply
  and shortfall; it returns no model and does not enlarge glyphs or occupancy.
  Failure population counts describe the evaluated supply, not an accepted
  partial settlement. Before validated input, resource failures carry zero
  population evidence.

Constrained city, walls, port, citadel, plaza, shanty and trade-specific layouts
are explicitly unsupported. Temple and ordinary village/farm/isolated dwelling
footprints are supported. There is no claim of complete feasibility for every
terrain/site: four-neighbour routing, coarse frontage rows and finite slide
attempts can return named bounded infeasibility on a physically feasible site.

## Water, crossings and output parity

Water identity and polygon grouping/holes remain in `model.constraints.water`
and `scene.layers.water.polygons`; flattened rendering rings remain paired with
their grouping. All water is supplied authority, never synthetic decorations.

Only a supplied `ConstraintCrossing` can authorize water traversal. It contains
water ID, exact endpoint pair, complete reserved deck polygon, reserved width,
linear endpoint-height profile and minimum dry abutment length. A complete
external certificate must validate the physical deck and connectors. The fork
checks profile finiteness and grade, exact span identity, full transverse wet
corridor coverage, and closed endpoint dry disks of radius
`widthM / 2 + minimumAbutmentM`. Tangency is wet; a `1 µm` positive clearance
passes the analytic disk test. Wrong/missing water identity, partial/narrow
decks, deck holes, wet caps and orphan links reject. No inferred ford or bridge
is emitted. Unusable crossing proposals may be skipped; a required network
that then cannot connect fails explicitly.

Ordinary reserved corridors use circumscribed 32-sided round caps enlarged by
`2 µm`. Their radial overestimate is `(radius + 2 µm) / cos(π / 32) - radius`,
which is conservative and can reject a tightly fitting feasible corridor.
Canonical supplied bridge decks use an exact rectangular reserved strip plus
analytic round endpoint disks, avoiding widening the accepted deck authority.
Deck endpoints have dry outward lattice connectors; no ground edge may join
the interior of a canonical deck. Final bridge/link membership is reciprocal.

`model.constraints` records version, terrain identity, mode, nodes, streets,
exact entrances, bridge authorities/linked street and route IDs, water grouping,
actual dwelling transform/access evidence, diagnostics and deterministic work.
Street/node identities derive from normalized local geometry; building IDs
derive from stable lot/run slots. They do not hash the settlement name. Route
IDs preserve supplied external identity through actual graph walks and crossings.
Geometry-dependent local IDs may change when the recipe/site/entrances change;
the composing engine retains geometry-independent place IDs separately.

The physical exporter emits stable constrained street IDs, separate reserved/
surface widths/setbacks, exact **unwalled** entrance Point features, bridge
water/link/profile properties and detached constrained metadata. Ordinary
exports remain unchanged. Scene building/symbol/road/bridge cardinality,
identity, coordinates, orientation, scales and associations must equal the
certified evidence. Duplicate scene feature IDs cannot hide unchecked export
geometry behind a Map lookup. Glyph scale must remain uniform because the ink
extent calculation assumes that scale. District boundaries are administrative
outlines, not occupied or dry building footprints.

`landscape:false` at the physical boundary skips both field/vegetation creation
and dressing's road/bounds mutations. Pure water grouping still runs for an
ordinary physical call. Constrained calls always skip dressing and reject
`landscape:true`; their landscape layers are empty. The outer battlefield owns
cover and agriculture. Glyph artwork is presentation; authoritative occupied
geometry is the conservative ink rectangle, not its transparent art box.

## Defaults and bounds

Context defaults are `mode:'village'`, local reserved width `4 m`, surface width
`2.4 m`, setback `0.3 m`, planning lattice `5 m`, frontage spacing `7 m`,
street-row spacing `18 m` and join tolerance `0.01 m`. Foundation and road grade
limits are required caller values, not hidden terrain defaults. Seed streams
hash the complete safe-integer seed string with the version and `deck` or
`dwellings` stage name, then feed the existing seeded RNG. High seed bits are
not silently discarded. Routing draws neither stream.

`DEFAULT_CONSTRAINT_LIMITS` is frozen; supplied limits can lower these hard
bounds. No runtime cap is silently raised to make a result succeed.

| Limit                              | Default/hard ceiling |
| ---------------------------------- | -------------------: |
| Input descriptor/value nodes       |              100,000 |
| Input/snapshot point records       |               10,000 |
| Vertices in one grouped polygon    |                  256 |
| Planning lattice and special nodes |               10,000 |
| Expansions per A* route            |               10,000 |
| Expansions across all routes       |              100,000 |
| Placement/slide attempts globally  |               10,000 |
| Attempts per candidate building    |                    5 |
| Actual buildings                   |                1,000 |
| Output feature copies              |               20,000 |
| Output coordinate copies           |              100,000 |
| Aggregate deterministic work units |           20,000,000 |

Caps compose: input/snapshot validation and the work cap may bind before an
output ceiling. Input depth is at most 32 and each string at most 8,192 code
units. Only plain objects/ordinary dense arrays and declared callback slots
are accepted. Accessors, hidden properties, symbols, custom array prototypes,
sparse arrays and cyclic graphs reject without invoking getters. Bounded scalar
limits are inspected by descriptors before the complete traversal: `maxWork:1`
returns work `1` without inspecting permissible-ring descriptors.

Lattice size and route arrays are reserved before allocation. Heap operations,
candidate ranking, polygon pair/topology work, descriptor traversal, copies,
placement attempts and authority calls share the meter. Polygon operations
reserve a conservative squared input-vertex bound before the existing overlay
library. Broad-phase separation avoids overlays on irrelevant distant shapes.
Output metadata/scene feature and coordinate copies are reserved before
insertion. Work is deterministic accounting, not elapsed milliseconds.
The composer should supply a bounded local water window with preserved identities
and grouping, retaining everything relevant to complete footprints/corridors,
entrance mouths and full crossing abutment disks.

## Focused evidence and handoff boundary

Commands below run with the Kriegsspiel root as shell cwd; `npm --prefix` selects
the existing fork tools. No dependencies were installed.

- `npm --prefix .local/settlemaker test -- tests/settlement-constraints.test.ts`:
  **18 tests passed**, 1.67 s command duration / 541 ms test time. Corpus covers 300 residents/100 m village, 12 residents/
  25 m farm, isolated capacity/temple rejection, plane hillside, edge/enclosed
  water/dry holes, concave bounds/exclusions, reserved shoulders/caps, bilinear
  hump/directional grade, exact asymmetric/near-parallel entrances, actual
  bridge use/missing/narrow/partial/tangent authority, complete interior oracle,
  smoothing/scene/symbol/access/capacity forgeries, getters, callback errors,
  immutable inputs, deterministic repeats and aggregate limits.
- `npm --prefix .local/settlemaker test -- tests/settlement-plan.test.ts tests/settlement-approaches.test.ts tests/settlement-engine.test.ts tests/village/road-cross-section.test.ts`:
  **38 tests passed / four files**, 15.33 s command duration (25.70 s summed
  concurrent test time). Existing assertions and timer-yield harness unchanged.
- `npm --prefix .local/settlemaker run build`: focused TypeScript build passed.
  Shared checkout build artifacts are local inspection only; protected prototype
  source is excluded from the accepted source/archive.
- `node_modules/.bin/prettier --ignore-path /dev/null --check .local/settlemaker/src/settlement/constraints .local/settlemaker/tests/settlement-constraints.test.ts .local/settlemaker/docs/terrain-constraints.md`:
  all matched new owned files pass. The explicit ignore-path is needed because
  the root tooling normally ignores `.local`.
- `git -C .local/settlemaker diff --check`: passed. The working-tree diff also
  contains protected/coordinator changes; this check does not claim ownership
  or acceptance of them.

One focused compiled probe after the final build produced:

| Fixture                                | Seed | Requested / assigned / capacity | Buildings / streets / crossings |      Work | Time (ms) |
| -------------------------------------- | ---: | ------------------------------- | ------------------------------- | --------: | --------: |
| Flat, 100 m square                     |   17 | 300 / 300 / 300                 | 75 / 156 / 0                    | 3,842,058 |   123.574 |
| Farm, 25 m square                      |   17 | 12 / 12 / 12                    | 3 / 6 / 0                       |    90,502 |     6.182 |
| Plane hillside, 100 m square           |   31 | 100 / 100 / 100                 | 25 / 169 / 0                    | 2,049,932 |    53.367 |
| River, 100 m square, both banks joined |   97 | 20 / 20 / 20                    | 5 / 160 / 1                     | 1,912,678 |    58.364 |

All four returned no diagnostics and zero unassigned residents. Heap changes
were respectively `7.993`, `-3.298`, `7.142`, `5.169 MiB`; these are one
observational process sample, affected by garbage collection, **not peak-memory
bounds or a whole-map resource gate**. Exact work, not timing, is the budget.
Three fresh Node processes produced identical result fingerprint
`23951dc6bb2ed5b2441640f5aa11bd3f0843656ee495f25d19745acf8025c941`.
`Date.now` and `Math.random` threw if read; the third process first generated a
different settlement. This fingerprint identifies this analytical result, not
a source archive or consumed package artifact. Exact root-cwd probe command:

```sh
node --input-type=module <<'JS'
import { createConstrainedSettlementModel as generate } from './.local/settlemaker/dist/settlement/constraints/index.js';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
function square(x,y,w,h=w){return {outer:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}],holes:[]};}
function context(extent=100){return {version:1,terrainIdentity:'analytical-v1',bounds:{min_x:0,min_y:0,max_x:extent,max_y:extent},permissible:square(0,0,extent),water:[],exclusions:[],crossings:[],entrances:[{id:'north',routeIds:['regional:north'],endpoint:{x:extent/2,y:0},bearingDeg:0,widthM:12,surfaceWidthM:6,setbackM:.3}],maxRoadGrade:.1,maxFoundationGradient:.15,certifyFootprint:()=>({ok:true,maxGradient:0}),certifyCorridor:()=>({ok:true,maxGrade:0})};}
const base={name:'Probe',population:300,biome:'temperate',walls:false,port:false,citadel:false,plaza:false,temple:false,shanty:false,capital:false};
const options=(c,seed)=>({seed,development:{preset:'village'},landscape:false,constraints:c});
const flat=context(),farm=context(25);farm.mode='farm';
const hills=context();hills.heightAt=p=>.03*p.x-.07*p.y;hills.certifyFootprint=()=>({ok:true,maxGradient:Math.hypot(.03,.07)});hills.certifyCorridor=req=>{const[a,b]=req.path,l=Math.hypot(b.x-a.x,b.y-a.y);return {ok:true,maxGrade:Math.abs(.03*(b.x-a.x)-.07*(b.y-a.y))/l};};
const river=context();river.water=[{id:'river',polygons:[square(45,0,10,100)]}];river.entrances=[{id:'west',routeIds:['regional:west'],endpoint:{x:0,y:50},bearingDeg:270,widthM:12,surfaceWidthM:6,setbackM:.3},{id:'east',routeIds:['regional:east'],endpoint:{x:100,y:50},bearingDeg:90,widthM:12,surfaceWidthM:6,setbackM:.3}];river.crossings=[{id:'bridge',waterId:'river',endpoints:[{x:35,y:50},{x:65,y:50}],deck:square(29,44,42,12),widthM:12,endpointHeightsM:[10,10],minimumAbutmentM:3}];
for(const [name,c,seed,pop] of [['flat',flat,17,300],['farm',farm,17,12],['hills',hills,31,100],['river',river,97,20]]){const start=performance.now(),heap=process.memoryUsage().heapUsed;const r=generate({...base,population:pop},options(c,seed));console.log(JSON.stringify({name,seed,ok:r.ok,diagnostics:r.diagnostics,population:r.population,work:r.work,buildings:r.ok?r.model.buildings.length:0,streets:r.ok?r.model.constraints.streets.length:0,crossings:r.ok?r.model.constraints.crossings.length:0,ms:+(performance.now()-start).toFixed(3),heapDeltaMiB:+((process.memoryUsage().heapUsed-heap)/1048576).toFixed(3)}));}
const url=pathToFileURL(resolve('.local/settlemaker/dist/settlement/constraints/index.js')).href;
const code=`import {createConstrainedSettlementModel as generate} from ${JSON.stringify(url)};import{createHash}from'node:crypto';const square=${square.toString()},context=${context.toString()},base=${JSON.stringify(base)};Date.now=()=>{throw new Error('clock')};Math.random=()=>{throw new Error('ambient random')};const opt=seed=>({seed,development:{preset:'village'},landscape:false,constraints:context()});EXTRA;const r=generate(base,opt(17));if(!r.ok)throw new Error(JSON.stringify(r.diagnostics));process.stdout.write(createHash('sha256').update(JSON.stringify(r)).digest('hex'));`;
const hashes=[false,false,true].map(extra=>execFileSync(process.execPath,['--input-type=module','-e',code.replace('EXTRA',extra?'generate({...base,population:12},opt(7))':'')],{encoding:'utf8',timeout:20000}));console.log(JSON.stringify({freshProcesses:3,clockAndRandomDisabled:true,priorOtherSettlementInThird:true,hashes,equal:new Set(hashes).size===1}));
JS
```

Independent read-only source review closed the canonical bridge-width,
capacity/seed authority, local access, descriptor-before-budget, isolated temple,
symbol/bridge parity, high seed bits, duplicate feature and entrance-hole
exception findings. Final glyph aspect parity has its additional regression.
The coordinator's provisional clean-source mirror built and matched all 16
existing four-API seeds `2/7` flat/water fixture canonical hashes and diagnostics
against the original `d5cf3590...` assessment. That mirror was provisional;
the coordinator must refresh the exact final owned patch and run the pristine
full suite, artifact geometry checks and source pin acceptance before claiming F.

No fork source commit, archive SHA or consumed package integrity is asserted by
these focused checks. The coordinator owns the public index export hunk,
NOTICE/build helper/package changes, exact fork pin, source snapshot, full
corresponding-source retrieval and PR linkage. For an archive without Git,
the coordinator-owned browser build helper requires:

```sh
SETTLEMAKER_SOURCE_REVISION=<accepted-full-40-character-fork-commit> npm run build:lib
```

Run that command in the accepted pristine archive, using the actual accepted
revision. Package banner provenance is not an artifact hash. Preserve GPL-3.0
LICENSE, original notices, the dated fork NOTICE addition, manifest/lock,
TypeScript configuration and build inputs with corresponding source. Local
development/source review does not authorize combined Kriegsspiel distribution;
that remains gated under the coordinator's licensing/source strategy.

## Change note, 2026-10-10

Added the versioned generic constrained frontage/result/validation seam; exact
unwalled joins and crossing provenance; whole transformed footprint, reserved
corridor and population acceptance; bounded deterministic routing/placement;
descriptor-safe inputs; physical landscape opt-out with water grouping; and the
focused regression corpus. Unconstrained APIs remain the compatibility boundary.
