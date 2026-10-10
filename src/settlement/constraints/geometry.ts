import polygonClipping from 'polygon-clipping';
import type { ScenePoint } from '../../scene/scene.js';
import { Work } from './budget.js';
import type {
  ConstraintPolygon,
  ConstraintEntrance,
  ConstraintCrossing,
  SettlementConstraints,
  CorridorRequest,
  FootprintRequest,
  ConstraintCertificate,
} from './types.js';
import { detach, preflight } from './input.js';

export const pointKey = (p: ScenePoint) => `${p.x},${p.y}`;
export const distance = (a: ScenePoint, b: ScenePoint) => Math.hypot(a.x - b.x, a.y - b.y);
export const same = (a: ScenePoint, b: ScenePoint) => a.x === b.x && a.y === b.y;
export const roundPoint = (p: ScenePoint): ScenePoint => ({
  x: Math.round(p.x * 1e6) / 1e6,
  y: Math.round(p.y * 1e6) / 1e6,
});
const ringEdges = (ring: ScenePoint[]) =>
  ring.map((a, i) => [a, ring[(i + 1) % ring.length]] as const);
const count = (p: ConstraintPolygon) => p.outer.length + p.holes.reduce((n, h) => n + h.length, 0);
export function boxesOverlap(a: ConstraintPolygon, b: ConstraintPolygon, w: Work): boolean {
  w.take(a.outer.length + b.outer.length + 1, 'geometry broad phase');
  const bounds = (p: ConstraintPolygon) => {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const q of p.outer) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    }
    return { minX, minY, maxX, maxY };
  };
  const aa = bounds(a),
    bb = bounds(b);
  return aa.minX <= bb.maxX && bb.minX <= aa.maxX && aa.minY <= bb.maxY && bb.minY <= aa.maxY;
}
const pc = (p: ConstraintPolygon): polygonClipping.Polygon =>
  [p.outer, ...p.holes].map((r) => r.map((q) => [q.x, q.y] as [number, number]));
const areaRing = (r: Array<[number, number]>) => {
  const o = r[0];
  let area = 0;
  for (let i = 1; i + 1 < r.length; i++)
    area += (r[i][0] - o[0]) * (r[i + 1][1] - o[1]) - (r[i][1] - o[1]) * (r[i + 1][0] - o[0]);
  return Math.abs(area / 2);
};
function area(polys: polygonClipping.MultiPolygon) {
  return polys.reduce(
    (n, p) => n + areaRing(p[0]) - p.slice(1).reduce((s, r) => s + areaRing(r), 0),
    0,
  );
}
function reserve(a: ConstraintPolygon, b: ConstraintPolygon, w: Work): void {
  // Pairwise intersection bound before the existing sweep/overlay library runs.
  const n = count(a) + count(b);
  w.take(n * n + 1, 'geometry');
}
export function differenceArea(a: ConstraintPolygon, b: ConstraintPolygon, w: Work): number {
  reserve(a, b, w);
  return area(polygonClipping.difference(pc(a), pc(b)));
}
export function intersectsArea(a: ConstraintPolygon, b: ConstraintPolygon, w: Work): boolean {
  reserve(a, b, w);
  return area(polygonClipping.intersection(pc(a), pc(b))) > 0;
}
function pointSegment(p: ScenePoint, a: ScenePoint, b: ScenePoint) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    q = dx * dx + dy * dy;
  const t = q ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / q)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function projectPoint(p: ScenePoint, a: ScenePoint, b: ScenePoint): ScenePoint {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    q = dx * dx + dy * dy,
    t = q ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / q)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}
