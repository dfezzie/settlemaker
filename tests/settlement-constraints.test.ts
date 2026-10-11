import { describe, it, expect } from 'vitest';
import {
  createConstrainedSettlementModel,
  validateConstrainedSettlementModel,
  DEFAULT_CONSTRAINT_LIMITS,
  SettlementConstraintError,
  type SettlementConstraints,
  type ConstraintPolygon,
} from '../src/settlement/constraints/index.js';
import { createSettlementModel } from '../src/settlement/generate.js';
import { exportSettlement } from '../src/settlement/output.js';
import type { SettlementOptions } from '../src/settlement/generate.js';
import { Work } from '../src/settlement/constraints/budget.js';
import { footprintOK, corridorOK, crossingOK } from '../src/settlement/constraints/geometry.js';
import { localSeed } from '../src/settlement/constraints/placement.js';
import { allocateResidents } from '../src/settlement/model.js';

const square = (x: number, y: number, w: number, h = w): ConstraintPolygon => ({
  outer: [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ],
  holes: [],
});
const burg = (population = 12) => ({
  name: 'Constraint fixture',
  population,
  biome: 'temperate',
  walls: false,
  port: false,
  citadel: false,
  plaza: false,
  temple: false,
  shanty: false,
  capital: false,
});
function context(extent = 100): SettlementConstraints {
  return {
    version: 1,
    terrainIdentity: 'analytical-flat-v1',
    bounds: { min_x: 0, min_y: 0, max_x: extent, max_y: extent },
    permissible: square(0, 0, extent),
    water: [],
    exclusions: [],
    crossings: [],
    entrances: [
      {
        id: 'north',
        routeIds: ['regional:north'],
        endpoint: { x: extent / 2, y: 0 },
        bearingDeg: 0,
        widthM: 12,
        surfaceWidthM: 6,
        setbackM: 0.3,
      },
    ],
    maxFoundationGradient: 0.15,
    maxRoadGrade: 0.1,
    certifyFootprint: () => ({ ok: true, maxGradient: 0 }),
    certifyCorridor: () => ({ ok: true, maxGrade: 0 }),
  };
}
const options = (c: SettlementConstraints, seed = 17): SettlementOptions => ({
  seed,
  development: { preset: 'village' },
  landscape: false,
  constraints: c,
});
function plane(c: SettlementConstraints, a: number, b: number, mixed = 0): void {
  c.heightAt = (p) => a * p.x + b * p.y + mixed * p.x * p.y;
  c.certifyFootprint = (req) => ({
    ok: true,
    maxGradient: Math.max(
      ...req.polygon.outer.map((p) => Math.hypot(a + mixed * p.y, b + mixed * p.x)),
    ),
  });
  c.certifyCorridor = (req) => {
    if (req.crossing)
      return {
        ok: true,
        maxGrade:
          Math.abs(req.crossing.endpointHeightsM[1] - req.crossing.endpointHeightsM[0]) /
          Math.hypot(req.path[1].x - req.path[0].x, req.path[1].y - req.path[0].y),
      };
    const [p, q] = req.path,
      l = Math.hypot(q.x - p.x, q.y - p.y),
      dx = (q.x - p.x) / l,
      dy = (q.y - p.y) / l;
    const g = (x: { x: number; y: number }) => (a + mixed * x.y) * dx + (b + mixed * x.x) * dy;
    return {
      ok: true,
      maxGrade: Math.max(Math.abs(g(p)), Math.abs(g(q))) + (req.widthM / 2) * Math.abs(mixed),
    };
  };
}
const successful = (r: ReturnType<typeof createConstrainedSettlementModel>) => {
  expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
  if (!r.ok) throw new Error('fixture failed');
  return r.model;
};

