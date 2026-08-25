import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  loadTrustedConfig,
  ConfigValidationError,
  type ConfigParseResult,
} from '@patchproof/config';
import { writeEvidenceBundle } from '@patchproof/cli';
import {
  runTwoRevisions,
  type OperatorPolicyInput,
  type PolicyDeniedRun,
  type TwoRevisionRun,
} from '@patchproof/runner';
import type { GitHubTransport, ManagedStateStore } from '@patchproof/github';
import { publishRunFailure, publishRunResult, type PublicationFence } from './publisher.js';
import type { QueueCleanupCursor, QueueJob, QueueLease, RunQueue } from './queue.js';
import type { SourceAdapter } from './source.js';

export interface WorkerRunInput {
  job: QueueJob;
  configResult: ConfigParseResult;
  basePath: string;
  headPath: string;
  /** Cancellation handoff for source adapters and the runner implementation. */
  signal: AbortSignal;
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
  /** Operator-owned runner ceilings and isolation requirements. */
  operatorPolicy?: OperatorPolicyInput;
  requireFreshSnapshot?: boolean;
  /** Bounded operator hook; no evidence deletion is performed by default. */
  retention?: {
    maxCleanupJobs?: number;
    onTerminalCandidate?: (candidate: QueueCleanupCursor) => Promise<void>;
  };
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
let warnedWindowsPermissions = false;

const LEASE_LOST_ERROR = 'Queue job was cancelled or superseded before publication';
const PRUNE_INTERVAL_MS = 3_600_000;

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

class LeaseLostError extends Error {
  public constructor(cause?: unknown) {
    super(LEASE_LOST_ERROR, { cause });
    this.name = 'LeaseLostError';
  }
}

class PullRequestStaleError extends Error {
  public constructor(message = 'Pull request changed or closed before publication') {
    super(message);
    this.name = 'PullRequestStaleError';
  }
}

class WorkerLeaseFence implements PublicationFence {
  public readonly controller = new AbortController();
  private lostLatch = false;
  private stopped = false;
  private renewal: Promise<void> = Promise.resolve();
  private readonly timer: NodeJS.Timeout;

  public constructor(
    private readonly queue: RunQueue,
    private readonly jobId: string,
    private readonly lease: QueueLease,
    private readonly leaseMs: number,
  ) {
    const cadence = Math.max(100, Math.floor(leaseMs / 3));
    this.timer = setInterval(() => {
      void this.renew().catch(() => undefined);
    }, cadence);
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get lost(): boolean {
    return this.lostLatch;
  }

  private lose(cause?: unknown): void {
    if (this.lostLatch) return;
    this.lostLatch = true;
    this.controller.abort(new LeaseLostError(cause));
  }

  private queueRenewal(): Promise<void> {
    const next = this.renewal.then(async () => {
      if (this.stopped || this.lostLatch) return;
      try {
        const renewed = await this.queue.heartbeat(this.jobId, this.lease, this.leaseMs);
        if (!renewed) this.lose();
      } catch (error) {
        this.lose(error);
      }
    });
    this.renewal = next.catch(() => undefined);
    return next;
  }

  private async renew(): Promise<void> {
    await this.queueRenewal();
  }

  public async assertOwned(): Promise<void> {
    if (this.lostLatch || this.stopped) throw new LeaseLostError();
    await this.renew();
    if (this.lostLatch || this.stopped) throw new LeaseLostError();
  }

  public async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      clearInterval(this.timer);
      this.lose();
    }
    await this.renewal;
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
  const withPaths =
    tokens.length === 0
      ? message
      : message.replace(
          new RegExp(tokens.map(escapeRegex).join('|'), 'giu'),
          '[worker path omitted]',
        );
  return withPaths
    .replaceAll(/Authorization\s*:\s*Bearer\s+[^\s`]+/giu, 'Authorization: [credential omitted]')
    .replaceAll(
      /((?:token|secret|private[_ -]?key))\s*[:=]\s*[^\s`]+/giu,
      '$1: [credential omitted]',
    )
    .replaceAll(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/gu, '[credential omitted]');
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
  private readonly maxReaperJobs: number;
  private stopping = false;
  private activeFence: WorkerLeaseFence | undefined;
  private reaperCursor: QueueCleanupCursor | undefined;
  private lastPruneAt = 0;
  private runOnceTail: Promise<void> = Promise.resolve();

