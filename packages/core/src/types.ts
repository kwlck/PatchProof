export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export type EvidenceSchemaVersion = typeof EVIDENCE_SCHEMA_VERSION;

export type RunOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'INFRA_ERROR' | 'POLICY_DENIED';

export type RevisionName = 'base' | 'head';

export interface ExpectedFailure {
  exitCode: number;
  reasonPattern?: string;
  reasonClass?: string;
}

export interface ScenarioSnapshot {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  trustedSource: 'base';
  file?: string;
  expectedFailure: ExpectedFailure;
  sha256: string;
}

export interface SourceSnapshot {
  revision: RevisionName;
  ref: string;
  sha256: string;
  kind: 'git-commit' | 'directory-tree';
  location: string;
}

export interface PolicySnapshot {
  backend: 'docker' | 'local';
  network: 'none' | 'allowlist';
  allowedHosts: string[];
  unsafeLocalProcess: boolean;
  fork: boolean;
  trustedConfigRevision: 'base';
  denialReason?: string;
  limits: {
    timeoutMs: number;
    outputBytes: number;
    memoryMb: number;
    cpuCount: number;
    pids: number;
  };
}

export interface ArtifactReference {
  id: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  mediaType: 'text/plain' | 'application/json' | 'application/octet-stream';
}

export interface LogEvidence {
  artifactId: string;
  preview: string;
  truncated: boolean;
  sizeBytes: number;
}

export interface LauncherEnvironmentEvidence {
  omitted: true;
  keys: string[];
  sha256: string;
}

export interface DependencyLockIdentity {
  status: 'present' | 'not-detected';
  file?: string;
  sha256?: string;
}

export interface ExecutionEvidence {
  revision: RevisionName;
  command: string[];
  cwd: string;
  environment: Record<string, string>;
  launcherEnvironment: LauncherEnvironmentEvidence;
  toolchain: {
    node: string;
    platform: string;
    arch: string;
    runner: string;
    dependencyLock: DependencyLockIdentity;
    containerImage?: string;
  };
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  startedAt: string;
  durationMs: number;
  stdout: LogEvidence;
  stderr: LogEvidence;
  error?: string;
}

export interface CompletenessReport {
  complete: boolean;
  checks: Record<string, boolean>;
  missing: string[];
}

export interface IntegrityRecord {
  algorithm: 'sha256';
  canonicalSha256: string;
  signer: null;
}

export interface EvidenceBundle {
  schemaVersion: EvidenceSchemaVersion;
  product: {
    name: 'PatchProof';
    version: string;
  };
  bundleId: string;
  createdAt: string;
  outcome: RunOutcome;
  verdict: string;
  scenario: ScenarioSnapshot;
  sources: {
    base: SourceSnapshot;
    head: SourceSnapshot;
  };
  policy: PolicySnapshot;
  executions: {
    base: ExecutionEvidence;
    head: ExecutionEvidence;
  };
  artifacts: ArtifactReference[];
  completeness: CompletenessReport;
  replay: {
    supported: boolean;
    baseLocation: string;
    headLocation: string;
    requiresExplicitConfirmation: true;
    recordedEnvironment: {
      node: string;
      platform: string;
      arch: string;
    };
  };
  integrity: IntegrityRecord;
}

export interface ClassificationInput {
  base: {
    exitCode: number | null;
    timedOut: boolean;
    error?: string;
    output: string;
  };
  head: {
    exitCode: number | null;
    timedOut: boolean;
    error?: string;
    output: string;
  };
  expectedFailure: ExpectedFailure;
  policyDenied?: string;
  complete: boolean;
}

export interface ClassificationResult {
  outcome: RunOutcome;
  verdict: string;
  baseExpectedFailure: boolean;
  headSuccess: boolean;
  reason: string;
}
