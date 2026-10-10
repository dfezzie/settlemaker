import type { AzgaarBurgInput } from '../../input/azgaar-input.js';
import type { SettlementOptions } from '../generate.js';
import type { SettlementModel, ResidentAccount } from '../model.js';
import { allocateResidents } from '../model.js';
import { resolveDevelopment } from '../development.js';
import { SCENE_VERSION } from '../../scene/scene.js';
import { skinBiomeFor } from '../../assets/skins.js';
import { paletteForTheme } from '../../output/palette.js';
import { Work, SettlementConstraintError } from './budget.js';
import { detach, prepare, preflight } from './input.js';
import { containsPoint, differenceArea, distance, pointKey, validatePolygon } from './geometry.js';
import { Router } from './routing.js';
import { planarize } from './network.js';
import { placeBuildings } from './placement.js';
import { validatePrepared } from './validate.js';
import {
  CONSTRAINT_VERSION,
  type ConstrainedSettlementResult,
  type SettlementConstraints,
} from './types.js';

export { SettlementConstraintError, DEFAULT_CONSTRAINT_LIMITS } from './budget.js';
export { CONSTRAINT_VERSION } from './types.js';
export type * from './types.js';

function topology(c: SettlementConstraints, w: Work): void {
  validatePolygon(c.permissible, w, 'permissible');
  c.exclusions.forEach((p, i) => validatePolygon(p, w, `exclusion:${i}`));
  c.water.forEach((water) =>
    water.polygons.forEach((p, i) => validatePolygon(p, w, `water:${water.id}:${i}`)),
  );
  c.crossings.forEach((b) => validatePolygon(b.deck, w, `crossing:${b.id}`));
  const b = c.bounds,
    box = {
      outer: [
        { x: b.min_x, y: b.min_y },
        { x: b.max_x, y: b.min_y },
        { x: b.max_x, y: b.max_y },
        { x: b.min_x, y: b.max_y },
      ],
      holes: [],
    };
  if (differenceArea(c.permissible, box, w) > 1e-10)
    throw new TypeError('permissible: outside supplied bounds');
  for (const e of c.entrances) {
    if (!containsPoint(e.endpoint, c.permissible))
      w.fail(
        'ENTRANCE_REGION',
        'input',
        'entrance endpoint outside permissible outer land or in hole',
        e.id,
      );
  }
}
function failure(
  error: SettlementConstraintError,
  w: Work,
  population: ResidentAccount,
): ConstrainedSettlementResult {
  return {
    ok: false,
    diagnostics: [error.diagnostic],
    work: { ...w.stats },
    population: { ...population },
  };
}

/** Generic complete-shape authority; never imports a battlefield implementation
 * or generates its own elevation. Expected infeasibility carries exact work. */