  public constructor(private readonly dependencies: PatchProofWorkerDependencies) {
    this.leaseMs = dependencies.leaseMs ?? 60_000;
    const configured = dependencies.retention?.maxCleanupJobs ?? MAX_REAPER_JOBS;
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > 100)
      throw new Error('Worker retention cleanup bound is invalid');
    this.maxReaperJobs = configured;
  }

  public stop(): void {
    this.stopping = true;
    void this.activeFence?.stop();
  }

  private async resolveOutputRoot(create: boolean): Promise<OutputRootPaths | undefined> {
    const configuredRoot = resolve(this.dependencies.outputRoot);
    if (create) {
      try {
        await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
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
        await mkdir(jobPath, { mode: 0o700 });
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
        await mkdir(attemptsRoot, { mode: 0o700 });
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
        await mkdir(attemptRoot, { mode: 0o700 });
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
      await mkdir(evidenceRoot, { mode: 0o700 });
      await mkdir(sourcesRoot, { mode: 0o700 });
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

  private async execute(job: QueueJob, signal: AbortSignal): Promise<ExecuteResult> {
    const paths = await this.createAttempt(job);
    const basePath = join(paths.sourcesRoot, 'base');
    const headPath = join(paths.sourcesRoot, 'head');
    paths.pathTokens.push(basePath, headPath);
    let built: Awaited<ReturnType<typeof writeEvidenceBundle>> | undefined;
    let primaryError: unknown;
    let primaryFailed = false;
    try {
      await this.dependencies.source.materializeRevision(job.repository, job.baseSha, basePath, {
        ...(job.installationId === undefined ? {} : { installationId: job.installationId }),
        signal,
      });
      await this.dependencies.source.materializeRevision(
        job.headRepository,
        job.headSha,
        headPath,
        {
          ...(job.installationId === undefined ? {} : { installationId: job.installationId }),
          signal,
        },
      );
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
            ...(this.dependencies.operatorPolicy === undefined
              ? {}
              : { operatorPolicy: this.dependencies.operatorPolicy }),
            signal: input.signal,
          }));
      const run = await executor({ job, configResult, basePath, headPath, signal });
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
      await this.secureEvidenceTree(paths.evidenceRoot);
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

  private async secureEvidenceTree(root: string): Promise<void> {
    await this.chmodOwned(root, 0o700);
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(root, entry.name);
      if (entry.isSymbolicLink())
        throw new WorkerFilesystemError('Evidence tree contains an unexpected link');
      if (entry.isDirectory()) {
        await this.secureEvidenceTree(child);
      } else if (entry.isFile()) {
        await this.chmodOwned(child, 0o600);
      } else {
        throw new WorkerFilesystemError('Evidence tree contains an unexpected entry');
      }
    }
  }

  private async chmodOwned(path: string, mode: number): Promise<void> {
    if (process.platform === 'win32') {
      if (!warnedWindowsPermissions) {
        warnedWindowsPermissions = true;
        console.warn('PatchProof POSIX evidence modes are unavailable on Windows; use ACLs.');
      }
      return;
    }
    const stats = await stat(path);
    const getUid = process.getuid;
    if (typeof getUid === 'function' && stats.uid !== getUid())
      throw new WorkerFilesystemError('Evidence path ownership could not be validated');
    await chmod(path, mode);
  }

  private shouldRequireFreshSnapshot(): boolean {
    return (
      this.dependencies.requireFreshSnapshot === true ||
      this.dependencies.github.requiresFreshSnapshot === true
    );
  }

  private async assertFreshPullRequest(job: QueueJob, fence: WorkerLeaseFence): Promise<void> {
    if (!this.shouldRequireFreshSnapshot()) return;
    await fence.assertOwned();
    const snapshot = await this.dependencies.github.getPullRequest(
      job.repository,
      job.pullRequest,
      {
        signal: fence.signal,
        ...(job.installationId === undefined ? {} : { installationId: job.installationId }),
      },
    );
    if (
      snapshot.number !== job.pullRequest ||
      snapshot.state !== 'open' ||
      snapshot.headSha.toLowerCase() !== job.headSha.toLowerCase() ||
      snapshot.headRepository !== job.headRepository ||
      (snapshot.repository !== undefined && snapshot.repository !== job.repository)
    )
      throw new PullRequestStaleError();
    await fence.assertOwned();
  }

  private async cancelStaleJob(
    job: QueueJob,
    lease: QueueLease,
    fence: WorkerLeaseFence,
  ): Promise<WorkerRunResult> {
    if (fence.lost) return { status: 'cancelled', job, error: LEASE_LOST_ERROR };
    const reason = 'Pull request changed or closed before publication';
    const cancelled =
      job.status === 'failed'
        ? await this.dependencies.queue.cancelTerminal(job.id, lease, reason)
        : await this.dependencies.queue.cancel(job.id, reason);
    return {
      status: 'cancelled',
      job,
      error: cancelled ? reason : LEASE_LOST_ERROR,
    };
  }

  private async pruneAtIdle(): Promise<void> {
    // Retention runs at most once per hour and only while the worker is idle.
    // Terminal rows and delivery history otherwise grow without bound on busy
    // installations and slow every boot-time scan down linearly.
    const now = Date.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    const retention = 30 * 24 * 3_600_000;
    try {
      await this.dependencies.queue.pruneTerminalJobs?.(retention);
    } catch {
      return;
    }
    try {
      await this.dependencies.store.prune?.(retention);
    } catch {
      // Retention is best effort; the next idle cycle retries.
    }
  }

  private async reaperAtIdle(): Promise<void> {
    await this.pruneAtIdle();
    let candidates: QueueCleanupCursor[];
    try {
      candidates = await this.dependencies.queue.listTerminalCleanupCandidates(
        this.reaperCursor,
        this.maxReaperJobs,
      );
      if (candidates.length === 0 && this.reaperCursor !== undefined) {
        candidates = await this.dependencies.queue.listTerminalCleanupCandidates(
          undefined,
          this.maxReaperJobs,
        );
      }
    } catch {
      return;
    }
    if (candidates.length === 0) return;
    for (const candidate of candidates) {
      try {
        await this.cleanupTerminalAttempts(candidate.id);
        if (this.dependencies.retention?.onTerminalCandidate !== undefined)
          await this.dependencies.retention.onTerminalCandidate(candidate);
      } catch {
        // Idle reaping is best effort. A failed terminal claim remains authoritative.
      } finally {
        this.reaperCursor = candidate;
      }
    }
  }

  private async releaseTerminalLease(
    claimed: QueueJob,
    lease: QueueLease,
    fence: WorkerLeaseFence,
  ): Promise<void> {
    if (fence.lost) return;
    await fence.assertOwned().catch(() => undefined);
    if (fence.lost) return;
    await this.dependencies.queue.releaseFailure(claimed.id, lease);
  }

  private async runTerminalClaim(
    claimed: QueueJob,
    lease: QueueLease,
    fence: WorkerLeaseFence,
  ): Promise<WorkerRunResult> {
    const rootToken = resolve(this.dependencies.outputRoot);
    const baseTokens = [rootToken, join(rootToken, claimed.id)];
    if (fence.lost)
      return {
        status: 'cancelled',
        job: claimed,
        error: LEASE_LOST_ERROR,
      };
    try {
      await this.assertFreshPullRequest(claimed, fence);
    } catch (error) {
      if (error instanceof PullRequestStaleError) return this.cancelStaleJob(claimed, lease, fence);
      if (fence.lost)
        return {
          status: 'cancelled',
          job: claimed,
          error: LEASE_LOST_ERROR,
        };
      return { status: 'failed', job: claimed, error: 'Pull request freshness check failed' };
    }
    try {
      await this.cleanupTerminalAttempts(claimed.id);
    } catch {
      if (fence.lost)
        return {
          status: 'cancelled',
          job: claimed,
          error: LEASE_LOST_ERROR,
        };
      await this.releaseTerminalLease(claimed, lease, fence);
      return { status: 'failed', job: claimed, error: SOURCE_CLEANUP_ERROR };
    }
    if (fence.lost)
      return {
        status: 'cancelled',
        job: claimed,
        error: LEASE_LOST_ERROR,
      };
    const resolved = await this.resolveJobRoot(claimed.id, false).catch(() => undefined);
    const pathTokens = [
      ...baseTokens,
      ...(resolved === undefined
        ? []
        : [resolved.outputRoot.realRoot, resolved.jobRoot, join(resolved.jobRoot, 'attempts')]),
    ];
    try {
      await fence.assertOwned();
      await publishRunFailure(
        {
          ...(claimed.installationId === undefined
            ? {}
            : { installationId: claimed.installationId }),
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
        fence,
      );
      await fence.assertOwned();
      if (fence.lost)
        return {
          status: 'cancelled',
          job: claimed,
          error: LEASE_LOST_ERROR,
        };
      const acknowledged = await this.dependencies.queue.acknowledgeFailure(claimed.id, lease);
      if (!acknowledged)
        return {
          status: 'cancelled',
          job: claimed,
          error: LEASE_LOST_ERROR,
        };
    } catch (error) {
      if (fence.lost)
        return {
          status: 'cancelled',
          job: claimed,
          error: LEASE_LOST_ERROR,
        };
      await this.releaseTerminalLease(claimed, lease, fence);
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

  private async runOnceExclusive(): Promise<WorkerRunResult> {
    if (this.stopping) return { status: 'idle' };
    const owner = createLeaseOwner(this.dependencies.workerId);
    const claimed = await this.dependencies.queue.claim(owner, this.leaseMs);
    if (claimed === undefined) {
      await this.reaperAtIdle();
      return { status: 'idle' };
    }
    if (this.stopping) return { status: 'cancelled', job: claimed };
    if (claimed.leaseOwner === undefined) return { status: 'cancelled', job: claimed };
    const lease: QueueLease = {
      owner: claimed.leaseOwner,
      generation: claimed.leaseGeneration,
    };
    const fence = new WorkerLeaseFence(this.dependencies.queue, claimed.id, lease, this.leaseMs);
    this.activeFence = fence;
    let attemptPaths: AttemptPaths | undefined;
    let evidencePath: string | undefined;
    try {
      if (
        this.dependencies.github.requiresInstallationId === true &&
        claimed.installationId === undefined
      ) {
        if (claimed.status === 'failed') {
          const acknowledged = await this.dependencies.queue.acknowledgeFailure(claimed.id, lease);
          return {
            status: 'failed',
            job: claimed,
            error: acknowledged
              ? (claimed.lastError ??
                'Legacy terminal job acknowledged without installation identity')
              : 'Legacy terminal job could not be acknowledged',
          };
        }
        await this.dependencies.queue.cancel(claimed.id, 'Installation identity unavailable');
        return {
          status: 'cancelled',
          job: claimed,
          error: 'Installation identity unavailable',
        };
      }
      if (claimed.status === 'failed') return await this.runTerminalClaim(claimed, lease, fence);
      const result = await this.execute(claimed, fence.signal);
      attemptPaths = result.paths;
      evidencePath = result.bundlePath;
      await fence.assertOwned();
      try {
        await this.assertFreshPullRequest(claimed, fence);
      } catch (error) {
        if (error instanceof PullRequestStaleError)
          return await this.cancelStaleJob(claimed, lease, fence);
        throw error;
      }
      await publishRunResult(
        {
          ...(claimed.installationId === undefined
            ? {}
            : { installationId: claimed.installationId }),
          repository: claimed.repository,
          pullRequest: claimed.pullRequest,
          headSha: claimed.headSha,
          bundle: result.bundle,
        },
        this.dependencies.store,
        this.dependencies.github,
        fence,
      );
      await fence.assertOwned();
      if (fence.lost)
        return {
          status: 'cancelled',
          job: claimed,
          ...result,
          error: LEASE_LOST_ERROR,
        };
      const completed = await this.dependencies.queue.complete(claimed.id, lease, {
        evidencePath: result.bundlePath,
        outcome: result.outcome,
      });
      if (!completed) return { status: 'cancelled', job: claimed, ...result };
      return { status: 'completed', job: claimed, ...result };
    } catch (error) {
      if (fence.lost || this.stopping)
        return {
          status: 'cancelled',
          job: claimed,
          ...(evidencePath === undefined ? {} : { bundlePath: evidencePath }),
          error: LEASE_LOST_ERROR,
        };
      const executionError = error instanceof WorkerExecutionError ? error : undefined;
      if (executionError?.evidencePath !== undefined) evidencePath = executionError.evidencePath;
      // Prefer the attempt's own token set. When even that is unavailable,
      // include both the configured and the realpath forms of the output root
      // so a symlinked or relocated root cannot leak into public text.
      let pathTokens = executionError?.pathTokens ?? attemptPaths?.pathTokens;
      if (pathTokens === undefined) {
        const fallbackRoot = await this.resolveOutputRoot(false).catch(() => undefined);
        pathTokens = [
          resolve(this.dependencies.outputRoot),
          ...(fallbackRoot === undefined ? [] : [fallbackRoot.realRoot]),
        ];
      }
      const message =
        executionError?.message ?? sanitizeWorkerText(errorMessage(error), pathTokens);
      const retryable = retryableWorkerError(error);
      try {
        await fence.assertOwned();
        if (fence.lost) throw new LeaseLostError();
      } catch {
        return {
          status: 'cancelled',
          job: claimed,
          error: LEASE_LOST_ERROR,
          ...(evidencePath === undefined ? {} : { bundlePath: evidencePath }),
        };
      }
      const updated = await this.dependencies.queue.fail(claimed.id, lease, message, retryable);
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
      if (updated.status === 'failed') {
        if (executionError?.cleanupPending === true) {
          if (fence.lost)
            return {
              status: 'cancelled',
              job: claimed,
              error: LEASE_LOST_ERROR,
              ...(evidencePath === undefined ? {} : { bundlePath: evidencePath }),
            };
          await this.releaseTerminalLease(updated, lease, fence);
          if (fence.lost)
            return {
              status: 'cancelled',
              job: claimed,
              error: LEASE_LOST_ERROR,
              ...(evidencePath === undefined ? {} : { bundlePath: evidencePath }),
            };
          return {
            status: 'failed',
            job: updated,
            error: SOURCE_CLEANUP_ERROR,
            ...(evidencePath === undefined ? {} : { bundlePath: evidencePath }),
          };
        }
        return await this.runTerminalClaim(updated, lease, fence);
      }
      return {
        status: 'failed',
        job: updated,
        error: message,
        ...(evidencePath === undefined ? {} : { bundlePath: evidencePath }),
      };
    } finally {
      await fence.stop();
      if (this.activeFence === fence) this.activeFence = undefined;
    }
  }

  public runOnce(): Promise<WorkerRunResult> {
    const previous = this.runOnceTail;
    let release!: () => void;
    const turn = new Promise<void>((resolveTurn) => {
      release = resolveTurn;
    });
    this.runOnceTail = previous.then(
      () => turn,
      () => turn,
    );
    return previous.then(
      () => this.runOnceExclusive().finally(release),
      (error) => {
        release();
        throw error;
      },
    );
  }

  public async runUntilIdle(): Promise<WorkerRunResult[]> {
    const results: WorkerRunResult[] = [];
    while (!this.stopping) {
      const result = await this.runOnce();
      results.push(result);
      if (result.status === 'idle') break;
      if (result.status === 'failed' && result.job?.status === 'failed') {
        let current: QueueJob[];
        try {
          current = await this.dependencies.queue.list();
        } catch {
          break;
        }
        const unresolved = current.find((job) => job.id === result.job?.id);
        if (
          unresolved?.status === 'failed' &&
          !unresolved.failureNotified &&
          unresolved.leaseOwner === undefined
        )
          break;
      }
    }
    return results;
  }

  public async runForever(pollMs = 1_000): Promise<void> {
    while (!this.stopping) {
      let result: WorkerRunResult;
      try {
        result = await this.runOnce();
      } catch (error) {
        // A queue or store fault must never kill the daemon. A transient
        // SQLITE_BUSY or one corrupt row would otherwise become a permanent
        // crash loop; log a bounded operator line and keep polling instead.
        console.error(
          `PatchProof worker iteration failed: ${
            error instanceof Error
              ? error.message.replaceAll(/[\r\n]+/gu, ' ').slice(0, 300)
              : 'unknown error'
          }`,
        );
        await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
        continue;
      }
      if (result.status === 'idle')
        await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  }
}
