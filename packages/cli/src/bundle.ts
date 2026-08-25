import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  canonicalize,
  classifyOutcomeGuarded,
  createIntegrity,
  PatternDeadlineExceededError,
  PatternWorkerCrashedError,
  redactText,
  sha256,
  type ClassificationResult,
  type EvidenceBundle,
  type DependencyLockIdentity,
  type ExecutionEvidence,
  type PolicySnapshot,
  type SourceSnapshot,
} from '@patchproof/core';
import type { ConfigParseResult, PatchProofConfig } from '@patchproof/config';
import {
  isPolicyDeniedRun,
  RUNNER_VERSION,
  type BackendExecution,
  type PolicyDeniedRun,
  type TwoRevisionRun,
} from '@patchproof/runner';

export interface BundleBuildOptions {
  outputPath: string;
  configResult: ConfigParseResult;
  config: PatchProofConfig;
  run: TwoRevisionRun | PolicyDeniedRun;
  backend: 'docker' | 'local';
  fork: boolean;
  baseSource?: SourceSnapshot;
  headSource?: SourceSnapshot;
}

async function artifactFromText(
  outputRoot: string,
  relativePath: string,
  value: string,
): Promise<{
  id: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  mediaType: 'text/plain';
}> {
  const file = join(outputRoot, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, value, 'utf8');
  const bytes = await readFile(file);
  return {
    id: relativePath.replaceAll(/[\\/]/g, '_'),
    relativePath,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    mediaType: 'text/plain',
  };
}

