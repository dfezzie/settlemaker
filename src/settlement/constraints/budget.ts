import type {
  ConstraintBudget,
  ConstraintDiagnostic,
  ConstraintLimits,
  ConstraintWork,
  ConstrainedSettlementResult,
} from './types.js';

export const DEFAULT_CONSTRAINT_LIMITS: Readonly<ConstraintLimits> = Object.freeze({
  maxInputNodes: 100_000,
  maxInputVertices: 10_000,
  maxPolygonVertices: 256,
  maxPlanningCells: 10_000,
  maxRoutingExpansions: 10_000,
  maxGlobalRoutingExpansions: 100_000,
  maxPlacementAttempts: 10_000,
  maxAttemptsPerBuilding: 5,
  maxBuildings: 1_000,
  maxOutputFeatures: 20_000,
  maxOutputVertices: 100_000,
  maxWork: 20_000_000,
});
/** Expected infeasibility only. Callback/programming/input errors are not caught. */
export class SettlementConstraintError extends Error {
  result?: Extract<ConstrainedSettlementResult, { ok: false }>;
  constructor(public diagnostic: ConstraintDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = 'SettlementConstraintError';
  }
}
export class Work implements ConstraintBudget {
  readonly stats: ConstraintWork = {
    total: 0,
    routingExpansions: 0,
    placementAttempts: 0,
    callbackCalls: 0,
    outputFeatures: 0,
    outputVertices: 0,
  };
  constructor(public limits: ConstraintLimits = { ...DEFAULT_CONSTRAINT_LIMITS }) {}
  get used() {
    return this.stats.total;
  }
  fail(code: string, stage: string, message: string, featureId?: string): never {
    throw new SettlementConstraintError({
      code,
      stage,
      message,
      ...(featureId ? { featureId } : {}),
    });
  }
  take(units: number, stage = 'constraints'): void {
    if (!Number.isSafeInteger(units) || units < 0)
      throw new TypeError('work units must be nonnegative safe integers');
    if (units > this.limits.maxWork - this.used) {
      this.stats.total = this.limits.maxWork;
      this.fail('CONSTRAINT_RESOURCE_LIMIT', stage, 'aggregate work budget exhausted');
    }
    this.stats.total += units;
  }
  reserve(features: number, vertices: number): void {
    this.take(1, 'output');
    if (
      features > this.limits.maxOutputFeatures - this.stats.outputFeatures ||
      vertices > this.limits.maxOutputVertices - this.stats.outputVertices
    )
      this.fail('CONSTRAINT_RESOURCE_LIMIT', 'output', 'output feature/vertex limit exhausted');
    this.stats.outputFeatures += features;
    this.stats.outputVertices += vertices;
  }
  attempt(): void {
    this.take(1, 'placement');
    if (this.stats.placementAttempts >= this.limits.maxPlacementAttempts)
      this.fail('CONSTRAINT_RESOURCE_LIMIT', 'placement', 'placement attempt limit exhausted');
    this.stats.placementAttempts++;
  }
  expand(routeUsed: number): void {
    this.take(1, 'routing');
    if (
      routeUsed >= this.limits.maxRoutingExpansions ||
      this.stats.routingExpansions >= this.limits.maxGlobalRoutingExpansions
    )
      this.fail('CONSTRAINT_RESOURCE_LIMIT', 'routing', 'routing expansion limit exhausted');
    this.stats.routingExpansions++;
  }
}
