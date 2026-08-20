import type { PatchProofConfig } from '@patchproof/config';
import type { DependencyLockIdentity, RevisionName } from '@patchproof/core';

export interface ExecutionSpec {
  revision: RevisionName;
  workspace: string;
  command: string[];
  cwd: string;
  environment: Record<string, string>;
  launcherEnvironment?: Record<string, string>;
  timeoutMs: number;
  outputBytes: number;
  secrets: string[];
  policy: PatchProofConfig['policy'];
  /** Abort only the scenario process; backend cleanup remains bounded and mandatory. */
  signal?: AbortSignal;
  /** Operator-owned provisioning budget, separate from scenario timeout. */
  provisioningTimeoutMs?: number;
}

export interface BackendExecution {
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  startedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutSizeBytes: number;
  stderrSizeBytes: number;
  /** True when the caller cancelled this execution. */
  cancelled?: boolean;
  /** True when output, rather than wall-clock timeout, requested termination. */
  outputLimitHit?: boolean;
  error?: string;
}

export interface ExecutionBackend {
  readonly kind: 'docker' | 'local';
  run(spec: ExecutionSpec): Promise<BackendExecution>;
}

export interface RevisionRun {
  revision: RevisionName;
  source: {
    ref: string;
    sha256: string;
    kind: 'git-commit' | 'directory-tree';
    location: string;
  };
  execution: BackendExecution;
  environment: Record<string, string>;
  launcherEnvironment: {
    omitted: true;
    keys: string[];
    sha256: string;
  };
  dependencyLock: DependencyLockIdentity;
}

export interface TwoRevisionRun {
  base: RevisionRun;
  head: RevisionRun;
  workRoot: string;
  scenarioFileSha256?: string;
  cleanedUp: boolean;
}