function preview(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}\n[preview truncated]` : value;
}

function executionEvidence(
  revision: 'base' | 'head',
  execution: BackendExecution,
  environment: Record<string, string>,
  launcherEnvironment: {
    omitted: true;
    keys: string[];
    sha256: string;
  },
  dependencyLock: DependencyLockIdentity,
  containerImage: string | undefined,
): ExecutionEvidence {
  const inContainer = containerImage !== undefined;
  return {
    revision,
    command: [],
    cwd: '.',
    environment,
    launcherEnvironment,
    toolchain: {
      node: inContainer ? `image:${containerImage}` : process.version,
      platform: inContainer ? 'container' : process.platform,
      arch: inContainer ? 'container' : process.arch,
      runner: `@patchproof/runner/${RUNNER_VERSION}`,
      dependencyLock,
      ...(containerImage === undefined ? {} : { containerImage }),
    },
    exitCode: execution.exitCode,
    ...(execution.signal === undefined ? {} : { signal: execution.signal }),
    timedOut: execution.timedOut,
    startedAt: execution.startedAt,
    durationMs: execution.durationMs,
    stdout: {
      artifactId: '',
      preview: preview(execution.stdout),
      truncated: execution.stdoutTruncated,
      sizeBytes: execution.stdoutSizeBytes,
    },
    stderr: {
      artifactId: '',
      preview: preview(execution.stderr),
      truncated: execution.stderrTruncated,
      sizeBytes: execution.stderrSizeBytes,
    },
    ...(execution.error === undefined ? {} : { error: execution.error }),
  };
}

function redactedEnvironment(
  environment: Record<string, string>,
  secrets: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, redactText(value, secrets)]),
  );
}

function emptyExecution(revision: 'base' | 'head', error: string): BackendExecution {
  return {
    exitCode: null,
    timedOut: false,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutSizeBytes: 0,
    stderrSizeBytes: 0,
    error: `${revision}: ${error}`,
  };
}

function emptyLauncherEnvironment(): {
  omitted: true;
  keys: string[];
  sha256: string;
} {
  return { omitted: true, keys: [], sha256: sha256(canonicalize({})) };
}

function policySnapshot(
  config: PatchProofConfig,
  backend: 'docker' | 'local',
  fork: boolean,
  denialReason: string | undefined,
): PolicySnapshot {
  return {
    backend,
    network: config.policy.network,
    allowedHosts: [...config.policy.allowedHosts],
    unsafeLocalProcess: backend === 'local',
    fork,
    trustedConfigRevision: 'base',
    ...(denialReason === undefined ? {} : { denialReason }),
    limits: {
      timeoutMs: config.policy.timeoutMs,
      outputBytes: config.policy.outputBytes,
      memoryMb: config.policy.memoryMb,
      cpuCount: config.policy.cpuCount,
      pids: config.policy.pids,
    },
  };
}

export async function writeEvidenceBundle(
  options: BundleBuildOptions,
): Promise<{ bundle: EvidenceBundle; bundlePath: string }> {
  const outputPath = resolve(options.outputPath);
  const outputRoot = outputPath.toLowerCase().endsWith('.json') ? dirname(outputPath) : outputPath;
  const bundlePath = outputPath.toLowerCase().endsWith('.json')
    ? outputPath
    : join(outputPath, 'patchproof.evidence.json');
  await mkdir(outputRoot, { recursive: true });
  let run: TwoRevisionRun | undefined;
  let denialReason: string | undefined;
  if (isPolicyDeniedRun(options.run)) denialReason = options.run.reason;
  else run = options.run;
  const baseExecution =
    run?.base.execution ??
    emptyExecution('base', denialReason ?? 'Execution did not produce a revision result');
  const headExecution =
    run?.head.execution ??
    emptyExecution('head', denialReason ?? 'Execution did not produce a revision result');
  const baseEnvironment = run?.base.environment ?? { PATCHPROOF_REVISION: 'base' };
  const headEnvironment = run?.head.environment ?? { PATCHPROOF_REVISION: 'head' };
  const baseLauncherEnvironment = run?.base.launcherEnvironment ?? emptyLauncherEnvironment();
  const headLauncherEnvironment = run?.head.launcherEnvironment ?? emptyLauncherEnvironment();
  const baseDependencyLock: DependencyLockIdentity = run?.base.dependencyLock ?? {
    status: 'not-detected',
  };
  const headDependencyLock: DependencyLockIdentity = run?.head.dependencyLock ?? {
    status: 'not-detected',
  };
  const baseEvidence = executionEvidence(
    'base',
    baseExecution,
    redactedEnvironment(baseEnvironment, options.config.redaction.secrets),
    baseLauncherEnvironment,
    baseDependencyLock,
    options.backend === 'docker' ? options.config.policy.dockerImage : undefined,
  );
  const headEvidence = executionEvidence(
    'head',
    headExecution,
    redactedEnvironment(headEnvironment, options.config.redaction.secrets),
    headLauncherEnvironment,
    headDependencyLock,
    options.backend === 'docker' ? options.config.policy.dockerImage : undefined,
  );
  baseEvidence.command = [...options.config.scenario.command];
  headEvidence.command = [...options.config.scenario.command];
  baseEvidence.cwd = options.config.scenario.cwd;
  headEvidence.cwd = options.config.scenario.cwd;
  const baseStdout = await artifactFromText(
    outputRoot,
    'artifacts/base.stdout.log',
    baseExecution.stdout,
  );
  const baseStderr = await artifactFromText(
    outputRoot,
    'artifacts/base.stderr.log',
    baseExecution.stderr,
  );
  const headStdout = await artifactFromText(
    outputRoot,
    'artifacts/head.stdout.log',
    headExecution.stdout,
  );
  const headStderr = await artifactFromText(
    outputRoot,
    'artifacts/head.stderr.log',
    headExecution.stderr,
  );
  baseEvidence.stdout.artifactId = baseStdout.id;
  baseEvidence.stderr.artifactId = baseStderr.id;
  headEvidence.stdout.artifactId = headStdout.id;
  headEvidence.stderr.artifactId = headStderr.id;
  const artifacts = [baseStdout, baseStderr, headStdout, headStderr];
  const baseSource = options.baseSource ??
    run?.base.source ?? {
      ref: 'base',
      sha256: sha256(options.configResult.sourcePath),
      kind: 'directory-tree' as const,
      location: dirname(options.configResult.sourcePath),
    };
  const headSource = options.headSource ??
    run?.head.source ?? {
      ref: 'head',
      sha256: sha256(options.configResult.sourcePath),
      kind: 'directory-tree' as const,
      location: dirname(options.configResult.sourcePath),
    };
  const completenessChecks = {
    schema: true,
    trustedScenario: true,
    baseSource: true,
    headSource: true,
    baseExecution: denialReason === undefined,
    headExecution: denialReason === undefined,
    logsPersisted: true,
    artifactHashes: true,
    cleanup: run?.cleanedUp ?? true,
  };
  const complete = Object.values(completenessChecks).every(Boolean);
  let classification: ClassificationResult;
  try {
    classification = await classifyOutcomeGuarded({
      base: {
        exitCode: baseExecution.exitCode,
        timedOut: baseExecution.timedOut,
        ...(baseExecution.error === undefined ? {} : { error: baseExecution.error }),
        output: `${baseExecution.stdout}\n${baseExecution.stderr}`,
      },
      head: {
        exitCode: headExecution.exitCode,
        timedOut: headExecution.timedOut,
        ...(headExecution.error === undefined ? {} : { error: headExecution.error }),
        output: `${headExecution.stdout}\n${headExecution.stderr}`,
      },
      expectedFailure: options.config.scenario.expectedFailure,
      ...(denialReason === undefined ? {} : { policyDenied: denialReason }),
      complete,
    });
  } catch (error) {
    // A hostile or pathological configured pattern must degrade to an honest
    // INCONCLUSIVE bundle instead of blocking the writer or the worker.
    classification = {
      outcome: 'INCONCLUSIVE',
      verdict: 'Evidence is incomplete; no fix claim is made.',
      baseExpectedFailure: false,
      headSuccess: false,
      reason:
        error instanceof PatternDeadlineExceededError
          ? 'Expected-failure patterns exceeded their evaluation deadline'
          : error instanceof PatternWorkerCrashedError
            ? 'Expected-failure patterns could not be evaluated'
            : `Outcome classification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const completeness = {
    complete,
    checks: completenessChecks,
    missing: Object.entries(completenessChecks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name),
  };
  const replayLocations = { base: 'base', head: 'head' };
  const scenarioSha =
    run?.scenarioFileSha256 ??
    sha256(
      canonicalize({
        command: options.config.scenario.command,
        expectedFailure: options.config.scenario.expectedFailure,
      }),
    );
  const withoutIntegrity: Omit<EvidenceBundle, 'integrity'> = {
    schemaVersion: 1,
    product: { name: 'PatchProof', version: '0.9.1' },
    bundleId: randomUUID(),
    createdAt: new Date().toISOString(),
    outcome: classification.outcome,
    verdict: classification.verdict,
    scenario: {
      id: options.config.scenario.id,
      name: options.config.scenario.name,
      command: [...options.config.scenario.command],
      cwd: options.config.scenario.cwd,
      trustedSource: 'base',
      ...(options.config.scenario.file === undefined ? {} : { file: options.config.scenario.file }),
      expectedFailure: { ...options.config.scenario.expectedFailure },
      sha256: scenarioSha,
    },
    sources: {
      base: {
        revision: 'base',
        ref: baseSource.ref,
        sha256: baseSource.sha256,
        kind: baseSource.kind,
        location: 'base',
      },
      head: {
        revision: 'head',
        ref: headSource.ref,
        sha256: headSource.sha256,
        kind: headSource.kind,
        location: 'head',
      },
    },
    policy: policySnapshot(options.config, options.backend, options.fork, denialReason),
    executions: { base: baseEvidence, head: headEvidence },
    artifacts,
    completeness,
    replay: {
      supported: true,
      baseLocation: replayLocations.base,
      headLocation: replayLocations.head,
      requiresExplicitConfirmation: true,
      recordedEnvironment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    },
  };
  const bundle: EvidenceBundle = {
    ...withoutIntegrity,
    integrity: createIntegrity(withoutIntegrity),
  };
  // Atomic replace: a crash mid-write must never leave a truncated evidence
  // file that later verifies as INVALID through no fault of the run.
  const temporaryPath = `${bundlePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${canonicalize(bundle)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, bundlePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { bundle, bundlePath };
}
