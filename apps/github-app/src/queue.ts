import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type QueueJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface QueueLease {
  owner: string;
  generation: number;
}

export interface QueueCleanupCursor {
  createdAt: string;
  id: string;
}

export interface QueueEnqueueRequest {
  /** App installation identity; omitted only for legacy/offline test adapters. */
  installationId?: number;
  repository: string;
  pullRequest: number;
  baseSha: string;
  headSha: string;
  headRepository?: string;
  fork?: boolean;
  reason: 'pull_request' | 'issue_comment';
}

export interface QueueJob extends Omit<
  QueueEnqueueRequest,
  'headRepository' | 'fork' | 'installationId'
> {
  /** Undefined only for legacy rows; production workers fail closed on it. */
  installationId: number | undefined;
  headRepository: string;
  fork: boolean;
  id: string;
  status: QueueJobStatus;
  attempts: number;
  maxAttempts: number;
  leaseGeneration: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  evidencePath?: string;
  outcome?: string;
  failureNotified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RunQueue {
  enqueue(request: QueueEnqueueRequest, maxAttempts?: number): Promise<QueueJob>;
  claim(workerId: string, leaseMs?: number): Promise<QueueJob | undefined>;
  heartbeat(jobId: string, lease: QueueLease, leaseMs?: number): Promise<boolean>;
  complete(
    jobId: string,
    lease: QueueLease,
    result?: { evidencePath?: string; outcome?: string },
  ): Promise<boolean>;
  fail(
    jobId: string,
    lease: QueueLease,
    error: string,
    retryable: boolean,
  ): Promise<QueueJob | undefined>;
  acknowledgeFailure(jobId: string, lease: QueueLease): Promise<boolean>;
  releaseFailure(jobId: string, lease: QueueLease): Promise<boolean>;
  /** Fenced cancellation for a leased, unnotified terminal failure. */
  cancelTerminal(jobId: string, lease: QueueLease, reason: string): Promise<boolean>;
  cancel(jobId: string, reason: string): Promise<boolean>;
  cancelPullRequest?(repository: string, pullRequest: number, reason: string): Promise<number>;
  listTerminalCleanupCandidates(
    after: QueueCleanupCursor | undefined,
    limit: number,
  ): Promise<QueueCleanupCursor[]>;
  pruneTerminalJobs?(retentionMs: number): Promise<number>;
  list(): Promise<QueueJob[]>;
  close(): void;
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

function rowToJob(row: Record<string, unknown>): QueueJob {
  const requiredString = (key: string): string => {
    const value = row[key];
    if (typeof value !== 'string') throw new Error(`Queue row field ${key} is invalid`);
    return value;
  };
  const requiredNumber = (key: string): number => {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
      throw new Error(`Queue row field ${key} is invalid`);
    return value;
  };
  const status = requiredString('status');
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status))
    throw new Error(`Queue row status is invalid: ${status}`);
  const repository = requiredString('repository');
  const installationId = row.installation_id;
  if (
    installationId !== null &&
    installationId !== undefined &&
    (typeof installationId !== 'number' ||
      !Number.isSafeInteger(installationId) ||
      installationId < 1)
  )
    throw new Error('Queue row installation identity is invalid');
  const storedHeadRepository = row.head_repository;
  const headRepository =
    typeof storedHeadRepository === 'string' && storedHeadRepository.length > 0
      ? storedHeadRepository
      : repository;
  const baseSha = requiredString('base_sha');
  const headSha = requiredString('head_sha');
  const reason = requiredString('reason');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error('Queue row repository is invalid');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(headRepository))
    throw new Error('Queue row head repository is invalid');
  if (
    typeof row.pull_request !== 'number' ||
    !Number.isSafeInteger(row.pull_request) ||
    row.pull_request < 1
  )
    throw new Error('Queue row pull request is invalid');
  if (!/^[0-9a-f]{40}$/iu.test(baseSha) || !/^[0-9a-f]{40}$/iu.test(headSha))
    throw new Error('Queue row refs are invalid');
  if (reason !== 'pull_request' && reason !== 'issue_comment')
    throw new Error('Queue row reason is invalid');
  return {
    id: requiredString('id'),
    installationId: typeof installationId === 'number' ? installationId : undefined,
    repository,
    pullRequest: requiredNumber('pull_request'),
    baseSha,
    headSha,
    headRepository,
    fork: row.fork === 1,
    reason,
    status: status as QueueJobStatus,
    attempts: requiredNumber('attempts'),
    maxAttempts: requiredNumber('max_attempts'),
    leaseGeneration: requiredNumber('lease_generation'),
    ...(typeof row.lease_owner === 'string' ? { leaseOwner: row.lease_owner } : {}),
    ...(typeof row.lease_expires_at === 'string' ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(typeof row.last_error === 'string' ? { lastError: row.last_error } : {}),
    ...(typeof row.evidence_path === 'string' ? { evidencePath: row.evidence_path } : {}),
    ...(typeof row.outcome === 'string' ? { outcome: row.outcome } : {}),
    failureNotified: row.failure_notified === 1,
    createdAt: requiredString('created_at'),
    updatedAt: requiredString('updated_at'),
  };
}

