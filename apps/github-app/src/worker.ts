import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  loadTrustedConfig,
  ConfigValidationError,
  type ConfigParseResult,
} from '@patchproof/config';
import { writeEvidenceBundle } from '@patchproof/cli';
import { runTwoRevisions, type PolicyDeniedRun, type TwoRevisionRun } from '@patchproof/runner';
import type { GitHubTransport, ManagedStateStore } from '@patchproof/github';
import { publishRunFailure, publishRunResult } from './publisher.js';
import type { QueueJob, RunQueue } from './queue.js';
import type { SourceAdapter } from './source.js';

export interface WorkerRunInput {
  job: QueueJob;
  configResult: ConfigParseResult;
  basePath: string;
  headPath: string;
}

export type WorkerScenarioExecutor = (
  input: WorkerRunInput,
) => Promise<TwoRevisionRun | PolicyDeniedRun>;

export interface PatchProofWorkerDependencies {
  queue: RunQueue;
  source: SourceAdapter;
  store: ManagedStateStore;
  github: GitHubTransport;
  outputRoot: string;
  workerId: string;
  leaseMs?: number;
  backendOverride?: 'docker' | 'local';
  allowUnsafeLocal?: boolean;
  executeScenario?: WorkerScenarioExecutor;
  /** Low-level quarantine removal seam for deterministic worker tests. */
  removeSources?: (quarantinePath: string) => Promise<void>;
}

export interface WorkerRunResult {
  status: 'idle' | 'completed' | 'retried' | 'failed' | 'cancelled';
  job?: QueueJob;
  bundlePath?: string;
  outcome?: string;
  error?: string;
}

const SOURCE_CLEANUP_ERROR = 'Generated source cleanup failed';
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ATTEMPT_SEGMENT = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TRASH_SEGMENT =
  /^\.sources-trash-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_REAPER_JOBS = 8;
const OWNER_UUID_LENGTH = 36;
const OWNER_SEPARATOR_LENGTH = 1;
const MAX_QUEUE_OWNER_LENGTH = 128;

interface OutputRootPaths {
  configuredRoot: string;
  realRoot: string;
}

interface AttemptPaths {
  outputRoot: OutputRootPaths;
  jobId: string;
  jobRoot: string;
  attemptsRoot: string;
  attemptName: string;
  attemptRoot: string;
  sourcesRoot: string;
  evidenceRoot: string;
  pathTokens: string[];
}

interface ExecuteResult {
  bundlePath: string;
  outcome: string;
  bundle: Awaited<ReturnType<typeof writeEvidenceBundle>>['bundle'];
  paths: AttemptPaths;
}

class WorkerFilesystemError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'WorkerFilesystemError';
  }
}

class WorkerExecutionError extends Error {
  public readonly primaryError: unknown;
  public readonly evidencePath: string | undefined;
  public readonly cleanupPending: boolean;
  public readonly pathTokens: readonly string[];

