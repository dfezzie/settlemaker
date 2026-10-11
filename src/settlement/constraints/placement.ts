import type { AzgaarBurgInput } from '../../input/azgaar-input.js';
import type { ScenePoint } from '../../scene/scene.js';
import { SeededRandom } from '../../utils/random.js';
import { Point } from '../../types/point.js';
import { buildDeck, resolveGlyphFor, type DeckEntry } from '../../village/deck.js';
import { seat } from '../../village/dwellings.js';
import { inkExtent, nominalFootprint } from '../../village/glyphs.js';
import type { Building, Lot } from '../../village/types.js';
import type { DevelopmentProfile } from '../development.js';
import type { ConstraintPolygon, ConstraintStreet, SettlementConstraints } from './types.js';
import { Work } from './budget.js';
import {
  boxesOverlap,
  capsule,
  corridorOK,
  distance,
  footprintOK,
  intersectsArea,
  nearestBoundary,
  projectPoint,
  roundPoint,
  touches,
} from './geometry.js';
import { frontageRuns } from './network.js';

export interface PlacedBuilding {
  source: Building;
  polygon: ConstraintPolygon;
  landmark: boolean;
  streetId: string | null;
  access: { streetId: string; path: [ScenePoint, ScenePoint]; widthM: number } | null;
}
export function buildingPolygon(b: Building): ConstraintPolygon {
  const ink = inkExtent(b.glyph, b.footprint),
    r = (b.bearingDeg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return {
    outer: [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([x, y]) =>
      roundPoint({
        x: b.position.x + ((x * ink.width) / 2) * c - ((y * ink.depth) / 2) * s,
        y: b.position.y + ((x * ink.width) / 2) * s + ((y * ink.depth) / 2) * c,
      }),
    ),
    holes: [],
  };
}
/** Versioned independent streams: adding street searches does not draw housing RNG. */
export function localSeed(seed: number, stream: string): number {
  let h = 0x811c9dc5;
  for (const ch of `constrained-frontage-v1:${seed}:${stream}`)
    h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0 || 1;
}
export function placeBuildings(
  input: AzgaarBurgInput,
  c: SettlementConstraints,
  profile: DevelopmentProfile,
  seed: number,
  streets: ConstraintStreet[],
  w: Work,
): PlacedBuilding[] {
  const rng = new SeededRandom(localSeed(seed, 'dwellings')),
    placed: PlacedBuilding[] = [];
  const deck = buildDeck(
    input.biome ?? 'temperate',
    input.population,
    new SeededRandom(localSeed(seed, 'deck')),
  ).entries.filter((e) => e.occupancy > 0 && !e.cap);
  if (!deck.length) w.fail('HOUSING_DECK', 'placement', 'no compatible dwelling glyphs');
  for (const e of deck) e.occupancy = profile.edgeOccupancy;
  w.take(streets.length * 35 + 1, 'placement allocation');
  const roads = streets.map((s) => capsule(s.path[0], s.path[1], s.widthM / 2 + s.setbackM));
  let capacity = 0;
  const accept = (b: Building, landmark: boolean, streetId: string | null): boolean => {
    const p = buildingPolygon(b);
    if (
      !footprintOK(
        c,
        {
          id: b.id,
          kind: landmark ? 'landmark' : 'building',
          polygon: p,
          maxFoundationGradient: c.maxFoundationGradient,
        },
        w,
      )
    )
      return false;
    for (const road of roads) if (touches(p, road, w)) return false;
    for (const prior of placed)
      if (boxesOverlap(p, prior.polygon, w) && intersectsArea(p, prior.polygon, w)) return false;
    let access: PlacedBuilding['access'] = null;
    if (streetId !== null) {
      w.take(streets.length * (2 + Math.ceil(Math.log2(streets.length + 1))), 'building access');
      const candidates = streets
        .filter((s) => !s.crossingId)
        .map((s) => ({ s, point: projectPoint(b.position, s.path[0], s.path[1]) }))
        .sort(
          (a, z) =>
            distance(b.position, a.point) - distance(b.position, z.point) ||
            (a.s.id < z.s.id ? -1 : a.s.id > z.s.id ? 1 : 0),
        );
      const nearest = candidates[0];
      if (!nearest) return false;
      const foot = nearestBoundary(nearest.point, p),
        path: [ScenePoint, ScenePoint] = [foot, nearest.point];
      if (
        !corridorOK(
          c,
          {
            id: `access:${b.id}`,
            path,
            widthM: 0.8,
            surfaceWidthM: 0.8,
            setbackM: 0,
            maxGrade: c.maxRoadGrade,
          },
          w,
        )
      )
        return false;
      streetId = nearest.s.id;
      access = { streetId, path, widthM: 0.8 };
    }
    if (placed.length >= w.limits.maxBuildings)
      w.fail('CONSTRAINT_RESOURCE_LIMIT', 'placement', 'building count cap');
    // Account + scene footprint + symbol point. Capacity precedes allocation.
    w.reserve(4, p.outer.length * 2 + 2 + (access ? 2 : 0));
    placed.push({ source: b, polygon: p, landmark, streetId, access });
    capacity += b.occupancy;
    return true;
  };
  if (c.mode === 'isolated' && !streets.length) {
    if (input.temple)
      w.fail(
        'UNSUPPORTED_ISOLATED_LANDMARK',
        'placement',
        'isolated single dwelling mode cannot accommodate a required temple',
      );
    const glyph = deck.reduce((a, b) => (a.weight >= b.weight ? a : b)).glyph;
    const position = {
      x: (c.bounds.min_x + c.bounds.max_x) / 2,
      y: (c.bounds.min_y + c.bounds.max_y) / 2,
    };
    for (let attempt = 0; attempt < w.limits.maxAttemptsPerBuilding; attempt++) {
      w.attempt();
      const b: Building = {
        id: 'bld:isolated:0000',
        lotId: 'isolated:0000',
        glyph,
        position: new Point(position.x, position.y),
        bearingDeg: 0,
        footprint: nominalFootprint(glyph),
        occupancy: profile.edgeOccupancy,
      };
      if (accept(b, false, null)) break;
    }
    return placed;
  }
  const runs = frontageRuns(streets, w),
    frontage = c.frontageSpacingM!;
  const tryLot = (lot: Lot, entry: DeckEntry, landmark: boolean): boolean => {
    w.attempt();
    const b = seat(entry, lot, rng, false);
    const original = b.position.clone(),
      along = {
        x: Math.cos((lot.bearingDeg * Math.PI) / 180),
        y: Math.sin((lot.bearingDeg * Math.PI) / 180),
      };
    for (let attempt = 0; attempt < w.limits.maxAttemptsPerBuilding; attempt++) {
      if (attempt) w.attempt();
      const share = [0, 0.25, -0.25, 0.45, -0.45][attempt % 5];
      b.position = new Point(
        original.x + along.x * share * lot.frontageM,
        original.y + along.y * share * lot.frontageM,
      );
      if (accept(b, landmark, lot.laneId)) return true;
    }
    return false;
  };
  const lots = (spacing: number, callback: (lot: Lot) => boolean): boolean => {
    for (const run of runs) {
      const [a, b] = run.path,
        length = distance(a, b),
        dx = (b.x - a.x) / length,
        dy = (b.y - a.y) / length;
      const number = Math.floor(length / spacing);
      w.take(number * 2 + 1, 'lots');
      for (let ordinal = 0; ordinal < number; ordinal++)
        for (const side of [1, -1] as const) {
          const t = (ordinal + 0.5) * spacing,
            offset = run.widthM / 2 + run.setbackM + 0.65;
          const front = new Point(
            a.x + dx * t - dy * side * offset,
            a.y + dy * t + dx * side * offset,
          );
          const bearingDeg = ((Math.atan2(dy * side, dx * side) * 180) / Math.PI + 360) % 360;
          const lot: Lot = {
            id: `constrained:${run.id}:${side}:${ordinal}:${spacing}`,
            laneId: run.id,
            side,
            front,
            bearingDeg,
            frontageM: spacing,
            depthM: 10,
            score: 0,
          };
          if (callback(lot)) return true;
        }
    }
    return false;
  };
  // Required landmarks use the same complete actual transformed footprint test.
  if (input.temple) {
    const glyph = resolveGlyphFor(input.biome ?? 'temperate', 'sm-chapel'),
      [width] = nominalFootprint(glyph);
    const entry: DeckEntry = { glyph, occupancy: 0, weight: 1, sizeFactor: 1, minFrontage: width };
    if (
      !lots(Math.max(frontage, width), (lot) =>
        tryLot({ ...lot, id: `landmark:${lot.id}` }, entry, true),
      )
    )
      w.fail(
        'LANDMARK_CAPACITY',
        'placement',
        'required temple has no suitable complete footprint',
      );
  }
  lots(frontage, (lot) => {
    if (c.mode === 'isolated' && placed.some((b) => !b.landmark)) return true;
    if (capacity >= input.population) return true;
    let roll = rng.float() * deck.reduce((n, e) => n + e.weight, 0),
      entry = deck[deck.length - 1];
    for (const e of deck) {
      roll -= e.weight;
      if (roll <= 0) {
        entry = e;
        break;
      }
    }
    tryLot(lot, entry, false);
    return capacity >= input.population;
  });
  return placed;
}
