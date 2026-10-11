import type { ScenePoint } from '../../scene/scene.js';
import type { LocalBounds } from '../../generator/bounds.js';
import type { SettlementModel, ResidentAccount } from '../model.js';

export const CONSTRAINT_VERSION = 'constrained-frontage-v1' as const;
/** Local metres: x east, y south; compass bearings are north=0, clockwise. */
export interface ConstraintPolygon {
  outer: ScenePoint[];
  holes: ScenePoint[][];
}
export interface ConstraintWater {
  id: string;
  polygons: ConstraintPolygon[];
}
export interface ConstraintEntrance {
  id: string;
  routeIds: string[];
  endpoint: ScenePoint;
  bearingDeg: number;
  widthM: number;
  surfaceWidthM: number;
  setbackM: number;
}
export interface ConstraintCrossing {
  id: string;
  waterId: string;
  endpoints: [ScenePoint, ScenePoint];
  /** Complete reserved deck area, not just a centreline. */
  deck: ConstraintPolygon;
  widthM: number;
  endpointHeightsM: [number, number];
  minimumAbutmentM: number;
}
export interface ConstraintLimits {
  maxInputNodes: number;
  maxInputVertices: number;
  maxPolygonVertices: number;
  maxPlanningCells: number;
  maxRoutingExpansions: number;
  maxGlobalRoutingExpansions: number;
  maxPlacementAttempts: number;
  maxAttemptsPerBuilding: number;
  maxBuildings: number;
  maxOutputFeatures: number;
  maxOutputVertices: number;
  maxWork: number;
}
export interface ConstraintBudget {
  readonly used: number;
  take(units: number, stage?: string): void;
}
export interface ConstraintCertificate {
  ok: boolean;
  code?: string;
  message?: string;
  /** Required on success; the authority certifies the COMPLETE requested shape. */
  maxGradient?: number;
  maxGrade?: number;
}
export interface FootprintRequest {
  id: string;
  kind: 'building' | 'landmark';
  polygon: ConstraintPolygon;
  maxFoundationGradient: number;
}
export interface CorridorRequest {
  id: string;
  path: ScenePoint[];
  widthM: number;
  surfaceWidthM: number;
  setbackM: number;
  maxGrade: number;
  crossing?: ConstraintCrossing;
  /** Only this endpoint's outside round cap may be clipped to permissible land. */
  entrance?: ConstraintEntrance;
}
export interface SettlementConstraints {
  version: 1;
  terrainIdentity: string;
  mode?: 'village' | 'farm' | 'isolated';
  bounds: LocalBounds;
  permissible: ConstraintPolygon;
  exclusions: ConstraintPolygon[];
  water: ConstraintWater[];
  entrances: ConstraintEntrance[];
  crossings: ConstraintCrossing[];
  maxFoundationGradient: number;
  maxRoadGrade: number;
  localWidthM?: number;
  localSurfaceWidthM?: number;
  localSetbackM?: number;
  planningSpacingM?: number;
  frontageSpacingM?: number;
  streetSpacingM?: number;
  joinToleranceM?: number;
  limits?: Partial<ConstraintLimits>;
  /** Whole-shape authority. Point samples alone are not acceptable certificates. */
  certifyFootprint(request: FootprintRequest, budget: ConstraintBudget): ConstraintCertificate;
  certifyCorridor(request: CorridorRequest, budget: ConstraintBudget): ConstraintCertificate;
  /** Optional cost-only query; never replaces either complete certificate. */
  heightAt?(point: ScenePoint, budget: ConstraintBudget): number;
}
export interface ConstraintDiagnostic {
  code: string;
  stage: string;
  message: string;
  featureId?: string;
}
export interface ConstraintWork {
  total: number;
  routingExpansions: number;
  placementAttempts: number;
  callbackCalls: number;
  outputFeatures: number;
  outputVertices: number;
}
export type ConstrainedSettlementResult =
  | {
      ok: true;
      model: SettlementModel;
      diagnostics: ConstraintDiagnostic[];
      work: ConstraintWork;
      population: ResidentAccount;
    }
  | {
      ok: false;
      diagnostics: ConstraintDiagnostic[];
      work: ConstraintWork;
      population: ResidentAccount;
    };
export interface ConstraintGraphNode {
  id: string;
  point: ScenePoint;
}
export interface ConstraintStreet {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  path: ScenePoint[];
  widthM: number;
  surfaceWidthM: number;
  setbackM: number;
  routeIds: string[];
  crossingId?: string;
  /** Retains the authoritative cap exemption after approach planarization. */
  entranceId?: string;
}
export interface ConstrainedLayoutMetadata {
  version: typeof CONSTRAINT_VERSION;
  terrainIdentity: string;
  mode: 'village' | 'farm' | 'isolated';
  nodes: ConstraintGraphNode[];
  streets: ConstraintStreet[];
  entrances: Array<ConstraintEntrance & { nodeId: string; streetId: string }>;
  crossings: Array<ConstraintCrossing & { streetIds: string[]; routeIds: string[] }>;
  water: ConstraintWater[];
  diagnostics: ConstraintDiagnostic[];
  work: ConstraintWork;
  buildings: Array<{
    id: string;
    lotId: string;
    streetId: string | null;
    glyph: string;
    position: ScenePoint;
    bearingDeg: number;
    footprint: [number, number];
    capacity: number;
    landmark: boolean;
    access: { streetId: string; path: [ScenePoint, ScenePoint]; widthM: number } | null;
  }>;
}
