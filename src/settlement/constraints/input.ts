import type { AzgaarBurgInput } from '../../input/azgaar-input.js';
import type { SettlementOptions } from '../generate.js';
import { DEFAULT_CONSTRAINT_LIMITS, Work } from './budget.js';
import type { SettlementConstraints, ConstraintLimits } from './types.js';

/** Inspect descriptors before reading values. No getters, symbols, custom array
 * prototypes, hidden properties or cyclic graphs cross the constrained seam. */
export function preflight(value: unknown, work: Work, root = '$'): void {
  const seen = new Set<object>();
  let nodes = 0,
    vertices = 0;
  const visit = (v: unknown, path: string, depth: number): void => {
    work.take(1, 'input');
    if (++nodes > work.limits.maxInputNodes || depth > 32)
      work.fail('CONSTRAINT_RESOURCE_LIMIT', 'input', `${path}: input node/depth cap`);
    if (typeof v === 'string') {
      if (v.length > 8192) work.fail('CONSTRAINT_RESOURCE_LIMIT', 'input', `${path}: string cap`);
      work.take(Math.ceil(v.length / 64), 'input strings');
      return;
    }
    if (v === null || v === undefined || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new TypeError(`${path}: expected finite number`);
      return;
    }
    if (
      typeof v === 'function' &&
      /^\$\.options\.constraints\.(certifyFootprint|certifyCorridor|heightAt)$/.test(path)
    )
      return;
    if (typeof v !== 'object') throw new TypeError(`${path}: unsupported value`);
    if (seen.has(v)) throw new TypeError(`${path}: cyclic/shared object graph`);
    seen.add(v);
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      throw new TypeError(`${path}: custom prototype`);
    const keys = Reflect.ownKeys(v);
    if (keys.length > work.limits.maxInputNodes - nodes + 1)
      work.fail('CONSTRAINT_RESOURCE_LIMIT', 'input', `${path}: own key cap`);
    work.take(keys.length, 'input descriptors');
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError(`${path}: symbol key`);
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in d) || (!d.enumerable && !(array && key === 'length')))
        throw new TypeError(`${path}.${key}: accessor/hidden property`);
      if (array && key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
        throw new TypeError(`${path}.${key}: custom array property`);
      descriptors.set(key, d);
    }
    if (array) {
      const length = descriptors.get('length')!.value as number;
      if (length > work.limits.maxInputNodes - nodes || keys.length !== length + 1)
        work.fail('CONSTRAINT_RESOURCE_LIMIT', 'input', `${path}: array length/sparse cap`);
    }
    if (descriptors.has('x') && descriptors.has('y') && ++vertices > work.limits.maxInputVertices)
      work.fail('CONSTRAINT_RESOURCE_LIMIT', 'input', `${path}: vertex cap`);
    for (const [key, d] of descriptors)
      if (!(array && key === 'length')) visit(d.value, `${path}.${key}`, depth + 1);
    seen.delete(v);
  };
  visit(value, root, 0);
}
export function detach<T>(value: T): T {
  if (Array.isArray(value)) return value.map(detach) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, detach(v)])) as T;
  return value;
}
export function finite(
  value: unknown,
  path: string,
  min = -Infinity,
  max = Infinity,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new TypeError(`${path}: invalid finite number`);
}
export function identifier(v: unknown, path: string): asserts v is string {
  if (typeof v !== 'string' || !v.length || v.length > 256)
    throw new TypeError(`${path}: expected nonempty bounded ID`);
}
export function prepare(
  input: AzgaarBurgInput,
  options: SettlementOptions,
  work: Work,
): { input: AzgaarBurgInput; options: SettlementOptions; constraints: SettlementConstraints } {
  // Bootstrap only the bounded scalar limits chain through data descriptors.
  // The configured work cap is established before full input traversal.
  const object = (v: unknown, path: string): Record<string, unknown> => {
    if (
      !v ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
    )
      throw new TypeError(`${path}: plain object required`);
    return v as Record<string, unknown>;
  };
  const slot = (v: Record<string, unknown>, key: string, path: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d) return undefined;
    if (!('value' in d) || !d.enumerable)
      throw new TypeError(`${path}.${key}: accessor/hidden property`);
    return d.value;
  };
  const opt = object(options, 'options'),
    context = object(slot(opt, 'constraints', 'options'), 'options.constraints');
  const rawLimits = slot(context, 'limits', 'options.constraints');
  const supplied = rawLimits === undefined ? {} : object(rawLimits, 'options.constraints.limits');
  const rawWork = slot(supplied, 'maxWork', 'options.constraints.limits');
  if (
    rawWork !== undefined &&
    (!Number.isSafeInteger(rawWork) ||
      Number(rawWork) < 1 ||
      Number(rawWork) > DEFAULT_CONSTRAINT_LIMITS.maxWork)
  )
    throw new TypeError('limits.maxWork: invalid bounded integer');
  work.limits.maxWork = (rawWork as number | undefined) ?? DEFAULT_CONSTRAINT_LIMITS.maxWork;
  work.take(4, 'limits bootstrap');
  const limits = { ...DEFAULT_CONSTRAINT_LIMITS };
  const keys = Reflect.ownKeys(supplied);
  work.take(keys.length, 'limits descriptors');
  if (keys.length > Object.keys(limits).length) throw new TypeError('limits: too many keys');
  for (const key of keys) {
    if (typeof key !== 'string') throw new TypeError('limits: symbol key');
    const value = slot(supplied, key, 'options.constraints.limits');
    if (
      !(key in limits) ||
      !Number.isSafeInteger(value) ||
      Number(value) < 1 ||
      Number(value) > DEFAULT_CONSTRAINT_LIMITS[key as keyof ConstraintLimits]
    )
      throw new TypeError(
        `$.options.constraints.limits.${key}: positive integer bounded by hard default required`,
      );
    limits[key as keyof ConstraintLimits] = value as number;
  }
  work.limits = limits;
  preflight({ input, options }, work);
  work.take(work.used, 'input snapshot');
  const safe = detach({ input, options });
  const c = safe.options.constraints!;
  if (c.version !== 1) throw new TypeError('$.options.constraints.version: unsupported version');
  identifier(c.terrainIdentity, 'terrainIdentity');
  if (!['village', 'farm', 'isolated'].includes(c.mode ?? 'village'))
    throw new TypeError('mode: unsupported');
  if (typeof c.certifyFootprint !== 'function' || typeof c.certifyCorridor !== 'function')
    throw new TypeError('whole footprint and corridor certifiers are required');
  for (const k of ['min_x', 'min_y', 'max_x', 'max_y'] as const)
    finite(c.bounds?.[k], `bounds.${k}`, -1e6, 1e6);
  if (c.bounds.max_x <= c.bounds.min_x || c.bounds.max_y <= c.bounds.min_y)
    throw new TypeError('bounds: positive extent required');
  finite(c.maxFoundationGradient, 'maxFoundationGradient', 0, 10);
  finite(c.maxRoadGrade, 'maxRoadGrade', 0, 10);
  c.localWidthM ??= 4;
  c.localSurfaceWidthM ??= 2.4;
  c.localSetbackM ??= 0.3;
  c.planningSpacingM ??= 5;
  c.frontageSpacingM ??= 7;
  c.streetSpacingM ??= 18;
  c.joinToleranceM ??= 0.01;
  for (const k of [
    'localWidthM',
    'localSurfaceWidthM',
    'planningSpacingM',
    'frontageSpacingM',
    'streetSpacingM',
  ] as const)
    finite(c[k], k, 0.01, 1e4);
  finite(c.localSetbackM, 'localSetbackM', 0, 1e3);
  finite(c.joinToleranceM, 'joinToleranceM', 0, 0.01);
  if (c.localSurfaceWidthM > c.localWidthM)
    throw new TypeError('local surface exceeds reserved width');
  for (const k of ['exclusions', 'water', 'entrances', 'crossings'] as const)
    if (!Array.isArray(c[k])) throw new TypeError(`${k}: array required`);
  const ids = new Set<string>();
  for (const e of c.entrances) {
    identifier(e.id, 'entrance.id');
    if (ids.has(e.id)) throw new TypeError('entrance: duplicate ID');
    ids.add(e.id);
    finite(e.endpoint?.x, 'entrance.endpoint.x');
    finite(e.endpoint?.y, 'entrance.endpoint.y');
    finite(e.bearingDeg, 'entrance.bearingDeg', 0, 360 - Number.EPSILON * 360);
    finite(e.widthM, 'entrance.widthM', 0.01, 1e3);
    finite(e.surfaceWidthM, 'entrance.surfaceWidthM', 0.01, e.widthM);
    finite(e.setbackM, 'entrance.setbackM', 0, 1e3);
    if (
      !Array.isArray(e.routeIds) ||
      !e.routeIds.length ||
      new Set(e.routeIds).size !== e.routeIds.length
    )
      throw new TypeError('entrance.routeIds: nonempty unique IDs required');
    e.routeIds.forEach((v) => identifier(v, 'entrance.routeId'));
  }
  ids.clear();
  for (const water of c.water) {
    identifier(water.id, 'water.id');
    if (ids.has(water.id)) throw new TypeError('water: duplicate ID');
    ids.add(water.id);
    if (!Array.isArray(water.polygons) || !water.polygons.length)
      throw new TypeError('water.polygons: nonempty array required');
  }
  const crossingIds = new Set<string>();
  for (const b of c.crossings) {
    identifier(b.id, 'crossing.id');
    if (crossingIds.has(b.id) || !ids.has(b.waterId))
      throw new TypeError('crossing: duplicate/orphan ID');
    crossingIds.add(b.id);
    if (
      !Array.isArray(b.endpoints) ||
      b.endpoints.length !== 2 ||
      !Array.isArray(b.endpointHeightsM) ||
      b.endpointHeightsM.length !== 2
    )
      throw new TypeError('crossing: endpoint/profile tuple required');
    b.endpoints.forEach((p) => {
      finite(p?.x, 'crossing.endpoint.x');
      finite(p?.y, 'crossing.endpoint.y');
    });
    b.endpointHeightsM.forEach((h) => finite(h, 'crossing.endpointHeightM'));
    finite(b.widthM, 'crossing.widthM', c.localWidthM, 1e3);
    finite(b.minimumAbutmentM, 'crossing.minimumAbutmentM', 0, 1e3);
  }
  if (!Number.isSafeInteger(safe.input.population) || safe.input.population < 1)
    throw new TypeError('population: positive safe integer required');
  if (!Number.isSafeInteger(safe.options.seed))
    throw new TypeError('constrained seed: explicit safe integer required');
  return { input: safe.input, options: safe.options, constraints: c };
}
