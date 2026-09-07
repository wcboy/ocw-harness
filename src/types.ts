export type WorkflowStatus = "complete" | "active" | "pending" | "attention";
export type ConnectionStatus = "connecting" | "live" | "polling" | "reconnecting" | "offline";
export type AgentWorkState = "working" | "complete" | "attention" | "queued" | "unknown";
export type HarnessPresence = "working" | "active" | "idle" | "complete" | "closed" | "unavailable" | "failed" | "cancelled" | "lost";

export interface HarnessRegistryPhase {
  id: string;
  title: string;
  status: WorkflowStatus;
  progress: number;
}

export interface HarnessRegistrationSummary {
  backupStatus?: string | null;
  registrationId: string;
  taskId: string;
  sessionId: string;
  label: string;
  sourceRoot: string;
  adapter: string;
  lifecycle: string;
  registeredAt: string;
  heartbeatAt: string;
  closedAt: string | null;
  processId: number | null;
  processAlive: boolean | null;
  frontendPath: string;
  available: boolean;
  presence: HarnessPresence;
  liveness: string;
  sourceStatus: string;
  ownership: string;
  unverifiedAssignments: number;
  activeAssignments: number;
  verifiedAt?: string;
  objective: string;
  phase: string;
  revision: number;
  updatedAt: string | null;
  lastActivityAt: string | null;
  nextAction: string;
  blockers: number;
  workingAgents: number;
  workingAssignments: AgentBinding[];
  checkpointsComplete: number;
  checkpointsTotal: number;
  progress: number;
  phases: HarnessRegistryPhase[];
  error: string | null;
}

export interface HarnessRegistrySnapshot {
  revision: number;
  schemaVersion: string;
  generatedAt: string;
  runtime: {
    bindingId: string;
    required: boolean;
    status: "bound" | "degraded";
    startedAt: string;
    frontendUrl: string;
    registryMode: true;
    registryDir: string;
    connectedClients: number;
    frontendAttached: boolean;
  };
  counts: {
    registrations: number;
    tasks: number;
    sessions: number;
    working: number;
    active: number;
    unavailable: number;
    workingAgents: number;
  };
  registrations: HarnessRegistrationSummary[];
  errors: Array<{ file: string; message: string }>;
}

/** Where a binding was resolved from, so inherited ownership is never shown as direct. */
export type AgentScope = "path" | "checkpoint" | "edge";

export interface AgentBinding {
  assignmentId: string;
  attemptId?: string | null;
  leaseEpoch?: number | null;
  leaseExpiresAt?: string | null;
  declaredWorking?: boolean;
  liveness?: string;
  ownership?: string;
  workerInstanceId?: string | null;
  sessionId?: string | null;
  /** Null for a phase-scoped assignment such as the R4 single writer. */
  edgeId: string | null;
  routeId: string | null;
  phase: string | null;
  agentRef: string | null;
  displayName: string;
  role: string;
  status: string;
  workState: AgentWorkState;
  working: boolean;
  updatedAt: string;
  checkpointIds: string[];
  pathIds: string[];
  scope?: AgentScope;
  /** True when this binding came from an enclosing scope rather than this node. */
  inherited?: boolean;
}

export interface WorkflowPhase {
  id: string;
  title: string;
  owner: string;
  gate: string;
  gateStatus: string;
  activePhases: string[];
  description: string;
  status: WorkflowStatus;
  progress: number;
}

/**
 * How a status was arrived at. Accepted interface records are edge/bundle scoped
 * and carry no per-checkpoint verdict, so `edge_accepted` means "derived from the
 * owning task edge" and must be presented that way rather than as independent
 * per-checkpoint acceptance.
 */
export type StatusSource = "edge_accepted" | "phase_inferred" | "derived" | "runtime_checkpoint" | "demo";

export interface RuntimeEvidence { ref: string; sha256: string; record: Record<string, unknown>; }

