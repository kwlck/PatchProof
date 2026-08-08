import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
}

export interface WorkerRunResult {
  status: 'idle' | 'completed' | 'retried' | 'failed' | 'cancelled';
  job?: QueueJob;
  bundlePath?: string;
  outcome?: string;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryableWorkerError(error: unknown): boolean {
  if (error instanceof ConfigValidationError) return false;
  const message = errorMessage(error).toLowerCase();
  return !/(invalid|unsafe|unsupported|policy|configuration|permission denied)/u.test(message);
}

export class PatchProofWorker {
  private readonly leaseMs: number;
  private stopping = false;

  public constructor(private readonly dependencies: PatchProofWorkerDependencies) {
    this.leaseMs = dependencies.leaseMs ?? 60_000;
  }

  public stop(): void {
    this.stopping = true;
  }

  private async execute(job: QueueJob): Promise<{ bundlePath: string; outcome: string }> {
    if (!/^[0-9a-f-]{36}$/iu.test(job.id)) throw new Error('Queue job id is not a UUID');
    const outputRoot = resolve(this.dependencies.outputRoot);
    const jobRoot = join(outputRoot, job.id);
    const basePath = join(jobRoot, 'sources', 'base');
    const headPath = join(jobRoot, 'sources', 'head');
    await mkdir(jobRoot, { recursive: true });
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
    const built = await writeEvidenceBundle({
      outputPath: jobRoot,
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
        location: basePath,
      },
      headSource: {
        revision: 'head',
        ref: job.headSha,
        sha256: job.headSha,
        kind: 'git-commit',
        location: headPath,
      },
    });
    if (
      !(await this.dependencies.queue.heartbeat(job.id, this.dependencies.workerId, this.leaseMs))
    )
      throw new Error('Queue job was cancelled or superseded before publication');
    await publishRunResult(
      {
        repository: job.repository,
        pullRequest: job.pullRequest,
        headSha: job.headSha,
        bundle: built.bundle,
      },
      this.dependencies.store,
      this.dependencies.github,
    );
    return { bundlePath: built.bundlePath, outcome: built.bundle.outcome };
  }

  public async runOnce(): Promise<WorkerRunResult> {
    if (this.stopping) return { status: 'idle' };
    const claimed = await this.dependencies.queue.claim(this.dependencies.workerId, this.leaseMs);
    if (claimed === undefined) return { status: 'idle' };
    if (claimed.status === 'failed') {
      try {
        await publishRunFailure(
          {
            repository: claimed.repository,
            pullRequest: claimed.pullRequest,
            headSha: claimed.headSha,
            error: claimed.lastError ?? 'The worker lease expired after the retry limit',
          },
          this.dependencies.store,
          this.dependencies.github,
        );
        await this.dependencies.queue.acknowledgeFailure(claimed.id);
      } catch (error) {
        return { status: 'failed', job: claimed, error: errorMessage(error) };
      }
      return {
        status: 'failed',
        job: claimed,
        error: claimed.lastError ?? 'The worker lease expired after the retry limit',
      };
    }
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let evidencePath: string | undefined;
    try {
      heartbeatTimer = setInterval(
        () => {
          void this.dependencies.queue
            .heartbeat(claimed.id, this.dependencies.workerId, this.leaseMs)
            .catch(() => false);
        },
        Math.max(1_000, Math.floor(this.leaseMs / 3)),
      );
      const result = await this.execute(claimed);
      evidencePath = result.bundlePath;
      const completed = await this.dependencies.queue.complete(
        claimed.id,
        this.dependencies.workerId,
        { evidencePath: result.bundlePath, outcome: result.outcome },
      );
      if (!completed) return { status: 'cancelled', job: claimed, ...result };
      return { status: 'completed', job: claimed, ...result };
    } catch (error) {
      const message = errorMessage(error);
      const retryable = retryableWorkerError(error);
      const updated = await this.dependencies.queue.fail(
        claimed.id,
        this.dependencies.workerId,
        message,
        retryable,
      );
      if (evidencePath === undefined)
        await rm(join(resolve(this.dependencies.outputRoot), claimed.id), {
          recursive: true,
          force: true,
        });
      if (updated?.status === 'failed') {
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
          await this.dependencies.queue.acknowledgeFailure(updated.id);
        } catch {
          // The durable queue remains failed when the GitHub transport is unavailable.
        }
      }
      if (updated?.status === 'queued') return { status: 'retried', job: updated, error: message };
      if (updated === undefined) return { status: 'cancelled', job: claimed, error: message };
      return {
        status: 'failed',
        job: updated ?? claimed,
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