  public constructor(
    message: string,
    options: {
      primaryError?: unknown;
      evidencePath?: string;
      cleanupPending?: boolean;
      pathTokens?: readonly string[];
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'WorkerExecutionError';
    this.primaryError = options.primaryError;
    this.evidencePath = options.evidencePath;
    this.cleanupPending = options.cleanupPending === true;
    this.pathTokens = options.pathTokens ?? [];
  }
}

class SourceCleanupError extends WorkerExecutionError {
  public constructor(cause: unknown, paths: AttemptPaths, evidencePath?: string) {
    super(SOURCE_CLEANUP_ERROR, {
      ...(evidencePath === undefined ? {} : { evidencePath }),
      cleanupPending: true,
      pathTokens: paths.pathTokens,
      cause,
    });
    this.name = 'SourceCleanupError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isAlreadyExistingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function pathVariants(path: string): string[] {
  if (!path) return [];
  const forward = path.replaceAll('\\', '/');
  const backward = path.replaceAll('/', '\\');
  return [...new Set([path, forward, backward])];
}

function sanitizeWorkerText(message: string, paths: readonly string[]): string {
  const tokens = [...new Set(paths.flatMap(pathVariants))]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (tokens.length === 0) return message;
  return message.replace(
    new RegExp(tokens.map(escapeRegex).join('|'), 'giu'),
    '[worker path omitted]',
  );
}

function sanitizedErrorMessage(error: unknown, paths: readonly string[]): string {
  return sanitizeWorkerText(errorMessage(error), paths);
}

function assertUuidSegment(value: string, label: string): void {
  if (!UUID_SEGMENT.test(value)) throw new WorkerFilesystemError(`${label} is invalid`);
}

function assertAttemptSegment(value: string): void {
  if (!ATTEMPT_SEGMENT.test(value)) throw new WorkerFilesystemError('Attempt path is invalid');
}

function assertTrashSegment(value: string): void {
  if (!TRASH_SEGMENT.test(value))
    throw new WorkerFilesystemError('Source quarantine path is invalid');
}

function createLeaseOwner(workerId: string): string {
  const suffix = randomUUID();
  const labelLength = MAX_QUEUE_OWNER_LENGTH - OWNER_SEPARATOR_LENGTH - OWNER_UUID_LENGTH;
  const label = workerId.slice(0, Math.max(1, labelLength));
  return `${label}-${suffix}`;
}

function retryableWorkerError(error: unknown): boolean {
  const primaryError =
    error instanceof WorkerExecutionError && error.primaryError !== undefined
      ? error.primaryError
      : error;
  if (primaryError instanceof ConfigValidationError) return false;
  if (primaryError instanceof WorkerFilesystemError) return false;
  const message = errorMessage(primaryError).toLowerCase();
  return !/(invalid|unsafe|unsupported|policy|configuration|permission denied)/u.test(message);
}

/*
 * These Node path checks are defense in depth only. They do not defend against a
 * hostile same-privilege process racing filesystem operations. Operators must make
 * outputRoot writable only by the worker service account.
 */
export class PatchProofWorker {
  private readonly leaseMs: number;
  private readonly cleanedTerminalJobs = new Set<string>();
  private stopping = false;

  public constructor(private readonly dependencies: PatchProofWorkerDependencies) {
    this.leaseMs = dependencies.leaseMs ?? 60_000;
  }

  public stop(): void {
    this.stopping = true;
  }