export interface Checkpoint {
  label?: string;
  acceptance?: RuntimeEvidence | null;
  id: string;
  l1Id: string;
  objective: string;
  targetRules: string[];
  preconditions: string[];
  postconditions: string[];
  invariants: string[];
  acceptanceOracle: string;
  dependsOn: string[];
  providesTo: string[];
  status: WorkflowStatus;
  statusSource?: StatusSource;
  worker?: AgentBinding | null;
}

export interface CheckpointGroup {
  id: string;
  label: string;
  sequence: number;
  edgeId: string | null;
  objective: string;
  status: WorkflowStatus;
  statusSource?: StatusSource;
  acceptedRevision: number | null;
  acceptedRef: string | null;
  progress: number;
  checkpoints: Checkpoint[];
}

export type CheckpointTreeNodeKind = "phase" | "goal" | "checkpoint";

export interface CheckpointTreeNode {
  id: string;
  label: string;
  objective: string;
  depth: number;
  kind: CheckpointTreeNodeKind;
  status: WorkflowStatus;
  statusSource?: StatusSource;
  edgeId: string | null;
  checkpointId: string | null;
  worker?: AgentBinding | null;
  acceptanceOracle?: string | null;
  invariants?: string[];
  dependsOn?: string[];
  providesTo?: string[];
  children: CheckpointTreeNode[];
}

export interface CheckpointTree {
  schemaVersion: string;
  currentMaxDepth: number;
  rendererMaxDepth: number;
  recursive: boolean;
  root: CheckpointTreeNode;
}

export interface RouteCandidate {
  id: string;
  revision: number;
  title: string;
  rank: number;
  routeClass: string;
  status: string;
  selected: boolean;
  recommended: boolean;
  selectedAtRevision: number | null;
  evidenceCeiling: string;
  ref: string;
  digest: string;
  pathSequence: string[];
}

export interface RouteDecision {
  id: string;
  status: string;
  selectedRoute: string | null;
  routeRevision: number | null;
  stateRevision: number | null;
  phaseScope: string | null;
  requiredContent: string[];
  explicitOutOfScope: string[];
}

export interface ImplementationCandidate {
  number: number;
  digest: string;
  semanticVerdict: string;
  mechanicalVerdict: string;
  status: string;
  corrections: string[];
  passed: boolean;
}

export interface RouteImplementation {
  routeId: string | null;
  status: string;
  productRef: string | null;
  productDigest: string | null;
  productLines: number | null;
  productWords: number | null;
  vectorCount: number | null;
  mirrorPassed: boolean;
  r5Verdict: string;
  deploymentStatus: string;
  claimCeiling: Record<string, string>;
  candidateHistory: ImplementationCandidate[];
}

export interface RouteFlow {
  candidates: RouteCandidate[];
  decision: RouteDecision;
  implementation: RouteImplementation;
}

/** Which record an attempt was recovered from, shown as evidence provenance. */
export type PathOrigin =
  | "runtime"
  | "demo"
  | "accepted"
  | "correction"
  | "carried_forward"
  | "variant_not_selected"
  | "candidate_not_selected"
  | "prior_revision";

export interface PathAttempt {
  verdict?: string;
  selection?: { path_id: string; revision: number; actor: string; reason: string } | null;
  evidence?: RuntimeEvidence | null;
  attemptHistory?: Array<{id: string; checkpoint: string; owner: string; status: string; epoch: number; started: string; ended: string | null; acceptance?: RuntimeEvidence | null}>;
  shortLabel?: string;
  id: string;
  edgeId: string;
  label: string;
  order: number;
  origin: PathOrigin;
  category: string;
  status: string;
  selected: boolean;
  mechanism: string;
  summary: string;
  reason: string | null;
  keyCost: string | null;
  claimScope: string | null;
  evidenceLevel: string | null;
  deploymentStatus: string | null;
  memoryRef: string | null;
  evidenceRef: string | null;
  worker: AgentBinding | null;
}

/** A superseded accepted interface, retained so invalidations stay auditable. */
export interface PriorAcceptedRevision {
  revision: number | null;
  ref: string;
  status: string | null;
  invalidationReason: string | null;
}