export function nearestBoundary(p: ScenePoint, poly: ConstraintPolygon): ScenePoint {
  return ringEdges(poly.outer)
    .map(([a, b]) => projectPoint(p, a, b))
    .sort((a, b) => distance(p, a) - distance(p, b))[0];
}
export function strip(a: ScenePoint, b: ScenePoint, r: number): ConstraintPolygon {
  const length = distance(a, b),
    nx = (-(b.y - a.y) / length) * r,
    ny = ((b.x - a.x) / length) * r;
  return {
    outer: [
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ],
    holes: [],
  };
}
export function diskInsidePolygon(
  p: ScenePoint,
  r: number,
  poly: ConstraintPolygon,
  w: Work,
): boolean {
  w.take(count(poly) + 1, 'disk containment');
  return (
    containsPoint(p, poly) &&
    [poly.outer, ...poly.holes].every((ring) =>
      ringEdges(ring).every(([a, b]) => pointSegment(p, a, b) >= r - 1e-9),
    )
  );
}
export function diskTouchesPolygon(
  p: ScenePoint,
  r: number,
  poly: ConstraintPolygon,
  w: Work,
): boolean {
  w.take(count(poly) + 1, 'closed disk contact');
  return (
    containsPoint(p, poly) ||
    [poly.outer, ...poly.holes].some((ring) =>
      ringEdges(ring).some(([a, b]) => pointSegment(p, a, b) <= r + 1e-9),
    )
  );
}
export function segmentDistance(
  a: ScenePoint,
  b: ScenePoint,
  c: ScenePoint,
  d: ScenePoint,
): number {
  const cross = (p: ScenePoint, q: ScenePoint, r: ScenePoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const u = cross(a, b, c),
    v = cross(a, b, d),
    s = cross(c, d, a),
    t = cross(c, d, b);
  if (((u > 0 && v < 0) || (u < 0 && v > 0)) && ((s > 0 && t < 0) || (s < 0 && t > 0))) return 0;
  return Math.min(
    pointSegment(a, c, d),
    pointSegment(b, c, d),
    pointSegment(c, a, b),
    pointSegment(d, a, b),
  );
}
export function containsPoint(p: ScenePoint, poly: ConstraintPolygon): boolean {
  const insideRing = (r: ScenePoint[]) => {
    let inside = false;
    for (const [a, b] of ringEdges(r)) {
      if (pointSegment(p, a, b) <= 1e-9) return true;
      if (a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y))
        inside = !inside;
    }
    return inside;
  };
  return insideRing(poly.outer) && !poly.holes.some(insideRing);
}
export function touches(a: ConstraintPolygon, b: ConstraintPolygon, w: Work): boolean {
  if (!boxesOverlap(a, b, w)) return false;
  reserve(a, b, w);
  for (const r of [a.outer, ...a.holes])
    for (const s of [b.outer, ...b.holes])
      for (const [p, q] of ringEdges(r))
        for (const [u, v] of ringEdges(s)) if (segmentDistance(p, q, u, v) <= 1e-8) return true;
  return intersectsArea(a, b, w);
}
export function validatePolygon(p: ConstraintPolygon, w: Work, id: string): void {
  if (!p || !Array.isArray(p.outer) || !Array.isArray(p.holes))
    throw new TypeError(`${id}: polygon outer/holes required`);
  if (count(p) > w.limits.maxPolygonVertices)
    w.fail('CONSTRAINT_RESOURCE_LIMIT', 'input', `${id}: polygon vertex cap`);
  w.take(count(p) ** 2 + 1, 'topology');
  for (const ring of [p.outer, ...p.holes]) {
    if (ring.length > 1 && same(ring[0], ring[ring.length - 1])) ring.pop();
    if (ring.length < 3 || ring.some((v) => !v || !Number.isFinite(v.x) || !Number.isFinite(v.y)))
      throw new TypeError(`${id}: invalid ring`);
    if (areaRing(ring.map((v) => [v.x, v.y])) === 0) throw new TypeError(`${id}: zero-area ring`);
    for (let i = 0; i < ring.length; i++) {
      if (same(ring[i], ring[(i + 1) % ring.length]))
        throw new TypeError(`${id}: duplicate adjacent vertex`);
      for (let j = i + 1; j < ring.length; j++) {
        if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
        if (
          segmentDistance(
            ring[i],
            ring[(i + 1) % ring.length],
            ring[j],
            ring[(j + 1) % ring.length],
          ) <= 1e-9
        )
          throw new TypeError(`${id}: self-intersecting ring`);
      }
    }
  }
  const outer = { outer: p.outer, holes: [] };
  for (let i = 0; i < p.holes.length; i++) {
    const h = { outer: p.holes[i], holes: [] };
    if (
      differenceArea(h, outer, w) > 1e-10 ||
      ringEdges(h.outer).some(([a, b]) =>
        ringEdges(outer.outer).some(([c, d]) => segmentDistance(a, b, c, d) <= 1e-9),
      )
    )
      throw new TypeError(`${id}: hole outside/touches outer`);
    for (let j = 0; j < i; j++)
      if (touches(h, { outer: p.holes[j], holes: [] }, w))
        throw new TypeError(`${id}: overlapping holes`);
  }
}
/** Circumscribed 32-sided round caps, enlarged by 2 micrometres: conservative
 * complete corridor, including bends. Travelled surface does not set clearance. */