describe('constrained physical village complete certificates', () => {
  it('houses actual 300 residents in the configured 100m village, exact unwalled joins and independent export', () => {
    const c = context(),
      input = burg(300),
      before = JSON.stringify(c),
      result = createConstrainedSettlementModel(input, options(c));
    const m = successful(result);
    expect(m.residents).toMatchObject({ requested: 300, assigned: 300, unassigned: 0 });
    expect(m.buildings).toHaveLength(75);
    expect(m.constraints!.entrances[0]).toMatchObject(c.entrances[0]);
    expect(m.scene.layers.walls).toEqual([]);
    expect(exportSettlement(m).features.some((f) => f.properties?.layer === 'entrance')).toBe(true);
    expect(validateConstrainedSettlementModel(input, options(c), m).ok).toBe(true);
    expect(JSON.stringify(c)).toBe(before);
    expect(createConstrainedSettlementModel(input, options(c))).toEqual(result);
  });
  it('supports farm and isolated footprint modes with real capacity', () => {
    const c = context(25);
    c.mode = 'farm';
    const farm = successful(createConstrainedSettlementModel(burg(), options(c)));
    expect(farm.residents.assigned).toBe(12);
    c.mode = 'isolated';
    c.entrances = [];
    const isolated = successful(createConstrainedSettlementModel(burg(4), options(c)));
    expect(isolated.buildings).toHaveLength(1);
    expect(isolated.scene.layers.roads).toEqual([]);
    const short = createConstrainedSettlementModel(burg(5), options(c));
    expect(short.ok).toBe(false);
    expect(short.population).toEqual({ requested: 5, capacity: 4, assigned: 4, unassigned: 1 });
  });
  it('routes and seats against a supplied hillside instead of a second terrain generator', () => {
    const c = context();
    plane(c, 0.03, -0.07);
    const m = successful(createConstrainedSettlementModel(burg(100), options(c, 31)));
    expect(m.residents.assigned).toBe(100);
    expect(m.constraints!.terrainIdentity).toBe(c.terrainIdentity);
  });
  it('checks wet edges, completely enclosed ponds and dry holes', () => {
    const c = context(),
      w = () => new Work();
    c.water = [{ id: 'lake', polygons: [square(40, 40, 20)] }];
    const req = (polygon: ConstraintPolygon) => ({
      id: 'building',
      kind: 'building' as const,
      polygon,
      maxFoundationGradient: 0.15,
    });
    expect(footprintOK(c, req(square(30, 30, 40)), w())).toBe(false);
    expect(footprintOK(c, req(square(30, 45, 10)), w())).toBe(false);
    c.water[0].polygons[0].holes = [square(44, 44, 12).outer];
    expect(footprintOK(c, req(square(46, 46, 8)), w())).toBe(true);
    expect(footprintOK(c, req(square(44, 44, 8)), w())).toBe(false);
  });
  it('checks complete permissible geometry, concavity, holes and exclusions', () => {
    const c = context();
    c.permissible = {
      outer: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 40 },
        { x: 40, y: 40 },
        { x: 40, y: 100 },
        { x: 0, y: 100 },
      ],
      holes: [],
    };
    const req = {
      id: 'concave',
      kind: 'building' as const,
      polygon: square(30, 30, 30),
      maxFoundationGradient: 0.15,
    };
    expect(footprintOK(c, req, new Work())).toBe(false);
    c.permissible = square(0, 0, 100);
    c.exclusions = [square(49, 49, 2)];
    expect(footprintOK(c, { ...req, polygon: square(40, 40, 20) }, new Work())).toBe(false);
  });
  it('uses reserved shoulders and round caps, not the travelled width', () => {
    const c = context();
    c.water = [{ id: 'thin', polygons: [square(30, 54, 40, 1)] }];
    const req = {
      id: 'road',
      path: [
        { x: 20, y: 50 },
        { x: 80, y: 50 },
      ],
      widthM: 12,
      surfaceWidthM: 2,
      setbackM: 0.3,
      maxGrade: 0.1,
    };
    expect(corridorOK(c, req, new Work())).toBe(false);
    expect(corridorOK(c, { ...req, widthM: 4 }, new Work())).toBe(true);
    c.water = [{ id: 'cap', polygons: [square(83, 48, 2, 4)] }];
    expect(corridorOK(c, req, new Work())).toBe(false);
  });
  it('clips only outer boundary mouths and never permissible holes; oblique corner entrance remains valid', () => {
    const c = context();
    c.entrances = [
      {
        id: 'north',
        routeIds: ['regional:north'],
        endpoint: { x: 50, y: 0 },
        bearingDeg: 0,
        widthM: 4,
        surfaceWidthM: 2.4,
        setbackM: 0.3,
      },
    ];
    const req = {
      id: 'mouth',
      path: [
        { x: 50, y: 0 },
        { x: 50, y: 7 },
      ],
      widthM: 4,
      surfaceWidthM: 2.4,
      setbackM: 0.3,
      maxGrade: 0.1,
      entrance: c.entrances[0],
    };
    c.permissible.holes = [square(49, 0.5, 2, 1).outer];
    expect(corridorOK(c, req, new Work())).toBe(false);
    expect(createConstrainedSettlementModel(burg(4), options(c))).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'ENTRANCE_CORRIDOR' }],
    });
    c.permissible.holes = [];
    const entrance = { ...c.entrances[0], endpoint: { x: 0, y: 0 }, bearingDeg: 315 };
    expect(
      corridorOK(
        c,
        { ...req, entrance, path: [entrance.endpoint, { x: 4.949747, y: 4.949747 }] },
        new Work(),
      ),
    ).toBe(true);
  });
  it('rejects a bilinear equal-height hump and accepts directional contour-following grade', () => {
    const c = context();
    plane(c, 0.2, 0, -0.008);
    const req = {
      id: 'hump',
      path: [
        { x: 25, y: 25 },
        { x: 75, y: 75 },
      ],
      widthM: 4,
      surfaceWidthM: 2,
      setbackM: 0.3,
      maxGrade: 0.1,
    };
    expect(corridorOK(c, req, new Work())).toBe(false);
    plane(c, 0.2, -0.2);
    expect(corridorOK(c, req, new Work())).toBe(true);
  });
  it('propagates callback errors, rejects accessors without invocation and keeps inputs detached', () => {
    const c = context();
    let calls = 0;
    Object.defineProperty(c, 'limits', {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    });
    expect(() => createConstrainedSettlementModel(burg(), options(c))).toThrow(/accessor/);
    expect(calls).toBe(0);
    const clean = context(),
      error = new Error('terrain bug');
    clean.certifyCorridor = () => {
      throw error;
    };
    expect(() => createConstrainedSettlementModel(burg(), options(clean))).toThrow(error);
    const opt = options(context());
    Object.defineProperty(opt, 'constraints', {
      get() {
        calls++;
        return context();
      },
    });
    expect(() => createSettlementModel(burg(), opt)).toThrow(/accessor/);
    expect(calls).toBe(0);
  });
  it('bounds input/planning/work/output and repeated rejected placements without truncated success', () => {
    for (const limits of [
      { maxWork: 1 },
      { maxPlanningCells: 3 },
      { maxOutputFeatures: 1 },
      { maxOutputVertices: 1 },
    ]) {
      const c = context();
      c.limits = limits;
      const r = createConstrainedSettlementModel(burg(), options(c));
      expect(r.ok).toBe(false);
      expect(r.diagnostics[0].code).toBe('CONSTRAINT_RESOURCE_LIMIT');
    }
    const c = context();
    c.limits = { maxPlacementAttempts: 3 };
    c.certifyFootprint = () => ({ ok: false, code: 'STEEP' });
    const r = createConstrainedSettlementModel(burg(), options(c));
    expect(r.ok).toBe(false);
    expect(r.work.placementAttempts).toBe(3);
    expect(r.work.total).toBeLessThan(DEFAULT_CONSTRAINT_LIMITS.maxWork);
  });
  it('rejects unsupported constrained city and landscape, uses typed physical delegation', () => {
    const c = context(),
      opt = options(c);
    opt.development.preset = 'city';
    expect(createConstrainedSettlementModel(burg(), opt).diagnostics[0].code).toBe(
      'UNSUPPORTED_CONSTRAINED_CITY',
    );
    opt.development.preset = 'village';
    opt.landscape = true;
    expect(() => createSettlementModel(burg(), opt)).toThrow(SettlementConstraintError);
  });
  it('preserves asymmetric off-circle exact endpoints and near-parallel arrivals after every emitted transform', () => {
    const c = context();
    c.entrances.push({
      id: 'south-east',
      routeIds: ['regional:asymmetric'],
      endpoint: { x: 88, y: 100 },
      bearingDeg: 179.7,
      widthM: 12,
      surfaceWidthM: 6,
      setbackM: 0.3,
    });
    c.entrances.push({
      id: 'south-second',
      routeIds: ['regional:near'],
      endpoint: { x: 75, y: 100 },
      bearingDeg: 180.1,
      widthM: 12,
      surfaceWidthM: 6,
      setbackM: 0.3,
    });
    const m = successful(createConstrainedSettlementModel(burg(20), options(c, 7)));
    for (const entry of c.entrances)
      expect(m.constraints!.entrances.find((e) => e.id === entry.id)).toMatchObject(entry);
    expect(validateConstrainedSettlementModel(burg(20), options(c, 7), m).ok).toBe(true);
  });
  it('accepts the canonical full-width rectangular bridge, rejects missing/partial/wet/tangent authority', () => {
    const c = context();
    c.water = [{ id: 'river', polygons: [square(45, 20, 10, 60)] }];
    const bridge = {
      id: 'bridge',
      waterId: 'river',
      endpoints: [
        { x: 35, y: 50 },
        { x: 65, y: 50 },
      ] as [{ x: number; y: number }, { x: number; y: number }],
      deck: square(29, 44, 42, 12),
      widthM: 12,
      endpointHeightsM: [10, 10] as [number, number],
      minimumAbutmentM: 3,
    };
    c.crossings = [bridge];
    expect(crossingOK(c, bridge, new Work())).toBe(true);
    expect(crossingOK(c, { ...bridge, deck: square(29, 45, 42, 10) }, new Work())).toBe(false);
    expect(
      crossingOK(
        c,
        {
          ...bridge,
          endpoints: [
            { x: 36, y: 50 },
            { x: 64, y: 50 },
          ],
        },
        new Work(),
      ),
    ).toBe(false);
    expect(
      crossingOK(
        c,
        {
          ...bridge,
          endpoints: [
            { x: 35.999999, y: 50 },
            { x: 64.000001, y: 50 },
          ],
        },
        new Work(),
      ),
    ).toBe(true);
    const road = {
      id: 'bridge-road',
      path: bridge.endpoints,
      widthM: 12,
      surfaceWidthM: 6,
      setbackM: 0,
      maxGrade: 0.1,
    };
    expect(corridorOK(c, road, new Work())).toBe(false);
    expect(corridorOK(c, { ...road, crossing: bridge }, new Work())).toBe(true);
    c.water[0].polygons[0].holes = [square(49, 52, 2, 2).outer];
    expect(crossingOK(c, bridge, new Work())).toBe(true);
    bridge.deck.holes = [square(49, 52, 2, 2).outer];
    expect(crossingOK(c, bridge, new Work())).toBe(false);
  });
  it('uses supplied bridge edges in the actual connected local graph; river-adjacent layout is dry', () => {
    const c = context();
    c.water = [{ id: 'river', polygons: [square(45, 0, 10, 100)] }];
    c.entrances = [
      {
        id: 'west',
        routeIds: ['regional:west'],
        endpoint: { x: 0, y: 50 },
        bearingDeg: 270,
        widthM: 12,
        surfaceWidthM: 6,
        setbackM: 0.3,
      },
      {
        id: 'east',
        routeIds: ['regional:east'],
        endpoint: { x: 100, y: 50 },
        bearingDeg: 90,
        widthM: 12,
        surfaceWidthM: 6,
        setbackM: 0.3,
      },
    ];
    c.crossings = [
      {
        id: 'bridge',
        waterId: 'river',
        endpoints: [
          { x: 35, y: 50 },
          { x: 65, y: 50 },
        ],
        deck: square(29, 44, 42, 12),
        widthM: 12,
        endpointHeightsM: [10, 10],
        minimumAbutmentM: 3,
      },
    ];
    const m = successful(createConstrainedSettlementModel(burg(20), options(c, 97)));
    expect(m.constraints!.crossings).toHaveLength(1);
    expect(m.constraints!.streets.some((s) => s.crossingId === 'bridge')).toBe(true);
    expect(m.constraints!.crossings[0].streetIds.length).toBeGreaterThan(0);
    c.crossings = [];
    const missing = createConstrainedSettlementModel(burg(20), options(c, 97));
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics[0].code).toBe('LOCAL_NETWORK');
  });
  it('passes complete shapes to the authority including a raised interior node missed by corners', () => {
    const c = context();
    let checked = false;
    c.certifyFootprint = (req) => {
      // Independent enclosed steep cell oracle: an interior spike at (50,50).
      checked = true;
      const xs = req.polygon.outer.map((p) => p.x),
        ys = req.polygon.outer.map((p) => p.y);
      const coversInterior =
        Math.min(...xs) < 50 &&
        Math.max(...xs) > 50 &&
        Math.min(...ys) < 50 &&
        Math.max(...ys) > 50;
      return { ok: true, maxGradient: coversInterior ? 2 : 0 };
    };
    expect(
      footprintOK(
        c,
        {
          id: 'interior',
          kind: 'building',
          polygon: square(40, 40, 20),
          maxFoundationGradient: 0.15,
        },
        new Work(),
      ),
    ).toBe(false);
    expect(checked).toBe(true);
  });
  it('rejects invalid post-routing smoothing, unchecked symbol/bridge changes and orphan building access', () => {
    const c = context(),
      input = burg(),
      opt = options(c),
      model = successful(createConstrainedSettlementModel(input, opt));
    for (const mutate of [
      (m: typeof model) => {
        m.scene.layers.symbols[0].at = { x: 1000, y: 1000 };
      },
      (m: typeof model) => {
        m.constraints!.buildings[0].footprint[1] *= 1.1;
        m.scene.layers.symbols[0].scaleY! *= 1.1;
      },
      (m: typeof model) => {
        m.scene.layers.buildings.unshift({
          ...m.scene.layers.buildings[0],
          glyphBacked: undefined,
          ring: square(1000, 1000, 10).outer,
        });
      },
      (m: typeof model) => {
        m.scene.layers.bridges = [
          {
            id: 'orphan',
            path: [
              { x: -100, y: -100 },
              { x: 1000, y: 1000 },
            ],
            width: 100,
          },
        ];
      },
      (m: typeof model) => {
        m.constraints!.buildings[0].streetId = 'orphan';
      },
      (m: typeof model) => {
        m.constraints!.streets[0].path[0] = { x: 150, y: 150 };
        m.scene.layers.roads[0].path[0] = { x: 150, y: 150 };
      },
    ]) {
      const clone = structuredClone(model);
      mutate(clone);
      expect(validateConstrainedSettlementModel(input, opt, clone).ok).toBe(false);
    }
  });
  it('independently checks declared seed/development/required landmark and prevents forged capacity', () => {
    const c = context();
    c.mode = 'isolated';
    c.entrances = [];
    const input = burg(4),
      opt = options(c),
      model = successful(createConstrainedSettlementModel(input, opt));
    const forged = structuredClone(model);
    forged.development.edgeOccupancy = 300;
    forged.buildings[0].capacity = 300;
    forged.constraints!.buildings[0].capacity = 300;
    forged.residents = allocateResidents(forged.buildings, 300, null);
    forged.seed = 999;
    expect(validateConstrainedSettlementModel(burg(300), opt, forged).ok).toBe(false);
    const orphan = structuredClone(model);
    orphan.constraints!.buildings[0].streetId = 'orphan';
    expect(validateConstrainedSettlementModel(input, opt, orphan).ok).toBe(false);
    expect(createConstrainedSettlementModel({ ...input, temple: true }, opt)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'UNSUPPORTED_ISOLATED_LANDMARK' }],
    });
    expect(validateConstrainedSettlementModel({ ...input, temple: true }, opt, model).ok).toBe(
      false,
    );
  });
  it('installs scalar caps before full traversal and hashes all safe-integer seed bits', () => {
    const c = context();
    c.mode = 'isolated';
    c.entrances = [];
    c.limits = { maxWork: 1 };
    let descriptors = 0;
    const original = Object.getOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptor = ((o: object, p: PropertyKey) => {
      if (o === c.permissible.outer) descriptors++;
      return original(o, p);
    }) as typeof original;
    let result;
    try {
      result = createConstrainedSettlementModel(burg(4), options(c));
    } finally {
      Object.getOwnPropertyDescriptor = original;
    }
    expect(result!.ok).toBe(false);
    expect(result!.work.total).toBe(1);
    expect(descriptors).toBe(0);
    expect(localSeed(17, 'deck')).not.toBe(localSeed(4294967313, 'deck'));
  });
});
