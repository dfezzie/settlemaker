import type { ScenePoint } from '../../scene/scene.js';
import type {
  ConstraintCrossing,
  ConstraintEntrance,
  ConstraintStreet,
  SettlementConstraints,
} from './types.js';
import { Work } from './budget.js';
import {
  corridorOK,
  crossingOK,
  distance,
  pointKey,
  roundPoint,
  same,
  segmentDistance,
} from './geometry.js';

interface Link {
  to: number;
  crossing?: ConstraintCrossing;
  entrance?: ConstraintEntrance;
  widthM: number;
  surfaceWidthM: number;
  setbackM: number;
}
interface Edge {
  a: number;
  b: number;
  link: Link;
}
class Heap {
  private list: Array<{ id: number; f: number; g: number }> = [];
  private less(a: { id: number; f: number; g: number }, b: { id: number; f: number; g: number }) {
    return a.f < b.f || (a.f === b.f && (a.g < b.g || (a.g === b.g && a.id < b.id)));
  }
  push(item: { id: number; f: number; g: number }) {
    let i = this.list.length;
    this.list.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(item, this.list[p])) break;
      this.list[i] = this.list[p];
      i = p;
    }
    this.list[i] = item;
  }
  pop() {
    const first = this.list[0],
      last = this.list.pop()!;
    if (!this.list.length) return first;
    let i = 0;
    while (i * 2 + 1 < this.list.length) {
      let n = i * 2 + 1;
      if (n + 1 < this.list.length && this.less(this.list[n + 1], this.list[n])) n++;
      if (!this.less(this.list[n], last)) break;
      this.list[i] = this.list[n];
      i = n;
    }
    this.list[i] = last;
    return first;
  }
  get length() {
    return this.list.length;
  }
}
export class Router {
  readonly points: ScenePoint[] = [];
  readonly edges = new Map<string, Edge>();
  readonly terminalNodes = new Map<string, number>();
  private extra = new Map<number, Link[]>();
  private valid = new Map<string, boolean>();
  private heights = new Map<number, number>();
  private crossings: ConstraintCrossing[] = [];
  private readonly nx: number;
  private readonly ny: number;
  private readonly gridCount: number;
  constructor(
    readonly c: SettlementConstraints,
    readonly w: Work,
  ) {
    const pad = c.localWidthM! / 2 + 0.02,
      spacing = c.planningSpacingM!;
    const width = c.bounds.max_x - c.bounds.min_x - 2 * pad,
      height = c.bounds.max_y - c.bounds.min_y - 2 * pad;
    this.nx = Math.floor(width / spacing) + 1;
    this.ny = Math.floor(height / spacing) + 1;
    this.gridCount = this.nx * this.ny;
    if (
      this.nx < 1 ||
      this.ny < 1 ||
      !Number.isSafeInteger(this.gridCount) ||
      this.gridCount > w.limits.maxPlanningCells
    )
      w.fail(
        'CONSTRAINT_RESOURCE_LIMIT',
        'routing',
        'planning cell cap or insufficient bounded extent',
      );
    w.take(this.gridCount * 4, 'routing allocation');
    const ox = c.bounds.min_x + (c.bounds.max_x - c.bounds.min_x - (this.nx - 1) * spacing) / 2;
    const oy = c.bounds.min_y + (c.bounds.max_y - c.bounds.min_y - (this.ny - 1) * spacing) / 2;
    for (let y = 0; y < this.ny; y++)
      for (let x = 0; x < this.nx; x++)
        this.points.push(roundPoint({ x: ox + x * spacing, y: oy + y * spacing }));
    // Only explicitly supplied, fully certified deck edges can cross water.
    for (const crossing of c.crossings) {
      if (!crossingOK(c, crossing, w)) continue;
      this.crossings.push(crossing);
      const a = this.addPoint(crossing.endpoints[0]),
        b = this.addPoint(crossing.endpoints[1]);
      this.addLink(a, b, {
        to: b,
        crossing,
        widthM: crossing.widthM,
        surfaceWidthM: c.localSurfaceWidthM!,
        setbackM: c.localSetbackM!,
      });
      this.connectGrid(a, {
        x: crossing.endpoints[0].x - crossing.endpoints[1].x,
        y: crossing.endpoints[0].y - crossing.endpoints[1].y,
      });
      this.connectGrid(b, {
        x: crossing.endpoints[1].x - crossing.endpoints[0].x,
        y: crossing.endpoints[1].y - crossing.endpoints[0].y,
      });
    }
    for (const entrance of c.entrances) {
      const r = (entrance.bearingDeg * Math.PI) / 180,
        lead = entrance.widthM / 2 + spacing;
      const p = entrance.endpoint,
        inward = roundPoint({ x: p.x - Math.sin(r) * lead, y: p.y + Math.cos(r) * lead });
      const a = this.addPoint(p),
        b = this.addPoint(inward);
      const link = {
        to: b,
        entrance,
        widthM: entrance.widthM,
        surfaceWidthM: entrance.surfaceWidthM,
        setbackM: entrance.setbackM,
      };
      if (!this.allowed(a, b, link))
        w.fail(
          'ENTRANCE_CORRIDOR',
          'routing',
          'exact supplied approach is unsuitable',
          entrance.id,
        );
      this.addLink(a, b, link);
      this.connectGrid(b);
      this.terminalNodes.set(entrance.id, a);
    }
  }
  private addPoint(p: ScenePoint): number {
    this.w.take(this.points.length + 1, 'routing');
    const existing = this.points.findIndex((q) => pointKey(q) === pointKey(p));
    if (existing >= 0) return existing;
    if (this.points.length >= this.w.limits.maxPlanningCells)
      this.w.fail('CONSTRAINT_RESOURCE_LIMIT', 'routing', 'special planning node cap');
    this.w.take(1, 'routing allocation');
    this.points.push({ ...p });
    return this.points.length - 1;
  }
  private addLink(a: number, b: number, link: Link) {
    const aa = this.extra.get(a) ?? [],
      bb = this.extra.get(b) ?? [];
    this.w.take(2, 'routing allocation');
    aa.push({ ...link, to: b });
    bb.push({ ...link, to: a });
    this.extra.set(a, aa);
    this.extra.set(b, bb);
  }
  private connectGrid(a: number, outward?: ScenePoint): void {
    for (const b of this.nearest(this.points[a], 16)) {
      if (a === b) return;
      if (
        outward &&
        (this.points[b].x - this.points[a].x) * outward.x +
          (this.points[b].y - this.points[a].y) * outward.y <
          -1e-9
      )
        continue;
      const link = this.local(b);
      if (this.allowed(a, b, link)) {
        this.addLink(a, b, link);
        return;
      }
    }
  }
  nearest(p: ScenePoint, count = 1): number[] {
    this.w.take(this.gridCount * Math.ceil(Math.log2(this.gridCount + 1)) + 1, 'routing ranking');
    return Array.from({ length: this.gridCount }, (_, id) => id)
      .sort((a, b) => distance(p, this.points[a]) - distance(p, this.points[b]) || a - b)
      .slice(0, count);
  }
  private local(to: number): Link {
    return {
      to,
      widthM: this.c.localWidthM!,
      surfaceWidthM: this.c.localSurfaceWidthM!,
      setbackM: this.c.localSetbackM!,
    };
  }
  private key(a: number, b: number, link: Link) {
    return `${Math.min(a, b)}:${Math.max(a, b)}:${link.widthM}:${link.crossing?.id ?? ''}:${link.entrance?.id ?? ''}`;
  }
  private allowed(a: number, b: number, link: Link) {
    const key = this.key(a, b, link);
    this.w.take(1, 'routing');
    const cached = this.valid.get(key);
    if (cached !== undefined) return cached;
    if (!link.crossing) {
      this.w.take(this.crossings.length, 'bridge junctions');
      for (const bridge of this.crossings) {
        const p = this.points[a],
          q = this.points[b],
          [u, v] = bridge.endpoints;
        if (segmentDistance(p, q, u, v) > 1e-8) continue;
        let outside = false;
        for (const [end, opposite] of [
          [u, v],
          [v, u],
        ]) {
          const other = same(p, end) ? q : same(q, end) ? p : null;
          if (
            other &&
            (other.x - end.x) * (end.x - opposite.x) + (other.y - end.y) * (end.y - opposite.y) >=
              -1e-9
          )
            outside = true;
        }
        if (!outside) {
          this.valid.set(key, false);
          return false;
        }
      }
    }
    const ok = corridorOK(
      this.c,
      {
        id: `candidate:${key}`,
        path: [this.points[a], this.points[b]],
        widthM: link.widthM,
        surfaceWidthM: link.surfaceWidthM,
        setbackM: link.setbackM,
        maxGrade: this.c.maxRoadGrade,
        ...(link.crossing ? { crossing: link.crossing } : {}),
        ...(link.entrance ? { entrance: link.entrance } : {}),
      },
      this.w,
    );
    this.w.take(1, 'routing allocation');
    this.valid.set(key, ok);
    return ok;
  }
  private neighbours(a: number): Link[] {
    const list = [...(this.extra.get(a) ?? [])];
    if (a < this.gridCount) {
      if (a % this.nx) list.push(this.local(a - 1));
      if (a % this.nx < this.nx - 1) list.push(this.local(a + 1));
      if (a >= this.nx) list.push(this.local(a - this.nx));
      if (a + this.nx < this.gridCount) list.push(this.local(a + this.nx));
    }
    return list.filter((link) => this.allowed(a, link.to, link));
  }
  private height(id: number) {
    if (!this.c.heightAt) return 0;
    const old = this.heights.get(id);
    if (old !== undefined) return old;
    this.w.take(1, 'height');
    this.w.stats.callbackCalls++;
    const w = this.w;
    const h = this.c.heightAt(
      Object.freeze({ ...this.points[id] }),
      Object.freeze({
        get used() {
          return w.used;
        },
        take: (n: number) => w.take(n, 'height authority'),
      }),
    );
    if (!Number.isFinite(h)) throw new TypeError('heightAt: finite height required');
    this.heights.set(id, h);
    return h;
  }
  route(start: number, end: number): boolean {
    if (start === end) return true;
    const n = this.points.length;
    this.w.take(n * 4, 'routing allocation');
    const costs = new Float64Array(n);
    costs.fill(Infinity);
    costs[start] = 0;
    const closed = new Uint8Array(n),
      parents = new Int32Array(n);
    parents.fill(-1);
    const links: Array<Link | undefined> = new Array(n),
      heap = new Heap();
    heap.push({ id: start, g: 0, f: distance(this.points[start], this.points[end]) });
    let expansions = 0;
    while (heap.length) {
      this.w.take(Math.ceil(Math.log2(n + 1)), 'routing heap');
      const item = heap.pop(),
        a = item.id;
      if (closed[a] || item.g !== costs[a]) continue;
      this.w.expand(expansions++);
      closed[a] = 1;
      if (a === end) {
        for (let b = end; b !== start; b = parents[b]) {
          const p = parents[b],
            link = links[b]!;
          const key = this.key(p, b, link);
          if (!this.edges.has(key)) {
            this.w.take(1, 'routing allocation');
            this.edges.set(key, { a: p, b, link });
          }
        }
        return true;
      }
      for (const link of this.neighbours(a)) {
        const b = link.to;
        if (closed[b]) continue;
        const len = distance(this.points[a], this.points[b]);
        const cost =
          costs[a] + len + (link.crossing ? 0 : 4 * Math.abs(this.height(a) - this.height(b)));
        if (cost >= costs[b]) continue;
        costs[b] = cost;
        parents[b] = a;
        links[b] = link;
        this.w.take(Math.ceil(Math.log2(n + 1)) + 1, 'routing heap');
        heap.push({ id: b, g: cost, f: cost + distance(this.points[b], this.points[end]) });
      }
    }
    return false;
  }
  streets(): ConstraintStreet[] {
    this.w.take(this.edges.size * 2, 'streets');
    return [...this.edges.values()]
      .map(({ a, b, link }) => {
        const pa = this.points[a],
          pb = this.points[b],
          aa = pointKey(pa),
          bb = pointKey(pb),
          first = aa < bb ? pa : pb,
          last = aa < bb ? pb : pa;
        return {
          id: `local-street:${pointKey(first)}:${pointKey(last)}:${link.crossing?.id ?? link.entrance?.id ?? 'ground'}`,
          fromNodeId: `local-node:${pointKey(first)}`,
          toNodeId: `local-node:${pointKey(last)}`,
          path: [{ ...first }, { ...last }],
          widthM: link.widthM,
          surfaceWidthM: link.surfaceWidthM,
          setbackM: link.setbackM,
          routeIds: link.entrance ? [...link.entrance.routeIds] : [],
          ...(link.crossing ? { crossingId: link.crossing.id } : {}),
          ...(link.entrance ? { entranceId: link.entrance.id } : {}),
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