export interface JourneyEdge {
  id: string;
  label: string;
  shortLabel: string;
  from: string[];
  to: string;
  startGuarantees: string[];
  endGuarantees: string[];
  status: WorkflowStatus;
  statusSource?: StatusSource;
  acceptedRevision: number | null;
  priorRevisions: PriorAcceptedRevision[];
  paths: PathAttempt[];
  selectedPaths: number;
  worker: AgentBinding | null;
}

export interface JourneyNode {
  id: string;
  goalId: string;
  edgeId: string | null;
  label: string;
  objective: string;
  status: WorkflowStatus;
  statusSource?: StatusSource;
  worker: AgentBinding | null;
  treeNode?: CheckpointTreeNode | null;
  checkpoints: Checkpoint[];
}

export interface JourneyLayer {
  index: number;
  label: string;
  orthogonal: boolean;
  nodes: JourneyNode[];
}

export interface JourneyModel {
  root: {
    id: string;
    label: string;
    objective: string;
    status: WorkflowStatus;
  };
  layers: JourneyLayer[];
  transitions: Array<{
    index: number;
    label: string;
    edges: JourneyEdge[];
  }>;
  routes: RouteCandidate[];
  selectedRoute: RouteCandidate | null;
  implementation: RouteImplementation;
  pathGranularity: "bundle_transition";
  cycleCheck: string;
}

export type JourneySelection =
  | { kind: "edge"; id: string }
  | { kind: "path"; id: string; edgeId: string }
  | { kind: "checkpoint"; id: string }
  | { kind: "route"; id: string }
  | { kind: "task"; id: string }
  | { kind: "goal"; id: string };

export interface WorkflowEvent {
  eventId: string;
  type: string;
  fromRevision: number;
  toRevision: number;
  fromPhase: string;
  toPhase: string;
  actor: string;
  at: string;
  tone: "neutral" | "success" | "warning" | "danger";
  payload: Record<string, unknown>;
}

export interface WorkflowSnapshot {
  execution?: { engine: string; accepted: number; total: number; interruptedAttempts: number; unknownOperations: number; dataEpoch: number; restoreHold: boolean; backup?: { status: string; error?: string; finishedAt?: string } | null } | null;
  persistenceError?: string | null;
  contentFingerprint: string;
  sourceStatus: string;
  sourceError: string | null;
  verifiedAt: string;
  generatedAt: string;
  sourceRoot: string;
  runtime: {
    bindingId: string;
    dataEpoch?: number;
    sourceObservationSeq?: number;
    observationSeq?: number;
    required: boolean;
    status: "bound" | "degraded";
    startedAt: string;
    frontendUrl: string;
    sourceRoot: string;
    sourceMode: string;
    renderMode: string;
    registryMode: true;
    registryDir: string;
    registrationId: string;
    liveness: string;
    instanceId: string | null;
    sessionId: string;
    connectedClients: number;
    frontendAttached: boolean;
  };
  task: {
    id: string;
    objective: string;
    revision: number;
    phase: string;
    updatedAt: string;
    nextAction: string;
    blockers: unknown[];
    selectedRoute: string | null;
    decisionStatus: string;
  };
  phases: WorkflowPhase[];
  groups: CheckpointGroup[];
  checkpointTree: CheckpointTree;
  routeFlow: RouteFlow;
  journey: JourneyModel;
  agentActivity: {
    workingCount: number;
    activeAssignmentCount: number;
    unverifiedAssignmentCount: number;
    assignments: AgentBinding[];
  };
  events: WorkflowEvent[];
  metrics: {
    featuresPassed: number;
    featuresTotal: number;
    checkpointsComplete: number;
    checkpointsTotal: number;
    events: number;
    revision: number;
  };
  integrity: {
    chainHealthy: boolean;
    chainIssues: string[];
    productDigest: string | null;
    expectedProductDigest: string | null;
    productDigestMatches: boolean;
    mirrorDigest: string | null;
    mirrorDigestMatches: boolean;
    mirrorReview: string;
    baselineDigest: string | null;
  };
}
