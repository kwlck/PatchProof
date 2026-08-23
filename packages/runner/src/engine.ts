import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalize, decidePolicy, sha256, type PolicyDecision } from '@patchproof/core';
import { assertSafeRelativePath, type PatchProofConfig } from '@patchproof/config';
import { DockerBackend } from './docker.js';
import { LocalProcessBackend } from './process.js';
import { applyOperatorPolicy, resolveOperatorPolicy, type OperatorPolicyInput } from './policy.js';
import {
  cleanupWorkspace,
  copyWorkspaceSafe,
  hashKnownLockfile,
  materializeScenarioFile,
  prepareDockerWorkspace,
  sourceIdentity,
} from './workspace.js';
import type { ExecutionBackend, ExecutionSpec, RevisionRun, TwoRevisionRun } from './types.js';

export interface TwoRevisionOptions {
  config: PatchProofConfig;
  basePath: string;
  headPath: string;
  baseRef?: string;
  headRef?: string;
  fork?: boolean;
  backendOverride?: 'docker' | 'local';
  allowUnsafeLocal?: boolean;
  trustedConfig?: boolean;
  /** Optional operator-owned ceilings and image/isolation requirements. */
  operatorPolicy?: OperatorPolicyInput;
  /** Cancels active provisioning/scenario work while preserving cleanup. */
  signal?: AbortSignal;
}

export interface PolicyDeniedRun {
  policy: PolicyDecision;
  reason: string;
}

export function chooseBackend(
  config: PatchProofConfig,
  options: TwoRevisionOptions,
): ExecutionBackend {
  const backend = options.backendOverride ?? config.policy.backend;
  return backend === 'local' ? new LocalProcessBackend() : new DockerBackend();
}

function scenarioEnvironmentFor(
  config: PatchProofConfig,
  revision: 'base' | 'head',
): Record<string, string> {
  return {
    ...config.scenario.environment,
    CI: '1',
    PATCHPROOF_REVISION: revision,
  };
}

function launcherEnvironmentFor(): Record<string, string> {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
  };
}

function launcherSummary(environment: Record<string, string>): {
  omitted: true;
  keys: string[];
  sha256: string;
} {
  const keys = Object.keys(environment).sort();
  return { omitted: true, keys, sha256: sha256(canonicalize(environment)) };
}