function assertRequest(request: QueueEnqueueRequest, requireInstallationId: boolean): void {
  if (
    request.installationId !== undefined &&
    (!Number.isSafeInteger(request.installationId) || request.installationId < 1)
  )
    throw new Error('Queue installation identity must be a positive safe integer');
  if (requireInstallationId && request.installationId === undefined)
    throw new Error('Queue installation identity is required');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository))
    throw new Error('Queue repository must be owner/name');
  if (!Number.isSafeInteger(request.pullRequest) || request.pullRequest < 1)
    throw new Error('Queue pull request must be a positive safe integer');
  if (!/^[0-9a-f]{40}$/iu.test(request.baseSha) || !/^[0-9a-f]{40}$/iu.test(request.headSha))
    throw new Error('Queue refs must be 40-character Git SHAs');
  const headRepository = request.headRepository ?? request.repository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(headRepository))
    throw new Error('Queue head repository must be owner/name');
  if (request.reason !== 'pull_request' && request.reason !== 'issue_comment')
    throw new Error('Queue reason is invalid');
}

function assertLease(lease: QueueLease): void {
  if (
    lease === undefined ||
    typeof lease.owner !== 'string' ||
    lease.owner.length === 0 ||
    lease.owner.length > 128 ||
    !Number.isSafeInteger(lease.generation) ||
    lease.generation < 0
  )
    throw new Error('Queue lease is invalid');
}

export class SqliteQueue implements RunQueue {
  private readonly database: DatabaseSync;
  private readonly clock: () => Date;
  private readonly requireInstallationId: boolean;
  private terminalPollCounter = 0;

