import type { AzgaarBurgInput } from '../../input/azgaar-input.js';
import { Point } from '../../types/point.js';
import type { SettlementModel } from '../model.js';
import type { SettlementOptions } from '../generate.js';
import { resolveDevelopment } from '../development.js';
import { hasGlyph, nominalFootprint } from '../../village/glyphs.js';
import { FIT_MIN, FIT_MAX, SIZE_JITTER } from '../../village/constants.js';
import { resolveGlyphFor } from '../../village/deck.js';
import { allocateResidents } from '../model.js';
import type { SettlementConstraints } from './types.js';
import { CONSTRAINT_VERSION } from './types.js';
import { Work } from './budget.js';
import { detach, preflight } from './input.js';
import {
  boxesOverlap,
  capsule,
  corridorOK,
  crossingOK,
  distance,
  footprintOK,
  intersectsArea,
  nearestBoundary,
  pointKey,
  projectPoint,
  touches,
} from './geometry.js';
import { buildingPolygon } from './placement.js';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function validatePrepared(
  input: AzgaarBurgInput,
  c: SettlementConstraints,
  model: SettlementModel,
  w: Work,
  options: SettlementOptions,
): void {
  preflight(model, w, '$model');
  const declared = resolveDevelopment(input.population, input.walls, options.development);
  if (declared.preset !== 'village')
    w.fail('UNSUPPORTED_CONSTRAINED_CITY', 'validation', 'constrained city layout is unsupported');
  for (const flag of ['walls', 'port', 'citadel', 'plaza', 'shanty', 'trade'] as const)
    if (input[flag])
      w.fail('UNSUPPORTED_CONSTRAINED_FEATURE', 'validation', `constrained ${flag} is unsupported`);
  if (options.landscape === true)
    w.fail(
      'UNSUPPORTED_CONSTRAINED_LANDSCAPE',
      'validation',
      'constrained landscape is unsupported',
    );
  if (
    model.version !== 1 ||
    !equal(model.development, declared) ||
    model.seed !== options.seed ||
    model.scene.seed !== options.seed ||
    model.name !== input.name ||
    model.scene.name !== input.name ||
    model.scene.population !== input.population
  )
    w.fail(
      'CONSTRAINT_PROVENANCE',
      'validation',
      'seed/name/population/development differs from declared recipe',
    );
  const m = model.constraints;
  if (
    !m ||
    m.version !== CONSTRAINT_VERSION ||
    m.terrainIdentity !== c.terrainIdentity ||
    m.mode !== (c.mode ?? 'village')
  )
    w.fail('CONSTRAINT_PROVENANCE', 'validation', 'missing or inconsistent constrained provenance');
  if (
    model.coordinateSystem !== 'local_metres_y_down' ||
    model.scene.version !== 2 ||
    model.scene.metersPerUnit !== 1 ||
    !equal(model.scene.bounds, c.bounds)
  )
    w.fail('CONSTRAINT_PROVENANCE', 'validation', 'coordinate/bounds mismatch');
  if (!equal(m.water, c.water))
    w.fail('WATER_AUTHORITY', 'validation', 'water grouping or identity changed');
  const polys = c.water.flatMap((water) => water.polygons.map((p) => [p.outer, ...p.holes]));
  if (
    !equal(model.scene.layers.water.polygons, polys) ||
    !equal(model.scene.layers.water.rings, polys.flat()) ||
    model.scene.layers.water.synthetic
  )
    w.fail('WATER_AUTHORITY', 'validation', 'scene water differs from authority');
  if (
    model.scene.layers.fields.length ||
    model.scene.layers.furrows.length ||
    model.scene.layers.vegetation.length ||
    model.scene.layers.walls.length ||
    model.scene.layers.greens.length ||
    model.scene.layers.piers.length
  )
    w.fail('LANDSCAPE_AUTHORITY', 'validation', 'unsupported generated landscape/walls');
  const nodes = new Map<string, (typeof m.nodes)[number]>(),
    adjacency = new Map<string, string[]>(),
    streets = new Map<string, (typeof m.streets)[number]>();
  w.take(m.nodes.length + m.streets.length * 4, 'graph validation');
  for (const n of m.nodes) {
    if (nodes.has(n.id) || n.id !== `local-node:${pointKey(n.point)}`)
      w.fail('LOCAL_GRAPH', 'validation', 'duplicate/unstable node');
    nodes.set(n.id, n);
    adjacency.set(n.id, []);
  }
  const entrances = new Map(c.entrances.map((e) => [e.id, e]));
  const crossingAuthority = new Map(c.crossings.map((b) => [b.id, b]));
  for (const s of m.streets) {
    if (
      streets.has(s.id) ||
      s.path.length !== 2 ||
      distance(s.path[0], s.path[1]) <= 1e-6 ||
      !Number.isFinite(s.widthM) ||
      s.widthM <= 0 ||
      !Number.isFinite(s.surfaceWidthM) ||
      s.surfaceWidthM <= 0 ||
      s.surfaceWidthM > s.widthM ||
      !Number.isFinite(s.setbackM) ||
      s.setbackM < 0
    )
      w.fail('LOCAL_GRAPH', 'validation', 'malformed street');
    const a = nodes.get(s.fromNodeId),
      b = nodes.get(s.toNodeId);
    if (!a || !b || !equal(a.point, s.path[0]) || !equal(b.point, s.path[1]))
      w.fail('LOCAL_GRAPH', 'validation', 'street endpoint/node mismatch', s.id);
    streets.set(s.id, s);
    adjacency.get(a.id)!.push(b.id);
    adjacency.get(b.id)!.push(a.id);
    const entrance = s.entranceId ? entrances.get(s.entranceId) : undefined;
    if (s.entranceId && !entrance)
      w.fail('ENTRANCE_JOIN', 'validation', 'orphan approach cap authority', s.id);
    const crossing = s.crossingId ? crossingAuthority.get(s.crossingId) : undefined;
    if (s.crossingId && !crossing)
      w.fail('CROSSING_AUTHORITY', 'validation', 'orphan crossing street', s.id);
    if (
      crossing &&
      !equal(s.path, crossing.endpoints) &&
      !equal([...s.path].reverse(), crossing.endpoints)
    )
      w.fail('CROSSING_AUTHORITY', 'validation', 'displaced/partial crossing span', s.id);
    if (
      !corridorOK(
        c,
        {
          id: s.id,
          path: s.path,
          widthM: s.widthM,
          surfaceWidthM: s.surfaceWidthM,
          setbackM: s.setbackM,
          maxGrade: c.maxRoadGrade,
          ...(entrance ? { entrance } : {}),
          ...(crossing ? { crossing } : {}),
        },
        w,
      )
    )
      w.fail('STREET_CORRIDOR', 'validation', 'final emitted reserved corridor failed', s.id);
  }
  if (model.scene.layers.roads.length !== m.streets.length)
    w.fail('LOCAL_GRAPH', 'validation', 'scene street count mismatch');
  const sceneRoads = new Map(model.scene.layers.roads.map((s) => [s.id, s]));
  for (const s of m.streets) {
    const r = sceneRoads.get(s.id);
    if (
      !r ||
      !equal(r.path, s.path) ||
      r.reservedWidthM !== s.widthM ||
      r.width !== s.surfaceWidthM ||
      r.surfaceWidthM !== s.surfaceWidthM ||
      r.setbackM !== s.setbackM ||
      r.fromNodeId !== s.fromNodeId ||
      r.toNodeId !== s.toNodeId ||
      r.crossingId !== s.crossingId ||
      !equal(r.routeIds, s.routeIds)
    )
      w.fail('LOCAL_GRAPH', 'validation', 'scene and graph differ', s.id);
  }
  if (m.entrances.length !== c.entrances.length)
    w.fail('ENTRANCE_JOIN', 'validation', 'required entrance count differs');
  const joined = new Set<string>();
  for (const e of m.entrances) {
    const source = entrances.get(e.id),
      node = nodes.get(e.nodeId),
      street = streets.get(e.streetId);
    if (
      !source ||
      joined.has(e.id) ||
      !equal({ ...e, nodeId: undefined, streetId: undefined }, source) ||
      !node ||
      !equal(node.point, source.endpoint) ||
      !street ||
      source.routeIds.some((id) => !street.routeIds.includes(id))
    )
      w.fail('ENTRANCE_JOIN', 'validation', 'exact entrance identity/endpoint mismatch', e.id);
    joined.add(e.id);
    const other =
      street.fromNodeId === node.id
        ? street.path[1]
        : street.toNodeId === node.id
          ? street.path[0]
          : null;
    if (!other)
      w.fail('ENTRANCE_JOIN', 'validation', 'entrance disconnected from its street', e.id);
    const r = (source.bearingDeg * Math.PI) / 180,
      dx = source.endpoint.x - other.x,
      dy = source.endpoint.y - other.y,
      len = Math.hypot(dx, dy);
    if (
      dx * Math.sin(r) - dy * Math.cos(r) <= 0 ||
      Math.abs(dx * Math.cos(r) + dy * Math.sin(r)) / len > 1e-6 ||
      street.widthM !== source.widthM ||
      street.surfaceWidthM !== source.surfaceWidthM ||
      street.setbackM !== source.setbackM
    )
      w.fail('ENTRANCE_JOIN', 'validation', 'entrance bearing/width mismatch', e.id);
  }
  if (c.entrances.length) {
    const seen = new Set<string>(),
      queue = [m.entrances[0].nodeId];
    for (let i = 0; i < queue.length; i++) {
      w.take(1, 'graph walk');
      const id = queue[i];
      if (seen.has(id)) continue;
      seen.add(id);
      for (const n of adjacency.get(id) ?? []) if (!seen.has(n)) queue.push(n);
    }
    if (seen.size !== nodes.size || m.entrances.some((e) => !seen.has(e.nodeId)))
      w.fail('LOCAL_GRAPH', 'validation', 'disconnected streets/entrances');
  } else if (m.streets.length || m.nodes.length)
    w.fail('LOCAL_GRAPH', 'validation', 'unjoined network without entrances');
  for (const b of m.crossings) {
    const source = crossingAuthority.get(b.id);
    if (
      !source ||
      !equal({ ...b, streetIds: undefined, routeIds: undefined }, source) ||
      !crossingOK(c, source, w)
    )
      w.fail('CROSSING_AUTHORITY', 'validation', 'invalid emitted crossing', b.id);
    const linked = m.streets
      .filter((s) => s.crossingId === b.id)
      .map((s) => s.id)
      .sort();
    if (!linked.length || !equal([...b.streetIds].sort(), linked))
      w.fail('CROSSING_AUTHORITY', 'validation', 'crossing linkage differs', b.id);
  }
  if (m.streets.some((s) => s.crossingId && !m.crossings.some((b) => b.id === s.crossingId)))
    w.fail('CROSSING_AUTHORITY', 'validation', 'street missing emitted bridge');
  const bridges = model.scene.layers.bridges ?? [];
  if (
    bridges.length !== m.crossings.length ||
    new Set(bridges.map((b) => b.id)).size !== bridges.length
  )
    w.fail('CROSSING_AUTHORITY', 'validation', 'scene bridge cardinality/identity differs');
  for (const b of bridges) {
    const source = m.crossings.find((c) => c.id === b.id);
    if (!source || !equal(b.path, source.endpoints) || b.width !== c.localSurfaceWidthM)
      w.fail('CROSSING_AUTHORITY', 'validation', 'scene bridge geometry differs', b.id);
  }
  const buildings = new Map(model.buildings.map((b) => [b.id, b])),
    features = new Map(model.scene.layers.buildings.map((b) => [b.id, b]));
  if (
    !model.buildings.length ||
    buildings.size !== model.buildings.length ||
    m.buildings.length !== model.buildings.length ||
    features.size !== buildings.size ||
    model.scene.layers.buildings.length !== buildings.size ||
    new Set(m.buildings.map((b) => b.id)).size !== buildings.size
  )
    w.fail('HOUSING_ACCOUNT', 'validation', 'empty or duplicate building accounts/scene features');
  if (
    input.temple
      ? m.buildings.filter((b) => b.landmark).length !== 1
      : m.buildings.some((b) => b.landmark)
  )
    w.fail('LANDMARK_CAPACITY', 'validation', 'required landmark count differs from recipe');
  if (m.mode === 'isolated' && m.buildings.filter((b) => !b.landmark).length !== 1)
    w.fail('HOUSING_ACCOUNT', 'validation', 'isolated mode requires exactly one dwelling');
  if (
    model.districts.length !== 1 ||
    model.districts[0].id !== 'district:constrained' ||
    !equal(model.districts[0].boundary, c.permissible.outer) ||
    model.districts[0].insideWalls ||
    model.districts[0].urbanity !== 0
  )
    w.fail('CONSTRAINT_PROVENANCE', 'validation', 'district evidence differs');
  const symbols = new Map(model.scene.layers.symbols.map((s) => [s.buildingId, s]));
  if (
    symbols.size !== m.buildings.length ||
    model.scene.layers.symbols.length !== m.buildings.length
  )
    w.fail('BUILDING_FOOTPRINT', 'validation', 'symbol cardinality/identity differs');
  const roads = m.streets.map((s) => capsule(s.path[0], s.path[1], s.widthM / 2 + s.setbackM));
  const footprints = [] as ReturnType<typeof buildingPolygon>[];
  for (const b of m.buildings) {
    if (
      b.id !== `bld:${b.lotId}` ||
      !hasGlyph(b.glyph) ||
      (b.landmark && b.glyph !== resolveGlyphFor(input.biome ?? 'temperate', 'sm-chapel')) ||
      !Array.isArray(b.footprint) ||
      b.footprint.length !== 2 ||
      b.footprint.some((v) => !Number.isFinite(v) || v <= 0)
    )
      w.fail('BUILDING_FOOTPRINT', 'validation', 'invalid building provenance', b.id);
    const nominal = nominalFootprint(b.glyph);
    if (
      b.footprint.some(
        (v, i) =>
          v < nominal[i] * FIT_MIN * (1 - SIZE_JITTER) - 1e-12 ||
          v > nominal[i] * FIT_MAX * (1 + SIZE_JITTER) + 1e-12,
      )
    )
      w.fail(
        'BUILDING_FOOTPRINT',
        'validation',
        'dwelling scale outside declared seating policy',
        b.id,
      );
    if (Math.abs(b.footprint[0] / nominal[0] - b.footprint[1] / nominal[1]) > 1e-12)
      w.fail(
        'BUILDING_FOOTPRINT',
        'validation',
        'nonuniform glyph scaling changes the certified ink extent',
        b.id,
      );
    const account = buildings.get(b.id),
      feature = features.get(b.id);
    const source = {
      id: b.id,
      lotId: b.lotId,
      glyph: b.glyph,
      position: new Point(b.position.x, b.position.y),
      bearingDeg: b.bearingDeg,
      footprint: b.footprint,
      occupancy: b.capacity,
    };
    const polygon = buildingPolygon(source);
    const symbol = symbols.get(b.id);
    if (
      !symbol ||
      symbol.id !== b.glyph ||
      !equal(symbol.at, b.position) ||
      symbol.rotationDeg !== b.bearingDeg ||
      symbol.scale !== b.footprint[0] ||
      symbol.scaleY !== b.footprint[1] ||
      symbol.zBand !== 'structure'
    )
      w.fail(
        'BUILDING_FOOTPRINT',
        'validation',
        'symbol position/bearing/scales differ from certified building',
        b.id,
      );
    if (
      !account ||
      !feature ||
      !equal(account.footprint, polygon.outer) ||
      !equal(feature.ring, polygon.outer) ||
      feature.landmark !== b.landmark ||
      account.capacity !== b.capacity ||
      b.capacity !== (b.landmark ? 0 : declared.edgeOccupancy) ||
      account.insideWalls ||
      account.districtId !== 'district:constrained' ||
      account.urbanity !== 0 ||
      feature.kind !== 'Craftsmen' ||
      feature.glyphBacked !== true
    )
      w.fail('HOUSING_ACCOUNT', 'validation', 'building geometry/capacity evidence differs', b.id);
    if (
      !footprintOK(
        c,
        {
          id: b.id,
          kind: b.landmark ? 'landmark' : 'building',
          polygon,
          maxFoundationGradient: c.maxFoundationGradient,
        },
        w,
      )
    )
      w.fail('BUILDING_FOOTPRINT', 'validation', 'final transformed footprint failed', b.id);
    for (const road of roads)
      if (touches(polygon, road, w))
        w.fail(
          'BUILDING_CORRIDOR',
          'validation',
          'building occupies reserved street/setback',
          b.id,
        );
    for (const prior of footprints)
      if (boxesOverlap(polygon, prior, w) && intersectsArea(polygon, prior, w))
        w.fail('BUILDING_OVERLAP', 'validation', 'buildings overlap', b.id);
    if (m.streets.length) {
      const street = b.streetId ? streets.get(b.streetId) : undefined,
        access = b.access;
      if (
        !street ||
        street.crossingId ||
        !access ||
        access.streetId !== street.id ||
        access.widthM !== 0.8 ||
        access.path.length !== 2
      )
        w.fail('BUILDING_ACCESS', 'validation', 'building has no actual street access', b.id);
      const p = access!.path[0],
        q = access!.path[1];
      if (
        distance(p, nearestBoundary(p, polygon)) > 1e-6 ||
        distance(q, projectPoint(q, street!.path[0], street!.path[1])) > 1e-6 ||
        distance(p, q) > Math.max(...b.footprint) * 2 + street!.widthM
      )
        w.fail(
          'BUILDING_ACCESS',
          'validation',
          'access does not join actual footprint and street',
          b.id,
        );
      if (
        !corridorOK(
          c,
          {
            id: `access:${b.id}`,
            path: access!.path,
            widthM: 0.8,
            surfaceWidthM: 0.8,
            setbackM: 0,
            maxGrade: c.maxRoadGrade,
          },
          w,
        )
      )
        w.fail('BUILDING_ACCESS', 'validation', 'final complete building access failed', b.id);
    } else if (m.mode !== 'isolated' || b.streetId !== null || b.access !== null)
      w.fail('BUILDING_ACCESS', 'validation', 'isolated dwelling has orphan street/access', b.id);
    footprints.push(polygon);
  }
  const allocation = detach(model.buildings),
    expected = allocateResidents(allocation, input.population, null);
  if (
    !equal(expected, model.residents) ||
    allocation.some((b) => b.residents !== buildings.get(b.id)!.residents) ||
    expected.unassigned
  )
    w.fail('HOUSING_ACCOUNT', 'validation', 'population account differs or has shortfall');
}