export function createConstrainedSettlementModel(
  raw: AzgaarBurgInput,
  rawOptions: SettlementOptions,
): ConstrainedSettlementResult {
  const w = new Work();
  let population: ResidentAccount = { requested: 0, capacity: 0, assigned: 0, unassigned: 0 };
  try {
    const ready = prepare(raw, rawOptions, w),
      { constraints: c, options } = ready;
    let input = ready.input;
    population = {
      requested: input.population,
      capacity: 0,
      assigned: 0,
      unassigned: input.population,
    };
    const development = resolveDevelopment(input.population, input.walls, options.development),
      seed = options.seed!;
    if (options.theme !== undefined) paletteForTheme(options.theme);
    if (options.skin) input = { ...input, biome: skinBiomeFor(options.skin, input.biome).base };
    if (development.preset !== 'village')
      w.fail('UNSUPPORTED_CONSTRAINED_CITY', 'input', 'constrained city layout is not implemented');
    if (options.landscape === true)
      w.fail(
        'UNSUPPORTED_CONSTRAINED_LANDSCAPE',
        'input',
        'constrained layouts require landscape:false',
      );
    for (const flag of ['walls', 'port', 'citadel', 'plaza', 'shanty', 'trade'] as const)
      if (input[flag])
        w.fail('UNSUPPORTED_CONSTRAINED_FEATURE', 'input', `constrained ${flag} is unsupported`);
    topology(c, w);
    if (!c.entrances.length && (c.mode ?? 'village') !== 'isolated')
      w.fail(
        'REQUIRED_ENTRANCE',
        'routing',
        'village/farm requires at least one explicit entrance',
      );
    let streets = [] as ReturnType<Router['streets']>;
    if (c.entrances.length) {
      const router = new Router(c, w),
        centre = {
          x: (c.bounds.min_x + c.bounds.max_x) / 2,
          y: (c.bounds.min_y + c.bounds.max_y) / 2,
        };
      const first = router.terminalNodes.get(c.entrances[0].id)!;
      let root = -1;
      for (const candidate of router.nearest(centre, 32))
        if (router.route(first, candidate)) {
          root = candidate;
          break;
        }
      if (root < 0)
        w.fail(
          'LOCAL_NETWORK',
          'routing',
          'no certified interior root reachable from first entrance',
        );
      for (const e of c.entrances.slice(1))
        if (!router.route(router.terminalNodes.get(e.id)!, root))
          w.fail(
            'LOCAL_NETWORK',
            'routing',
            'required exact entrance cannot join connected network',
            e.id,
          );
      if (c.mode !== 'isolated') {
        const pad = Math.max(c.localWidthM! / 2 + 1, c.frontageSpacingM! / 2 + 0.2),
          height = c.bounds.max_y - c.bounds.min_y - 2 * pad;
        const count = Math.max(1, Math.floor(height / c.streetSpacingM!) + 1);
        if (count > w.limits.maxPlanningCells)
          w.fail('CONSTRAINT_RESOURCE_LIMIT', 'routing', 'frontage row cap');
        w.take(count, 'frontage row enumeration');
        for (let i = 0; i < count; i++) {
          const y = count === 1 ? centre.y : c.bounds.min_y + pad + (i * height) / (count - 1);
          const a = router.nearest({ x: c.bounds.min_x + pad, y })[0],
            b = router.nearest({ x: c.bounds.max_x - pad, y })[0];
          w.take(router.edges.size + 1, 'routing retry');
          const before = new Set(router.edges.keys());
          if (!router.route(a, b) || !router.route(a, root))
            for (const key of router.edges.keys()) if (!before.has(key)) router.edges.delete(key);
        }
      }
      streets = planarize(router.streets(), w);
    }
    const placed = placeBuildings(input, c, development, seed, streets, w);
    population.capacity = placed.reduce((n, b) => n + b.source.occupancy, 0);
    if (population.capacity < input.population) {
      population.assigned = population.capacity;
      population.unassigned = input.population - population.capacity;
      w.fail(
        'POPULATION_CAPACITY',
        'placement',
        `requested ${input.population}; complete suitable capacity ${population.capacity}; ${population.unassigned} residents unassigned`,
      );
    }
    const nodeMap = new Map<string, { id: string; point: { x: number; y: number } }>();
    for (const s of streets)
      for (const [id, p] of [
        [s.fromNodeId, s.path[0]],
        [s.toNodeId, s.path[1]],
      ] as const)
        if (!nodeMap.has(id)) {
          w.reserve(1, 1);
          nodeMap.set(id, { id, point: { ...p } });
        }
    const entrances = c.entrances.map((e) => {
      const nodeId = `local-node:${pointKey(e.endpoint)}`,
        s = streets.find(
          (r) =>
            (r.fromNodeId === nodeId || r.toNodeId === nodeId) &&
            e.routeIds.every((id) => r.routeIds.includes(id)),
        );
      if (!s) w.fail('ENTRANCE_JOIN', 'network', 'final exact entrance street is missing', e.id);
      w.reserve(1, 1);
      return { ...detach(e), nodeId, streetId: s!.id };
    });
    // Route identities propagate over an actual graph walk from each entrance.
    for (const e of entrances) {
      const adjacency = new Map<string, Array<{ id: string; to: string }>>();
      w.take(streets.length * 4, 'route provenance');
      for (const s of streets) {
        for (const [a, b] of [
          [s.fromNodeId, s.toNodeId],
          [s.toNodeId, s.fromNodeId],
        ]) {
          const list = adjacency.get(a) ?? [];
          list.push({ id: s.id, to: b });
          adjacency.set(a, list);
        }
      }
      const seen = new Set([e.nodeId]),
        queue = [e.nodeId];
      for (let i = 0; i < queue.length; i++)
        for (const link of adjacency.get(queue[i]) ?? [])
          if (!seen.has(link.to)) {
            w.take(1, 'route provenance');
            seen.add(link.to);
            queue.push(link.to);
            const s = streets.find((r) => r.id === link.id)!;
            w.take(streets.length, 'route provenance');
            s.routeIds = [...new Set([...s.routeIds, ...e.routeIds])].sort();
          }
    }
    const crossings = c.crossings.flatMap((b) => {
      const links = streets.filter((s) => s.crossingId === b.id);
      w.take(streets.length, 'crossing linkage');
      if (!links.length) return [];
      const verts = b.deck.outer.length + b.deck.holes.reduce((n, r) => n + r.length, 0);
      w.reserve(2, verts + 4);
      return [
        {
          ...detach(b),
          streetIds: links.map((s) => s.id),
          routeIds: [...new Set(links.flatMap((s) => s.routeIds))].sort(),
        },
      ];
    });
    const waterVertices = c.water.reduce(
      (n, water) =>
        n +
        water.polygons.reduce(
          (s, p) => s + p.outer.length + p.holes.reduce((v, h) => v + h.length, 0),
          0,
        ),
      0,
    );
    w.reserve(c.water.length * 3 + 1, waterVertices * 3 + c.permissible.outer.length);
    const accounts = placed.map((b) => ({
      id: b.source.id,
      districtId: 'district:constrained',
      footprint: detach(b.polygon.outer),
      capacity: b.source.occupancy,
      residents: 0,
      insideWalls: false,
      urbanity: 0,
    }));
    const residents = allocateResidents(accounts, input.population, null);
    population = {
      requested: residents.requested,
      capacity: residents.capacity,
      assigned: residents.assigned,
      unassigned: residents.unassigned,
    };
    const polygons = c.water.flatMap((water) =>
      water.polygons.map((p) => [detach(p.outer), ...detach(p.holes)]),
    );
    const model: SettlementModel = {
      version: 1,
      name: input.name,
      seed,
      coordinateSystem: 'local_metres_y_down',
      development,
      buildings: accounts,
      districts: [
        {
          id: 'district:constrained',
          boundary: detach(c.permissible.outer),
          insideWalls: false,
          urbanity: 0,
        },
      ],
      residents,
      diagnostics: [],
      scene: {
        version: SCENE_VERSION,
        name: input.name,
        seed,
        population: input.population,
        biome: input.biome,
        metersPerUnit: 1,
        bounds: { ...c.bounds },
        layers: {
          water: { polygons, rings: detach(polygons.flat()), synthetic: false },
          fields: [],
          furrows: [],
          greens: [],
          vegetation: [],
          piers: [],
          walls: [],
          symbols: placed.map((b) => ({
            id: b.source.glyph,
            at: { x: b.source.position.x, y: b.source.position.y },
            scale: b.source.footprint[0],
            scaleY: b.source.footprint[1],
            rotationDeg: b.source.bearingDeg,
            zBand: 'structure' as const,
            buildingId: b.source.id,
          })),
          buildings: placed.map((b) => ({
            id: b.source.id,
            ring: detach(b.polygon.outer),
            kind: 'Craftsmen',
            landmark: b.landmark,
            glyphBacked: true as const,
          })),
          roads: streets.map((s) => ({
            id: s.id,
            path: detach(s.path),
            kind: 'alley' as const,
            width: s.surfaceWidthM,
            reservedWidthM: s.widthM,
            surfaceWidthM: s.surfaceWidthM,
            setbackM: s.setbackM,
            fromNodeId: s.fromNodeId,
            toNodeId: s.toNodeId,
            routeIds: [...s.routeIds],
            ...(s.crossingId ? { crossingId: s.crossingId } : {}),
          })),
          bridges: crossings.map((b) => ({
            id: b.id,
            path: detach(b.endpoints),
            width: c.localSurfaceWidthM!,
          })),
        },
      },
      constraints: {
        version: CONSTRAINT_VERSION,
        terrainIdentity: c.terrainIdentity,
        mode: c.mode ?? 'village',
        nodes: [...nodeMap.values()],
        streets,
        entrances,
        crossings,
        water: detach(c.water),
        diagnostics: [],
        work: { ...w.stats },
        buildings: placed.map((b) => ({
          id: b.source.id,
          lotId: b.source.lotId,
          streetId: b.streetId,
          glyph: b.source.glyph,
          position: { x: b.source.position.x, y: b.source.position.y },
          bearingDeg: b.source.bearingDeg,
          footprint: [...b.source.footprint],
          capacity: b.source.occupancy,
          landmark: b.landmark,
          access: detach(b.access),
        })),
      },
    };
    validatePrepared(input, c, model, w, options);
    model.constraints!.work = { ...w.stats };
    return { ok: true, model, diagnostics: [], work: { ...w.stats }, population };
  } catch (error) {
    if (error instanceof SettlementConstraintError) return failure(error, w, population);
    throw error;
  }
}

/** Rechecks the emitted model against the supplied authority. Cannot certify
 * callback correctness; the composing engine owns that independent gate. */
export function validateConstrainedSettlementModel(
  raw: AzgaarBurgInput,
  options: SettlementOptions,
  rawModel: SettlementModel,
): ConstrainedSettlementResult {
  const w = new Work();
  let population: ResidentAccount = { requested: 0, capacity: 0, assigned: 0, unassigned: 0 };
  try {
    const ready = prepare(raw, options, w);
    topology(ready.constraints, w);
    // Preflight before detach/read; never invoke caller-owned accessors.
    preflight(rawModel, w, '$model');
    const model = detach(rawModel);
    population = {
      requested: model.residents.requested,
      capacity: model.residents.capacity,
      assigned: model.residents.assigned,
      unassigned: model.residents.unassigned,
    };
    validatePrepared(ready.input, ready.constraints, model, w, ready.options);
    return { ok: true, model, diagnostics: [], work: { ...w.stats }, population };
  } catch (error) {
    if (error instanceof SettlementConstraintError) return failure(error, w, population);
    throw error;
  }
}