  private withImmediateTransaction<T>(operation: (now: Date) => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const now = this.clock();
      const result = operation(now);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error if rollback itself is unavailable.
      }
      throw error;
    }
  }

  public constructor(
    filename = ':memory:',
    clock: () => Date = () => new Date(),
    options: { requireInstallationId?: boolean } = {},
  ) {
    this.database = new DatabaseSync(filename);
    this.clock = clock;
    this.requireInstallationId = options.requireInstallationId === true;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS patchproof_jobs (
        id TEXT PRIMARY KEY,
        installation_id INTEGER,
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        head_repository TEXT NOT NULL,
        fork INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        evidence_path TEXT,
        outcome TEXT,
        failure_notified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS patchproof_jobs_ready
        ON patchproof_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS patchproof_jobs_pr
        ON patchproof_jobs(repository, pull_request, updated_at);
      CREATE INDEX IF NOT EXISTS patchproof_jobs_cleanup_ready
        ON patchproof_jobs(created_at, id)
        WHERE status IN ('succeeded', 'cancelled')
          AND lease_owner IS NULL AND lease_expires_at IS NULL;
    `);
    for (const column of [
      'ALTER TABLE patchproof_jobs ADD COLUMN installation_id INTEGER',
      'ALTER TABLE patchproof_jobs ADD COLUMN head_repository TEXT',
      'ALTER TABLE patchproof_jobs ADD COLUMN fork INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE patchproof_jobs ADD COLUMN evidence_path TEXT',
      'ALTER TABLE patchproof_jobs ADD COLUMN outcome TEXT',
      'ALTER TABLE patchproof_jobs ADD COLUMN failure_notified INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE patchproof_jobs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0',
    ]) {
      try {
        this.database.exec(column);
      } catch {
        // The column already exists in a previously initialized local database.
      }
    }
  }

  public enqueue(request: QueueEnqueueRequest, maxAttempts = 3): Promise<QueueJob> {
    assertRequest(request, this.requireInstallationId);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
      throw new Error('Queue maxAttempts must be between 1 and 20');
    const now = nowIso(this.clock);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database
        .prepare(
          `SELECT * FROM patchproof_jobs
           WHERE repository = ? AND pull_request = ? AND head_sha = ?
             AND COALESCE(head_repository, repository) = ?
             AND COALESCE(installation_id, 0) = COALESCE(?, 0)
             AND status IN ('queued', 'running')
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(
          request.repository,
          request.pullRequest,
          request.headSha,
          request.headRepository ?? request.repository,
          request.installationId ?? null,
        );
      if (existing !== undefined) {
        this.database.exec('COMMIT');
        return Promise.resolve(rowToJob(existing));
      }
      this.database
        .prepare(
          `UPDATE patchproof_jobs
           SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
               lease_generation = lease_generation + 1, last_error = ?, updated_at = ?
           WHERE repository = ? AND pull_request = ?
             AND (
               head_sha <> ? OR
               COALESCE(head_repository, repository) <> ? OR
               COALESCE(installation_id, 0) <> COALESCE(?, 0) OR
               (status = 'failed' AND failure_notified = 0)
             )
             AND (
               status IN ('queued', 'running') OR
               (status = 'failed' AND failure_notified = 0)
             )`,
        )
        .run(
          `Superseded by head ${request.headSha}`,
          now,
          request.repository,
          request.pullRequest,
          request.headSha,
          request.headRepository ?? request.repository,
          request.installationId ?? null,
        );
      const job: QueueJob = {
        ...request,
        installationId: request.installationId,
        headRepository: request.headRepository ?? request.repository,
        fork: request.fork === true,
        failureNotified: false,
        id: randomUUID(),
        status: 'queued',
        attempts: 0,
        maxAttempts,
        leaseGeneration: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.database
        .prepare(
          `INSERT INTO patchproof_jobs
          (id, installation_id, repository, pull_request, base_sha, head_sha, head_repository, fork, reason, status, attempts,
            max_attempts, lease_generation, lease_owner, lease_expires_at, last_error, evidence_path, outcome, failure_notified, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          job.id,
          job.installationId ?? null,
          job.repository,
          job.pullRequest,
          job.baseSha,
          job.headSha,
          job.headRepository,
          job.fork ? 1 : 0,
          job.reason,
          job.status,
          job.attempts,
          job.maxAttempts,
          job.leaseGeneration,
          job.failureNotified ? 1 : 0,
          job.createdAt,
          job.updatedAt,
        );
      this.database.exec('COMMIT');
      return Promise.resolve(job);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public claim(workerId: string, leaseMs = 60_000): Promise<QueueJob | undefined> {
    if (!workerId || workerId.length > 128) throw new Error('Queue workerId is invalid');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 86_400_000)
      throw new Error('Queue leaseMs is invalid');
    return Promise.resolve(
      this.withImmediateTransaction((now) => {
        const nowText = now.toISOString();
        const expires = new Date(now.getTime() + leaseMs).toISOString();
        this.database
          .prepare(
            `UPDATE patchproof_jobs
           SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
               lease_owner = NULL, lease_expires_at = NULL,
               failure_notified = CASE WHEN attempts >= max_attempts THEN 0 ELSE failure_notified END,
               last_error = CASE WHEN attempts >= max_attempts THEN COALESCE(last_error, 'Lease expired after max attempts') ELSE last_error END,
               updated_at = ?
           WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
          )
          .run(nowText, nowText);
        this.database
          .prepare(
            `UPDATE patchproof_jobs
           SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE status = 'failed' AND failure_notified = 0
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
          )
          .run(nowText, nowText);
        const row = this.database
          .prepare(
            `SELECT * FROM patchproof_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`,
          )
          .get();
        // Terminal failure notifications must not starve behind a busy queue:
        // interleave them deterministically instead of only draining them when
        // the queue happens to be empty.
        this.terminalPollCounter = (this.terminalPollCounter + 1) % 4;
        const terminal =
          row === undefined || this.terminalPollCounter === 0
            ? this.database
                .prepare(
                  `SELECT * FROM patchproof_jobs
                 WHERE status = 'failed' AND failure_notified = 0
                   AND lease_owner IS NULL AND lease_expires_at IS NULL
                 ORDER BY updated_at ASC, id ASC LIMIT 1`,
                )
                .get()
            : undefined;
        const selected = row ?? terminal;
        if (selected === undefined) {
          return undefined;
        }
        const id = selected.id;
        if (typeof id !== 'string') throw new Error('Queue row id is invalid');
        if (selected.status === 'failed')
          this.database
            .prepare(
              `UPDATE patchproof_jobs
             SET lease_generation = lease_generation + 1,
                 lease_owner = ?, lease_expires_at = ?, updated_at = ?
             WHERE id = ? AND status = 'failed' AND failure_notified = 0
               AND lease_owner IS NULL AND lease_expires_at IS NULL`,
            )
            .run(workerId, expires, nowText, id);
        else
          this.database
            .prepare(
              `UPDATE patchproof_jobs
             SET status = 'running', attempts = attempts + 1,
                 lease_generation = lease_generation + 1, lease_owner = ?,
                 lease_expires_at = ?, updated_at = ?
             WHERE id = ? AND status = 'queued'`,
            )
            .run(workerId, expires, nowText, id);
        const claimed = this.database.prepare('SELECT * FROM patchproof_jobs WHERE id = ?').get(id);
        return claimed === undefined ? undefined : rowToJob(claimed);
      }),
    );
  }

  public heartbeat(jobId: string, lease: QueueLease, leaseMs = 60_000): Promise<boolean> {
    assertLease(lease);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 86_400_000)
      throw new Error('Queue leaseMs is invalid');
    return Promise.resolve(
      this.withImmediateTransaction((now) => {
        const nowText = now.toISOString();
        const expires = new Date(now.getTime() + leaseMs).toISOString();
        const result = this.database
          .prepare(
            `UPDATE patchproof_jobs SET lease_expires_at = ?, updated_at = ?
             WHERE id = ? AND lease_owner = ? AND lease_generation = ?
               AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
               AND lease_expires_at > ?
               AND (status = 'running' OR (status = 'failed' AND failure_notified = 0))`,
          )
          .run(expires, nowText, jobId, lease.owner, lease.generation, nowText);
        return result.changes === 1;
      }),
    );
  }

  public complete(
    jobId: string,
    lease: QueueLease,
    completion: { evidencePath?: string; outcome?: string } = {},
  ): Promise<boolean> {
    assertLease(lease);
    return Promise.resolve(
      this.withImmediateTransaction((now) => {
        const nowText = now.toISOString();
        const update = this.database
          .prepare(
            `UPDATE patchproof_jobs
             SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
                 evidence_path = ?, outcome = ?, updated_at = ?
             WHERE id = ? AND status = 'running' AND lease_owner = ?
               AND lease_generation = ? AND lease_expires_at IS NOT NULL
               AND lease_expires_at > ?`,
          )
          .run(
            completion.evidencePath ?? null,
            completion.outcome ?? null,
            nowText,
            jobId,
            lease.owner,
            lease.generation,
            nowText,
          );
        return update.changes === 1;
      }),
    );
  }

  public fail(
    jobId: string,
    lease: QueueLease,
    error: string,
    retryable: boolean,
  ): Promise<QueueJob | undefined> {
    assertLease(lease);
    if (!error || error.length > 4096) throw new Error('Queue failure reason is invalid');
    return Promise.resolve(
      this.withImmediateTransaction((now) => {
        const nowText = now.toISOString();
        const row = this.database.prepare('SELECT * FROM patchproof_jobs WHERE id = ?').get(jobId);
        if (row === undefined) return undefined;
        const job = rowToJob(row);
        const shouldRetry = retryable && job.attempts < job.maxAttempts;
        const update = this.database
          .prepare(
            `UPDATE patchproof_jobs
             SET status = ?,
                 lease_owner = CASE WHEN ? = 'failed' THEN lease_owner ELSE NULL END,
                 lease_expires_at = CASE WHEN ? = 'failed' THEN lease_expires_at ELSE NULL END,
                 failure_notified = 0, last_error = ?, updated_at = ?
             WHERE id = ? AND status = 'running' AND lease_owner = ?
               AND lease_generation = ? AND lease_expires_at IS NOT NULL
               AND lease_expires_at > ?`,
          )
          .run(
            shouldRetry ? 'queued' : 'failed',
            shouldRetry ? 'queued' : 'failed',
            shouldRetry ? 'queued' : 'failed',
            error,
            nowText,
            jobId,
            lease.owner,
            lease.generation,
            nowText,
          );
        if (update.changes !== 1) return undefined;
        const updated = this.database
          .prepare('SELECT * FROM patchproof_jobs WHERE id = ?')
          .get(jobId);
        return updated === undefined ? undefined : rowToJob(updated);
      }),
    );
  }

  public acknowledgeFailure(jobId: string, lease: QueueLease): Promise<boolean> {
    assertLease(lease);
    return Promise.resolve(
      this.withImmediateTransaction((now) => {
        const nowText = now.toISOString();
        const result = this.database
          .prepare(
            `UPDATE patchproof_jobs
             SET failure_notified = 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'failed' AND failure_notified = 0
               AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
          )
          .run(nowText, jobId, lease.owner, lease.generation, nowText);
        return result.changes === 1;
      }),
    );
  }

  public releaseFailure(jobId: string, lease: QueueLease): Promise<boolean> {
    assertLease(lease);
    return Promise.resolve(
      this.withImmediateTransaction((now) => {
        const nowText = now.toISOString();
        const result = this.database
          .prepare(
            `UPDATE patchproof_jobs
             SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'failed' AND failure_notified = 0
               AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
          )
          .run(nowText, jobId, lease.owner, lease.generation, nowText);
        return result.changes === 1;
      }),
    );
  }

  public cancelTerminal(jobId: string, lease: QueueLease, reason: string): Promise<boolean> {
    assertLease(lease);
    if (!reason || reason.length > 4096) throw new Error('Queue cancellation reason is invalid');
    return Promise.resolve(
      this.withImmediateTransaction((now) => {
        const nowText = now.toISOString();
        const result = this.database
          .prepare(
            `UPDATE patchproof_jobs
             SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
                 lease_generation = lease_generation + 1, last_error = ?, updated_at = ?
             WHERE id = ? AND status = 'failed' AND failure_notified = 0
               AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
          )
          .run(reason, nowText, jobId, lease.owner, lease.generation, nowText);
        return result.changes === 1;
      }),
    );
  }

  public cancel(jobId: string, reason: string): Promise<boolean> {
    if (!reason || reason.length > 4096) throw new Error('Queue cancellation reason is invalid');
    const result = this.database
      .prepare(
        `UPDATE patchproof_jobs
         SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
             lease_generation = lease_generation + 1, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(reason, nowIso(this.clock), jobId);
    return Promise.resolve(result.changes === 1);
  }

  public cancelPullRequest(
    repository: string,
    pullRequest: number,
    reason: string,
  ): Promise<number> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
      throw new Error('Queue repository must be owner/name');
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new Error('Queue pull request must be a positive safe integer');
    if (!reason || reason.length > 4096) throw new Error('Queue cancellation reason is invalid');
    const result = this.database
      .prepare(
        `UPDATE patchproof_jobs
         SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
             lease_generation = lease_generation + 1, last_error = ?, updated_at = ?
         WHERE repository = ? AND pull_request = ?
           AND (
             status IN ('queued', 'running') OR
             (status = 'failed' AND failure_notified = 0)
           )`,
      )
      .run(reason, nowIso(this.clock), repository, pullRequest);
    return Promise.resolve(result.changes);
  }

  public listTerminalCleanupCandidates(
    after: QueueCleanupCursor | undefined,
    limit: number,
  ): Promise<QueueCleanupCursor[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8)
      throw new Error('Queue cleanup limit is invalid');
    if (
      after !== undefined &&
      (typeof after.createdAt !== 'string' || typeof after.id !== 'string' || after.id.length === 0)
    )
      throw new Error('Queue cleanup cursor is invalid');
    const eligible = `status IN ('succeeded', 'cancelled')
      AND lease_owner IS NULL AND lease_expires_at IS NULL`;
    const rows =
      after === undefined
        ? this.database
            .prepare(
              `SELECT created_at, id FROM patchproof_jobs
               WHERE ${eligible}
               ORDER BY created_at ASC, id ASC LIMIT ?`,
            )
            .all(limit)
        : this.database
            .prepare(
              `SELECT created_at, id FROM patchproof_jobs
               WHERE ${eligible}
                 AND (created_at > ? OR (created_at = ? AND id > ?))
               ORDER BY created_at ASC, id ASC LIMIT ?`,
            )
            .all(after.createdAt, after.createdAt, after.id, limit);
    return Promise.resolve(
      rows.map((row) => {
        if (typeof row.created_at !== 'string' || typeof row.id !== 'string')
          throw new Error('Queue cleanup row is invalid');
        return { createdAt: row.created_at, id: row.id };
      }),
    );
  }

  public pruneTerminalJobs(retentionMs: number): Promise<number> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 3_600_000)
      return Promise.reject(new Error('Queue retention window is invalid'));
    const cutoff = new Date(this.clock().getTime() - retentionMs).toISOString();
    const result = this.database
      .prepare(
        `DELETE FROM patchproof_jobs
         WHERE status IN ('succeeded', 'cancelled')
           AND lease_owner IS NULL AND lease_expires_at IS NULL
           AND updated_at < ?`,
      )
      .run(cutoff);
    return Promise.resolve(result.changes);
  }

  public list(): Promise<QueueJob[]> {
    const rows = this.database
      .prepare('SELECT * FROM patchproof_jobs ORDER BY created_at ASC, id ASC')
      .all();
    return Promise.resolve(rows.map(rowToJob));
  }

  public close(): void {
    this.database.close();
  }
}