export async function runTwoRevisions(
  options: TwoRevisionOptions,
): Promise<TwoRevisionRun | PolicyDeniedRun> {
  const operatorPolicy =
    options.operatorPolicy === undefined
      ? undefined
      : resolveOperatorPolicy(options.operatorPolicy);
  // Select the effective backend before applying operator constraints. This
  // prevents a Docker override from bypassing image and isolation checks that
  // would otherwise inspect only the repository-declared backend.
  const selectedBackend = options.backendOverride ?? options.config.policy.backend;
  const effectiveRepositoryPolicy = {
    ...options.config.policy,
    backend: selectedBackend,
  };
  const operatorDecision =
    operatorPolicy === undefined
      ? undefined
      : applyOperatorPolicy(effectiveRepositoryPolicy, operatorPolicy);
  if (operatorDecision !== undefined && !operatorDecision.allowed)
    return {
      policy: {
        allowed: false,
        outcome: 'POLICY_DENIED',
        reason: operatorDecision.reason ?? 'Operator policy denied execution',
      },
      reason: operatorDecision.reason ?? 'Operator policy denied execution',
    };
  const configuredPolicy = operatorDecision?.policy ?? effectiveRepositoryPolicy;
  const backend = configuredPolicy.backend;
  if (operatorPolicy?.forceDocker && backend !== 'docker') {
    const reason =
      'Operator policy requires the Docker backend; local process execution is not permitted';
    return { policy: { allowed: false, outcome: 'POLICY_DENIED', reason }, reason };
  }
  const decision = decidePolicy({
    backend,
    // Unsafe local execution requires both independent authorities. A
    // repository cannot opt itself into host execution, and a CLI flag cannot
    // override a trusted base policy that disallows it.
    allowUnsafeLocal:
      options.allowUnsafeLocal === true && options.config.policy.allowUnsafeLocal === true,
    fork: options.fork === true,
    allowFork: options.config.policy.allowFork,
    trustedConfig: options.trustedConfig === true,
  });
  if (!decision.allowed) return { policy: decision, reason: decision.reason ?? 'Execution denied' };
  if (configuredPolicy.network === 'allowlist') {
    const policy = {
      allowed: false,
      outcome: 'POLICY_DENIED' as const,
      reason:
        'Network allowlists require an operator-provided enforcing adapter; egress was not enabled',
    };
    return { policy, reason: policy.reason };
  }

  const basePath = resolve(options.basePath);
  const headPath = resolve(options.headPath);
  let workRoot: string;
  try {
    workRoot = await mkdtemp(join(tmpdir(), 'patchproof-'));
  } catch (error) {
    throw new Error(
      `INFRA_ERROR: cannot create the execution workspace: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const baseWork = join(workRoot, 'base');
  const headWork = join(workRoot, 'head');
  try {
    try {
      await copyWorkspaceSafe(basePath, baseWork);
      await copyWorkspaceSafe(headPath, headWork);
    } catch (error) {
      throw new Error(
        `INFRA_ERROR: workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let scenarioFileSha256: string | undefined;
    if (options.config.scenario.file !== undefined) {
      const safeFile = assertSafeRelativePath(options.config.scenario.file, 'scenario.file');
      scenarioFileSha256 = await materializeScenarioFile(baseWork, headWork, safeFile);
    }
    if (backend === 'docker') {
      await prepareDockerWorkspace(baseWork);
      await prepareDockerWorkspace(headWork);
    }
    const baseSource = await sourceIdentity(basePath, options.baseRef ?? 'base');
    const headSource = await sourceIdentity(headPath, options.headRef ?? 'head');
    const safeCwd =
      options.config.scenario.cwd === '.'
        ? '.'
        : assertSafeRelativePath(options.config.scenario.cwd, 'scenario.cwd');
    const runRevision = async (
      revision: 'base' | 'head',
      workspace: string,
      source: typeof baseSource,
    ): Promise<RevisionRun> => {
      const environment = scenarioEnvironmentFor(options.config, revision);
      const launcherEnvironment = launcherEnvironmentFor();
      const spec: ExecutionSpec = {
        revision,
        workspace,
        command: [...options.config.scenario.command],
        cwd: safeCwd,
        environment,
        launcherEnvironment,
        timeoutMs: configuredPolicy.timeoutMs,
        outputBytes: configuredPolicy.outputBytes,
        secrets: options.config.redaction.secrets,
        policy: { ...configuredPolicy, backend },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(operatorPolicy === undefined
          ? {}
          : { provisioningTimeoutMs: operatorPolicy.provisioningTimeoutMs }),
      };
      const execution = await backendInstance.run(spec);
      const dependencyLock = await hashKnownLockfile(workspace);
      return {
        revision,
        source: { ...source, location: revision === 'base' ? basePath : headPath },
        execution,
        environment,
        launcherEnvironment: launcherSummary(launcherEnvironment),
        dependencyLock:
          dependencyLock === undefined
            ? { status: 'not-detected' as const }
            : { status: 'present' as const, ...dependencyLock },
      };
    };
    const backendInstance = chooseBackend(options.config, options);
    const base = await runRevision('base', baseWork, baseSource);
    const head = await runRevision('head', headWork, headSource);
    // The finally block below is awaited before this promise resolves, so the returned evidence can state cleanup succeeded.
    return {
      base,
      head,
      workRoot,
      ...(scenarioFileSha256 === undefined ? {} : { scenarioFileSha256 }),
      cleanedUp: true,
    };
  } finally {
    await cleanupWorkspace(workRoot);
  }
}

export function isPolicyDeniedRun(
  value: TwoRevisionRun | PolicyDeniedRun,
): value is PolicyDeniedRun {
  return 'policy' in value && 'reason' in value;
}

export const RUNNER_VERSION = '0.1.0';