export function capsule(a: ScenePoint, b: ScenePoint, radius: number): ConstraintPolygon {
  const angle = Math.atan2(b.y - a.y, b.x - a.x),
    r = (radius + 2e-6) / Math.cos(Math.PI / 32);
  const outer: ScenePoint[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = angle - Math.PI / 2 + (i * Math.PI) / 16;
    outer.push({ x: b.x + r * Math.cos(t), y: b.y + r * Math.sin(t) });
  }
  for (let i = 0; i <= 16; i++) {
    const t = angle + Math.PI / 2 + (i * Math.PI) / 16;
    outer.push({ x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) });
  }
  return { outer, holes: [] };
}
export function disk(p: ScenePoint, radius: number, rotation = 0): ConstraintPolygon {
  const r = (radius + 4e-6) / Math.cos(Math.PI / 32);
  return {
    outer: Array.from({ length: 32 }, (_, i) => ({
      x: p.x + r * Math.cos(rotation + (i * Math.PI) / 16),
      y: p.y + r * Math.sin(rotation + (i * Math.PI) / 16),
    })),
    holes: [],
  };
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
export function certificate(
  c: SettlementConstraints,
  request: FootprintRequest | CorridorRequest,
  w: Work,
): ConstraintCertificate {
  w.take(1, 'certificate');
  w.stats.callbackCalls++;
  const before = w.used;
  preflight(request, w, '$request');
  w.take(w.used - before, 'certificate snapshot');
  const budget = Object.freeze({
    get used() {
      return w.used;
    },
    take: (n: number, stage?: string) => w.take(n, stage ?? 'authority'),
  });
  const result =
    'polygon' in request
      ? c.certifyFootprint(freeze(detach(request)), budget)
      : c.certifyCorridor(freeze(detach(request)), budget);
  preflight(result, w, '$certificate');
  if (!result || typeof result.ok !== 'boolean')
    throw new TypeError('certificate: expected {ok:boolean}');
  const value = 'polygon' in request ? result.maxGradient : result.maxGrade;
  if (result.ok && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
    throw new TypeError('certificate: finite nonnegative complete maximum required');
  return result;
}
export function footprintOK(c: SettlementConstraints, req: FootprintRequest, w: Work): boolean {
  if (differenceArea(req.polygon, c.permissible, w) > 1e-10) return false;
  for (const p of c.exclusions) if (touches(req.polygon, p, w)) return false;
  for (const water of c.water)
    for (const p of water.polygons) if (touches(req.polygon, p, w)) return false;
  const cert = certificate(c, req, w);
  return cert.ok && cert.maxGradient! <= c.maxFoundationGradient;
}
function clippedInside(
  shape: ConstraintPolygon,
  c: SettlementConstraints,
  w: Work,
  entrance?: ConstraintEntrance,
): boolean {
  if (!entrance) return differenceArea(shape, c.permissible, w) <= 1e-10;
  // Oblique arrivals have a small outside body wedge as well as the cap.
  // Clip only the finite, declared inward entrance mouth, never arbitrary
  // portions of a road or permissible holes. Water/exclusions stay uncut.
  const r = (entrance.bearingDeg * Math.PI) / 180,
    lead = entrance.widthM / 2 + (c.joinToleranceM ?? 0.01);
  const cap = capsule(
    entrance.endpoint,
    { x: entrance.endpoint.x - Math.sin(r) * lead, y: entrance.endpoint.y + Math.cos(r) * lead },
    entrance.widthM / 2 + 1e-5,
  );
  const n = count(shape) + count(c.permissible) + count(cap);
  w.take(n * n + 1, 'geometry');
  return area(polygonClipping.difference(pc(shape), pc(c.permissible), pc(cap))) <= 1e-10;
}
export function corridorOK(c: SettlementConstraints, req: CorridorRequest, w: Work): boolean {
  if (req.path.length !== 2 || distance(req.path[0], req.path[1]) <= 1e-6) return false;
  if (
    req.crossing &&
    (!(
      (same(req.path[0], req.crossing.endpoints[0]) &&
        same(req.path[1], req.crossing.endpoints[1])) ||
      (same(req.path[0], req.crossing.endpoints[1]) && same(req.path[1], req.crossing.endpoints[0]))
    ) ||
      req.widthM !== req.crossing.widthM)
  )
    return false;
  // A supplied canonical deck has exact reserved width. Its complete capsule
  // is certified as the exact rectangular strip plus two analytic round disks.
  const shape = req.crossing
    ? strip(req.path[0], req.path[1], req.widthM / 2)
    : capsule(req.path[0], req.path[1], req.widthM / 2);
  // The entrance exception concerns outer-boundary overflow only. A hole is
  // forbidden even when enclosed entirely within the finite mouth window.
  for (const hole of c.permissible.holes)
    if (touches(shape, { outer: hole, holes: [] }, w)) return false;
  if (!clippedInside(shape, c, w, req.entrance)) return false;
  if (req.crossing)
    for (const endpoint of req.path)
      if (!diskInsidePolygon(endpoint, req.widthM / 2, c.permissible, w)) return false;
  for (const p of c.exclusions) if (touches(shape, p, w)) return false;
  if (req.crossing)
    for (const p of c.exclusions)
      for (const endpoint of req.path)
        if (diskTouchesPolygon(endpoint, req.widthM / 2, p, w)) return false;
  for (const water of c.water)
    for (const p of water.polygons)
      if (touches(shape, p, w)) {
        if (!req.crossing || req.crossing.waterId !== water.id) return false;
        // Full wet reserved corridor must lie in the supplied deck, including holes.
        const n = count(shape) + count(p) + count(req.crossing.deck);
        w.take(n * n + 1, 'crossing');
        if (
          area(
            polygonClipping.difference(
              polygonClipping.intersection(pc(shape), pc(p)),
              pc(req.crossing.deck),
            ),
          ) > 1e-10
        )
          return false;
      }
  const cert = certificate(c, req, w);
  return cert.ok && cert.maxGrade! <= c.maxRoadGrade;
}
export function crossingOK(c: SettlementConstraints, b: ConstraintCrossing, w: Work): boolean {
  const [a, z] = b.endpoints,
    length = distance(a, z);
  if (
    length <= 1e-6 ||
    Math.abs(b.endpointHeightsM[1] - b.endpointHeightsM[0]) / length > c.maxRoadGrade
  )
    return false;
  if (
    differenceArea(strip(a, z, b.widthM / 2), b.deck, w) > 1e-10 ||
    !b.endpoints.every((p) => diskInsidePolygon(p, b.widthM / 2, b.deck, w))
  )
    return false;
  if (
    !c.water
      .find((water) => water.id === b.waterId)!
      .polygons.some((p) => touches(strip(a, z, b.widthM / 2), p, w))
  )
    return false;
  for (const end of b.endpoints)
    for (const water of c.water)
      for (const p of water.polygons)
        if (diskTouchesPolygon(end, b.widthM / 2 + b.minimumAbutmentM, p, w)) return false;
  return corridorOK(
    c,
    {
      id: b.id,
      path: b.endpoints,
      widthM: b.widthM,
      surfaceWidthM: Math.min(c.localSurfaceWidthM ?? 2.4, b.widthM),
      setbackM: c.localSetbackM ?? 0.3,
      maxGrade: c.maxRoadGrade,
      crossing: b,
    },
    w,
  );
}