  private async resolveOutputRoot(create: boolean): Promise<OutputRootPaths | undefined> {
    const configuredRoot = resolve(this.dependencies.outputRoot);
    if (create) {
      try {
        await mkdir(configuredRoot, { recursive: true });
      } catch (error) {
        throw new WorkerFilesystemError('Configured output root is unavailable', error);
      }
    }
    let stats;
    try {
      stats = await lstat(configuredRoot);
    } catch (error) {
      if (!create && isMissingPath(error)) return undefined;
      throw new WorkerFilesystemError('Configured output root is unavailable', error);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new WorkerFilesystemError('Configured output root is unavailable');
    let realRoot: string;
    try {
      realRoot = await realpath(configuredRoot);
    } catch (error) {
      throw new WorkerFilesystemError('Configured output root is unavailable', error);
    }
    return { configuredRoot, realRoot };
  }

  private async validateDirectory(path: string, message: string): Promise<void> {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      throw new WorkerFilesystemError(message, error);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new WorkerFilesystemError(message);
  }

  private async resolveJobRoot(
    jobId: string,
    create: boolean,
  ): Promise<{ outputRoot: OutputRootPaths; jobRoot: string } | undefined> {
    assertUuidSegment(jobId, 'Queue job id');
    const outputRoot = await this.resolveOutputRoot(create);
    if (outputRoot === undefined) return undefined;
    const jobPath = join(outputRoot.realRoot, jobId);
    if (create) {
      try {
        await mkdir(jobPath);
      } catch (error) {
        if (!isAlreadyExistingPath(error))
          throw new WorkerFilesystemError('Job root is unavailable', error);
      }
    }
    await this.validateDirectory(jobPath, 'Job root is unavailable');
    let jobRealPath: string;
    try {
      jobRealPath = await realpath(jobPath);
    } catch (error) {
      throw new WorkerFilesystemError('Job root is unavailable', error);
    }
    if (
      !samePath(dirname(jobRealPath), outputRoot.realRoot) ||
      !samePath(basename(jobRealPath), jobId)
    )
      throw new WorkerFilesystemError('Job root is unavailable');
    return { outputRoot, jobRoot: jobRealPath };
  }

  private async resolveAttemptsRoot(jobRoot: string, create: boolean): Promise<string | undefined> {
    const attemptsRoot = join(jobRoot, 'attempts');
    if (create) {
      try {
        await mkdir(attemptsRoot);
      } catch (error) {
        if (!isAlreadyExistingPath(error))
          throw new WorkerFilesystemError('Attempts root is unavailable', error);
      }
    }
    let stats;
    try {
      stats = await lstat(attemptsRoot);
    } catch (error) {
      if (!create && isMissingPath(error)) return undefined;
      throw new WorkerFilesystemError('Attempts root is unavailable', error);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new WorkerFilesystemError('Attempts root is unavailable');
    let attemptsRealPath: string;
    try {
      attemptsRealPath = await realpath(attemptsRoot);
    } catch (error) {
      throw new WorkerFilesystemError('Attempts root is unavailable', error);
    }
    if (
      !samePath(dirname(attemptsRealPath), jobRoot) ||
      !samePath(basename(attemptsRealPath), 'attempts')
    )
      throw new WorkerFilesystemError('Attempts root is unavailable');
    return attemptsRealPath;
  }

  private async createAttempt(job: QueueJob): Promise<AttemptPaths> {
    const resolvedJob = await this.resolveJobRoot(job.id, true);
    if (resolvedJob === undefined) throw new WorkerFilesystemError('Job root is unavailable');
    const attemptsRoot = await this.resolveAttemptsRoot(resolvedJob.jobRoot, true);
    if (attemptsRoot === undefined) throw new WorkerFilesystemError('Attempts root is unavailable');
    let attemptName = '';
    let attemptRoot = '';
    for (let index = 0; index < 3; index += 1) {
      attemptName = `${job.attempts}-${randomUUID()}`;
      attemptRoot = join(attemptsRoot, attemptName);
      try {
        await mkdir(attemptRoot);
        break;
      } catch (error) {
        if (!isAlreadyExistingPath(error) || index === 2)
          throw new WorkerFilesystemError('Attempt root is unavailable', error);
      }
    }
    assertAttemptSegment(attemptName);
    await this.validateDirectory(attemptRoot, 'Attempt root is unavailable');
    let attemptRealPath: string;
    try {
      attemptRealPath = await realpath(attemptRoot);
    } catch (error) {
      throw new WorkerFilesystemError('Attempt root is unavailable', error);
    }
    if (
      !samePath(dirname(attemptRealPath), attemptsRoot) ||
      !samePath(basename(attemptRealPath), attemptName)
    )
      throw new WorkerFilesystemError('Attempt root is unavailable');
    const evidenceRoot = join(attemptRealPath, 'evidence');
    const sourcesRoot = join(attemptRealPath, 'sources');
    try {
      await mkdir(evidenceRoot);
      await mkdir(sourcesRoot);
    } catch (error) {
      throw new WorkerFilesystemError('Attempt workspace is unavailable', error);
    }
    await this.validateDirectory(evidenceRoot, 'Evidence root is unavailable');
    await this.validateDirectory(sourcesRoot, 'Source root is unavailable');
    const configuredJobRoot = join(resolvedJob.outputRoot.configuredRoot, job.id);
    const configuredAttemptsRoot = join(configuredJobRoot, 'attempts');
    const configuredAttemptRoot = join(configuredAttemptsRoot, attemptName);
    const pathTokens = [
      resolvedJob.outputRoot.configuredRoot,
      resolvedJob.outputRoot.realRoot,
      configuredJobRoot,
      configuredAttemptsRoot,
      configuredAttemptRoot,
      join(configuredAttemptRoot, 'sources'),
      join(configuredAttemptRoot, 'evidence'),
      resolvedJob.jobRoot,
      attemptsRoot,
      attemptRealPath,
      sourcesRoot,
      evidenceRoot,
    ];
    return {
      outputRoot: resolvedJob.outputRoot,
      jobId: job.id,
      jobRoot: resolvedJob.jobRoot,
      attemptsRoot,
      attemptName,
      attemptRoot: attemptRealPath,
      sourcesRoot,
      evidenceRoot,
      pathTokens,
    };
  }

  private async validateAttempt(paths: AttemptPaths, requireEvidence: boolean): Promise<void> {
    assertUuidSegment(paths.jobId, 'Queue job id');
    assertAttemptSegment(paths.attemptName);
    await this.validateDirectory(
      paths.outputRoot.realRoot,
      'Configured output root is unavailable',
    );
    await this.validateDirectory(paths.jobRoot, 'Job root is unavailable');
    await this.validateDirectory(paths.attemptsRoot, 'Attempts root is unavailable');
    await this.validateDirectory(paths.attemptRoot, 'Attempt root is unavailable');
    if (
      !samePath(dirname(paths.jobRoot), paths.outputRoot.realRoot) ||
      !samePath(basename(paths.jobRoot), paths.jobId) ||
      !samePath(dirname(paths.attemptsRoot), paths.jobRoot) ||
      !samePath(basename(paths.attemptsRoot), 'attempts') ||
      !samePath(dirname(paths.attemptRoot), paths.attemptsRoot) ||
      !samePath(basename(paths.attemptRoot), paths.attemptName)
    )
      throw new WorkerFilesystemError('Attempt path is unavailable');
    if (requireEvidence) {
      await this.validateDirectory(paths.evidenceRoot, 'Evidence root is unavailable');
    } else {
      try {
        await this.validateDirectory(paths.evidenceRoot, 'Evidence root is unavailable');
      } catch (error) {
        const cause =
          error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
        if (!isMissingPath(cause)) throw error;
      }
    }
  }

  private async removeQuarantine(paths: AttemptPaths, quarantinePath: string): Promise<void> {
    assertTrashSegment(basename(quarantinePath));
    if (!samePath(dirname(quarantinePath), paths.attemptRoot))
      throw new WorkerFilesystemError('Source quarantine path is invalid');
    await this.validateAttempt(paths, false);
    let stats;
    try {
      stats = await lstat(quarantinePath);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw new WorkerFilesystemError(SOURCE_CLEANUP_ERROR, error);
    }
    if (this.dependencies.removeSources !== undefined) {
      await this.dependencies.removeSources(quarantinePath);
      return;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      try {
        await unlink(quarantinePath);
      } catch (error) {
        if (!isMissingPath(error)) throw new WorkerFilesystemError(SOURCE_CLEANUP_ERROR, error);
      }
      return;
    }
    try {
      await rm(quarantinePath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch (error) {
      throw new WorkerFilesystemError(SOURCE_CLEANUP_ERROR, error);
    }
  }

  private async cleanupAttemptSources(paths: AttemptPaths): Promise<void> {
    await this.validateAttempt(paths, false);
    let entries;
    try {
      entries = await readdir(paths.attemptRoot, { withFileTypes: true });
    } catch (error) {
      throw new WorkerFilesystemError(SOURCE_CLEANUP_ERROR, error);
    }
    for (const entry of entries) {
      if (!TRASH_SEGMENT.test(entry.name)) continue;
      const quarantinePath = join(paths.attemptRoot, entry.name);
      paths.pathTokens.push(quarantinePath);
      await this.removeQuarantine(paths, quarantinePath);
    }
    try {
      await lstat(paths.sourcesRoot);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw new WorkerFilesystemError(SOURCE_CLEANUP_ERROR, error);
    }
    await this.validateAttempt(paths, false);
    const quarantinePath = join(paths.attemptRoot, `.sources-trash-${randomUUID()}`);
    paths.pathTokens.push(quarantinePath);
    try {
      await rename(paths.sourcesRoot, quarantinePath);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw new WorkerFilesystemError(SOURCE_CLEANUP_ERROR, error);
    }
    await this.removeQuarantine(paths, quarantinePath);
  }

  private terminalAttemptPaths(
    outputRoot: OutputRootPaths,
    jobId: string,
    jobRoot: string,
    attemptsRoot: string,
    attemptName: string,
    attemptRoot: string,
  ): AttemptPaths {
    assertAttemptSegment(attemptName);
    const evidenceRoot = join(attemptRoot, 'evidence');
    const sourcesRoot = join(attemptRoot, 'sources');
    const configuredJobRoot = join(outputRoot.configuredRoot, jobId);
    const configuredAttemptsRoot = join(configuredJobRoot, 'attempts');
    const configuredAttemptRoot = join(configuredAttemptsRoot, attemptName);
    return {
      outputRoot,
      jobId,
      jobRoot,
      attemptsRoot,
      attemptName,
      attemptRoot,
      sourcesRoot,
      evidenceRoot,
      pathTokens: [
        outputRoot.configuredRoot,
        outputRoot.realRoot,
        configuredJobRoot,
        configuredAttemptsRoot,
        configuredAttemptRoot,
        join(configuredAttemptRoot, 'sources'),
        join(configuredAttemptRoot, 'evidence'),
        jobRoot,
        attemptsRoot,
        attemptRoot,
        sourcesRoot,
        evidenceRoot,
      ],
    };
  }

  private async cleanupTerminalAttempts(jobId: string): Promise<void> {
    const resolvedJob = await this.resolveJobRoot(jobId, false);
    if (resolvedJob === undefined) return;
    const attemptsRoot = await this.resolveAttemptsRoot(resolvedJob.jobRoot, false);
    if (attemptsRoot === undefined) return;
    let entries;
    try {
      entries = await readdir(attemptsRoot, { withFileTypes: true });
    } catch (error) {
      throw new WorkerFilesystemError(SOURCE_CLEANUP_ERROR, error);
    }
    for (const entry of entries) {
      if (!ATTEMPT_SEGMENT.test(entry.name)) continue;
      const attemptRoot = join(attemptsRoot, entry.name);
      let stats;
      try {
        stats = await lstat(attemptRoot);
      } catch (error) {
        if (isMissingPath(error)) continue;
        throw new WorkerFilesystemError(SOURCE_CLEANUP_ERROR, error);
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
      const paths = this.terminalAttemptPaths(
        resolvedJob.outputRoot,
        jobId,
        resolvedJob.jobRoot,
        attemptsRoot,
        entry.name,
        attemptRoot,
      );
      await this.cleanupAttemptSources(paths);
    }
  }

  private async execute(job: QueueJob): Promise<ExecuteResult> {
    const paths = await this.createAttempt(job);
    const basePath = join(paths.sourcesRoot, 'base');
    const headPath = join(paths.sourcesRoot, 'head');
    paths.pathTokens.push(basePath, headPath);
    let built: Awaited<ReturnType<typeof writeEvidenceBundle>> | undefined;
    let primaryError: unknown;
    let primaryFailed = false;
    try {
      await this.dependencies.source.materializeRevision(job.repository, job.baseSha, basePath);
      await this.dependencies.source.materializeRevision(job.headRepository, job.headSha, headPath);
      const configResult = await loadTrustedConfig(join(basePath, '.patchproof.yml'), basePath);
      const executor =
        this.dependencies.executeScenario ??
        (async (input: WorkerRunInput) =>
          runTwoRevisions({
            config: input.configResult.config,
            basePath: input.basePath,
            headPath: input.headPath,
            baseRef: input.job.baseSha,
            headRef: input.job.headSha,
            fork: input.job.fork,
            ...(this.dependencies.backendOverride === undefined
              ? {}
              : { backendOverride: this.dependencies.backendOverride }),
            allowUnsafeLocal: this.dependencies.allowUnsafeLocal === true,
            trustedConfig: true,
          }));
      const run = await executor({ job, configResult, basePath, headPath });
      const backend = this.dependencies.backendOverride ?? configResult.config.policy.backend;
      built = await writeEvidenceBundle({
        outputPath: paths.evidenceRoot,
        configResult,
        config: configResult.config,
        run,
        backend,
        fork: job.fork,
        baseSource: {
          revision: 'base',
          ref: job.baseSha,
          sha256: job.baseSha,
          kind: 'git-commit',
          location: 'base',
        },
        headSource: {
          revision: 'head',
          ref: job.headSha,
          sha256: job.headSha,
          kind: 'git-commit',
          location: 'head',
        },
      });
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    }
    let cleanupError: unknown;
    try {
      await this.cleanupAttemptSources(paths);
    } catch (error) {
      cleanupError = error;
    }
    if (primaryFailed) {
      const message = sanitizedErrorMessage(primaryError, paths.pathTokens);
      throw new WorkerExecutionError(message, {
        primaryError,
        cleanupPending: cleanupError !== undefined,
        pathTokens: paths.pathTokens,
        cause: cleanupError ?? primaryError,
      });
    }
    if (cleanupError !== undefined)
      throw new SourceCleanupError(cleanupError, paths, built?.bundlePath);
    if (built === undefined) throw new WorkerFilesystemError('Evidence bundle was not built');
    return {
      bundlePath: built.bundlePath,
      outcome: built.bundle.outcome,
      bundle: built.bundle,
      paths,
    };
  }

  private async reaperAtIdle(): Promise<void> {
    let jobs: QueueJob[];
    try {
      jobs = await this.dependencies.queue.list();
    } catch {
      return;
    }
    const candidates = jobs
      .filter(
        (job) =>
          (job.status === 'succeeded' || job.status === 'cancelled') &&
          job.leaseOwner === undefined,
      )
      .slice(0, MAX_REAPER_JOBS);
    for (const job of candidates) {
      if (this.cleanedTerminalJobs.has(job.id)) continue;
      try {
        await this.cleanupTerminalAttempts(job.id);
        this.cleanedTerminalJobs.add(job.id);
      } catch {
        // Idle reaping is best effort. A failed terminal claim remains authoritative.
      }
    }
  }

  private async runTerminalClaim(claimed: QueueJob): Promise<WorkerRunResult> {
    const rootToken = resolve(this.dependencies.outputRoot);
    const baseTokens = [rootToken, join(rootToken, claimed.id)];
    try {
      if (!this.cleanedTerminalJobs.has(claimed.id)) {
        await this.cleanupTerminalAttempts(claimed.id);
      }
    } catch {
      return { status: 'failed', job: claimed, error: SOURCE_CLEANUP_ERROR };
    }
    const resolved = await this.resolveJobRoot(claimed.id, false).catch(() => undefined);
    const pathTokens = [
      ...baseTokens,
      ...(resolved === undefined
        ? []
        : [resolved.outputRoot.realRoot, resolved.jobRoot, join(resolved.jobRoot, 'attempts')]),
    ];
    try {
      await publishRunFailure(
        {
          repository: claimed.repository,
          pullRequest: claimed.pullRequest,
          headSha: claimed.headSha,
          error: sanitizeWorkerText(
            claimed.lastError ?? 'The worker lease expired after the retry limit',
            pathTokens,
          ),
        },
        this.dependencies.store,
        this.dependencies.github,
      );
      const acknowledged = await this.dependencies.queue.acknowledgeFailure(claimed.id);
      if (acknowledged) this.cleanedTerminalJobs.add(claimed.id);
    } catch (error) {
      return {
        status: 'failed',
        job: claimed,
        error: sanitizeWorkerText(errorMessage(error), pathTokens),
      };
    }
    return {
      status: 'failed',
      job: claimed,
      error: sanitizeWorkerText(
        claimed.lastError ?? 'The worker lease expired after the retry limit',
        pathTokens,
      ),
    };
  }

  public async runOnce(): Promise<WorkerRunResult> {
    if (this.stopping) return { status: 'idle' };
    const owner = createLeaseOwner(this.dependencies.workerId);
    const claimed = await this.dependencies.queue.claim(owner, this.leaseMs);
    if (claimed === undefined) {
      await this.reaperAtIdle();
      return { status: 'idle' };
    }
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let attemptPaths: AttemptPaths | undefined;
    let evidencePath: string | undefined;
    try {
      heartbeatTimer = setInterval(
        () => {
          void this.dependencies.queue
            .heartbeat(claimed.id, owner, this.leaseMs)
            .catch(() => false);
        },
        Math.max(1_000, Math.floor(this.leaseMs / 3)),
      );
      if (claimed.status === 'failed') return await this.runTerminalClaim(claimed);
      const result = await this.execute(claimed);
      attemptPaths = result.paths;
      evidencePath = result.bundlePath;
      if (!(await this.dependencies.queue.heartbeat(claimed.id, owner, this.leaseMs)))
        throw new WorkerExecutionError('Queue job was cancelled or superseded before publication', {
          evidencePath,
          pathTokens: result.paths.pathTokens,
        });
      await publishRunResult(
        {
          repository: claimed.repository,
          pullRequest: claimed.pullRequest,
          headSha: claimed.headSha,
          bundle: result.bundle,
        },
        this.dependencies.store,
        this.dependencies.github,
      );
      const completed = await this.dependencies.queue.complete(claimed.id, owner, {
        evidencePath: result.bundlePath,
        outcome: result.outcome,
      });
      if (!completed) return { status: 'cancelled', job: claimed, ...result };
      return { status: 'completed', job: claimed, ...result };
    } catch (error) {
      const executionError = error instanceof WorkerExecutionError ? error : undefined;
      if (executionError?.evidencePath !== undefined) evidencePath = executionError.evidencePath;
      const pathTokens = executionError?.pathTokens ??
        attemptPaths?.pathTokens ?? [resolve(this.dependencies.outputRoot)];
      const message =
        executionError?.message ?? sanitizeWorkerText(errorMessage(error), pathTokens);
      const retryable = retryableWorkerError(error);
      const updated = await this.dependencies.queue.fail(claimed.id, owner, message, retryable);
      if (updated?.status === 'failed' && executionError?.cleanupPending !== true) {
        try {
          await this.cleanupTerminalAttempts(updated.id);
        } catch {
          return {
            status: 'failed',
            job: updated,
            error: SOURCE_CLEANUP_ERROR,
            ...(evidencePath === undefined ? {} : { bundlePath: evidencePath }),
          };
        }
        try {
          await publishRunFailure(
            {
              repository: claimed.repository,
              pullRequest: claimed.pullRequest,
              headSha: claimed.headSha,
              error: message,
            },
            this.dependencies.store,
            this.dependencies.github,
          );
          const acknowledged = await this.dependencies.queue.acknowledgeFailure(updated.id);
          if (acknowledged) this.cleanedTerminalJobs.add(updated.id);
        } catch {
          // The durable queue remains failed when the GitHub transport is unavailable.
        }
      }
      if (updated?.status === 'queued')
        return {
          status: 'retried',
          job: updated,
          error: message,
          ...(evidencePath === undefined ? {} : { bundlePath: evidencePath }),
        };
      if (updated === undefined)
        return {
          status: 'cancelled',
          job: claimed,
          error: message,
          ...(evidencePath === undefined ? {} : { bundlePath: evidencePath }),
        };
      return {
        status: 'failed',
        job: updated,
        error: message,
        ...(evidencePath === undefined ? {} : { bundlePath: evidencePath }),
      };
    } finally {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    }
  }

  public async runUntilIdle(): Promise<WorkerRunResult[]> {
    const results: WorkerRunResult[] = [];
    while (!this.stopping) {
      const result = await this.runOnce();
      results.push(result);
      if (result.status === 'idle') break;
    }
    return results;
  }

  public async runForever(pollMs = 1_000): Promise<void> {
    while (!this.stopping) {
      const result = await this.runOnce();
      if (result.status === 'idle')
        await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  }
}
