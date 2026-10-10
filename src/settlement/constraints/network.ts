import type { ScenePoint } from '../../scene/scene.js';
import type { ConstraintStreet } from './types.js';
import { Work } from './budget.js';
import { distance, pointKey, roundPoint } from './geometry.js';

/** Normalized intersections become explicit graph nodes. Final certificates
 * run on these emitted subsegments, not their unrounded parents. */
export function planarize(streets: ConstraintStreet[], w: Work): ConstraintStreet[] {
  w.take(streets.length ** 2 * 4 + 1, 'network planarization');
  const cuts = streets.map((s) => [
    { t: 0, p: s.path[0] },
    { t: 1, p: s.path[1] },
  ]);
  const cut = (i: number, p: ScenePoint) => {
    const s = streets[i],
      a = s.path[0],
      b = s.path[1],
      dx = b.x - a.x,
      dy = b.y - a.y,
      q = dx * dx + dy * dy;
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / q;
    if (t < -1e-10 || t > 1 + 1e-10 || distance(p, { x: a.x + t * dx, y: a.y + t * dy }) > 1e-7)
      return;
    if (t <= 1e-10 || t >= 1 - 1e-10) return;
    if (s.crossingId && t > 1e-9 && t < 1 - 1e-9)
      w.fail('CROSSING_JUNCTION', 'network', 'junction within an authoritative bridge span', s.id);
    w.take(1, 'network allocation');
    cuts[i].push({ t: Math.max(0, Math.min(1, t)), p: roundPoint(p) });
  };
  for (let i = 0; i < streets.length; i++)
    for (let j = i + 1; j < streets.length; j++) {
      const [a, b] = streets[i].path,
        [c, d] = streets[j].path;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        ex = d.x - c.x,
        ey = d.y - c.y,
        den = dx * ey - dy * ex;
      const norm = Math.hypot(dx, dy) * Math.hypot(ex, ey);
      if (Math.abs(den) > Number.EPSILON * norm * 8) {
        const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den,
          u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          const p = { x: a.x + t * dx, y: a.y + t * dy };
          cut(i, p);
          cut(j, p);
        }
      } else {
        cut(i, c);
        cut(i, d);
        cut(j, a);
        cut(j, b);
      }
    }
  const map = new Map<string, ConstraintStreet>();
  for (let i = 0; i < streets.length; i++) {
    cuts[i].sort((a, b) => a.t - b.t);
    const points = cuts[i]
      .filter((p, j, r) => j === 0 || pointKey(p.p) !== pointKey(r[j - 1].p))
      .map((p) => p.p);
    for (let j = 1; j < points.length; j++) {
      let a = points[j - 1],
        b = points[j];
      if (distance(a, b) < 1e-6) continue;
      if (pointKey(a) > pointKey(b)) [a, b] = [b, a];
      const s = streets[i],
        key = `${pointKey(a)}:${pointKey(b)}:${s.crossingId ?? 'ground'}`,
        old = map.get(key);
      if (old) {
        if (s.entranceId && old.entranceId && s.entranceId !== old.entranceId)
          w.fail(
            'ENTRANCE_OVERLAP',
            'network',
            'coincident approaches require identical entrance authority',
          );
        if (s.entranceId) old.entranceId = s.entranceId;
        old.routeIds = [...new Set([...old.routeIds, ...s.routeIds])].sort();
        old.widthM = Math.max(old.widthM, s.widthM);
        old.surfaceWidthM = Math.max(old.surfaceWidthM, s.surfaceWidthM);
        old.setbackM = Math.max(old.setbackM, s.setbackM);
      } else {
        // Reserve metadata street and scene road copies before insertion.
        w.reserve(2, 4);
        map.set(key, {
          ...s,
          id: `local-street:${key}`,
          path: [{ ...a }, { ...b }],
          fromNodeId: `local-node:${pointKey(a)}`,
          toNodeId: `local-node:${pointKey(b)}`,
          routeIds: [...s.routeIds],
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Straight connected frontage runs used only for candidate lots. Emitted
 * streets retain every graph junction and are certified independently. */
export function frontageRuns(streets: ConstraintStreet[], w: Work): ConstraintStreet[] {
  w.take(streets.length ** 2 + 1, 'frontage');
  const groups = new Map<string, ConstraintStreet[]>();
  for (const s of streets) {
    if (s.crossingId) continue;
    const [a, b] = s.path,
      horizontal = a.y === b.y,
      vertical = a.x === b.x;
    if (!horizontal && !vertical) {
      groups.set(s.id, [s]);
      continue;
    }
    const key = `${horizontal ? 'h' : 'v'}:${horizontal ? a.y : a.x}:${s.widthM}:${s.setbackM}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const runs: ConstraintStreet[] = [];
  for (const list of groups.values()) {
    const h = list[0].path[0].y === list[0].path[1].y;
    const value = (p: ScenePoint) => (h ? p.x : p.y);
    list.sort((a, b) => Math.min(...a.path.map(value)) - Math.min(...b.path.map(value)));
    let current: ConstraintStreet | undefined;
    for (const s of list) {
      let [a, b] = s.path;
      if (value(a) > value(b)) [a, b] = [b, a];
      if (current && value(a) <= value(current.path[1]) + 1e-9) {
        if (value(b) > value(current.path[1])) current.path[1] = { ...b };
      } else {
        current = { ...s, path: [{ ...a }, { ...b }] };
        runs.push(current);
      }
    }
  }
  return runs.sort(
    (a, b) =>
      distance(b.path[0], b.path[1]) - distance(a.path[0], a.path[1]) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
