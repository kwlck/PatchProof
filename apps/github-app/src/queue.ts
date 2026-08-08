import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type QueueJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface QueueEnqueueRequest {
  repository: string;
  pullRequest: number;
  baseSha: string;
  headSha: string;
  headRepository?: string;
  fork?: boolean;
  reason: 'pull_request' | 'issue_comment';
}

export interface QueueJob extends Omit<QueueEnqueueRequest, 'headRepository' | 'fork'> {
  headRepository: string;
  fork: boolean;
  id: string;
  status: QueueJobStatus;
  attempts: number;
  maxAttempts: number;
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
  heartbeat(jobId: string, workerId: string, leaseMs?: number): Promise<boolean>;
  complete(
    jobId: string,
    workerId: string,
    result?: { evidencePath?: string; outcome?: string },
  ): Promise<boolean>;
  fail(
    jobId: string,
    workerId: string,
    error: string,
    retryable: boolean,
  ): Promise<QueueJob | undefined>;
  acknowledgeFailure(jobId: string): Promise<boolean>;
  releaseFailure(jobId: string, workerId: string): Promise<boolean>;
  cancel(jobId: string, reason: string): Promise<boolean>;
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
  if (!/^[0-9a-f]{40}$/iu.test(baseSha) || !/^[0-9a-f]{40}$/iu.test(headSha))
    throw new Error('Queue row refs are invalid');
  if (reason !== 'pull_request' && reason !== 'issue_comment')
    throw new Error('Queue row reason is invalid');
  return {
    id: requiredString('id'),
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

function assertRequest(request: QueueEnqueueRequest): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository))
    throw new Error('Queue repository must be owner/name');
  if (!Number.isSafeInteger(request.pullRequest) || request.pullRequest < 1)
    throw new Error('Queue pull request must be a positive safe integer');
  if (!/^[0-9a-f]{40}$/iu.test(request.baseSha) || !/^[0-9a-f]{40}$/iu.test(request.headSha))
    throw new Error('Queue refs must be 40-character Git SHAs');
  const headRepository = request.headRepository ?? request.repository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(headRepository))
    throw new Error('Queue head repository must be owner/name');
}

export class SqliteQueue implements RunQueue {
  private readonly database: DatabaseSync;
  private readonly clock: () => Date;

  public constructor(filename = ':memory:', clock: () => Date = () => new Date()) {
    this.database = new DatabaseSync(filename);
    this.clock = clock;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS patchproof_jobs (
        id TEXT PRIMARY KEY,
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
    `);
    for (const column of [
      'ALTER TABLE patchproof_jobs ADD COLUMN head_repository TEXT',
      'ALTER TABLE patchproof_jobs ADD COLUMN fork INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE patchproof_jobs ADD COLUMN evidence_path TEXT',
      'ALTER TABLE patchproof_jobs ADD COLUMN outcome TEXT',
      'ALTER TABLE patchproof_jobs ADD COLUMN failure_notified INTEGER NOT NULL DEFAULT 0',
    ]) {
      try {
        this.database.exec(column);
      } catch {
        // The column already exists in a previously initialized local database.
      }
    }
  }

  public enqueue(request: QueueEnqueueRequest, maxAttempts = 3): Promise<QueueJob> {
    assertRequest(request);
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
             AND status IN ('queued', 'running')
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(
          request.repository,
          request.pullRequest,
          request.headSha,
          request.headRepository ?? request.repository,
        );
      if (existing !== undefined) {
        this.database.exec('COMMIT');
        return Promise.resolve(rowToJob(existing));
      }
      this.database
        .prepare(
          `UPDATE patchproof_jobs
           SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
               last_error = ?, updated_at = ?
           WHERE repository = ? AND pull_request = ?
             AND (head_sha <> ? OR COALESCE(head_repository, repository) <> ?)
             AND status IN ('queued', 'running')`,
        )
        .run(
          `Superseded by head ${request.headSha}`,
          now,
          request.repository,
          request.pullRequest,
          request.headSha,
          request.headRepository ?? request.repository,
        );
      const job: QueueJob = {
        ...request,
        headRepository: request.headRepository ?? request.repository,
        fork: request.fork === true,
        failureNotified: false,
        id: randomUUID(),
        status: 'queued',
        attempts: 0,
        maxAttempts,
        createdAt: now,
        updatedAt: now,
      };
      this.database
        .prepare(
          `INSERT INTO patchproof_jobs
          (id, repository, pull_request, base_sha, head_sha, head_repository, fork, reason, status, attempts,
            max_attempts, lease_owner, lease_expires_at, last_error, evidence_path, outcome, failure_notified, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          job.id,
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
    const now = this.clock();
    const nowText = now.toISOString();
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
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
      const terminal =
        row === undefined
          ? this.database
              .prepare(
                `SELECT * FROM patchproof_jobs
                 WHERE status = 'failed' AND failure_notified = 0
                   AND (lease_owner IS NULL OR lease_expires_at IS NULL)
                 ORDER BY updated_at ASC, id ASC LIMIT 1`,
              )
              .get()
          : undefined;
      const selected = row ?? terminal;
      if (selected === undefined) {
        this.database.exec('COMMIT');
        return Promise.resolve(undefined);
      }
      const id = selected.id;
      if (typeof id !== 'string') throw new Error('Queue row id is invalid');
      if (selected.status === 'failed')
        this.database
          .prepare(
            `UPDATE patchproof_jobs
             SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
             WHERE id = ? AND status = 'failed' AND failure_notified = 0
               AND (lease_owner IS NULL OR lease_expires_at IS NULL)`,
          )
          .run(workerId, expires, nowText, id);
      else
        this.database
          .prepare(
            `UPDATE patchproof_jobs
             SET status = 'running', attempts = attempts + 1, lease_owner = ?,
                 lease_expires_at = ?, updated_at = ?
             WHERE id = ? AND status = 'queued'`,
          )
          .run(workerId, expires, nowText, id);
      const claimed = this.database.prepare('SELECT * FROM patchproof_jobs WHERE id = ?').get(id);
      this.database.exec('COMMIT');
      return Promise.resolve(claimed === undefined ? undefined : rowToJob(claimed));
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public heartbeat(jobId: string, workerId: string, leaseMs = 60_000): Promise<boolean> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 86_400_000)
      throw new Error('Queue leaseMs is invalid');
    const expires = new Date(this.clock().getTime() + leaseMs).toISOString();
    const result = this.database
      .prepare(
        `UPDATE patchproof_jobs SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(expires, nowIso(this.clock), jobId, workerId);
    return Promise.resolve(result.changes === 1);
  }

  public complete(
    jobId: string,
    workerId: string,
    completion: { evidencePath?: string; outcome?: string } = {},
  ): Promise<boolean> {
    const update = this.database
      .prepare(
        `UPDATE patchproof_jobs
         SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
             evidence_path = ?, outcome = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(
        completion.evidencePath ?? null,
        completion.outcome ?? null,
        nowIso(this.clock),
        jobId,
        workerId,
      );
    return Promise.resolve(update.changes === 1);
  }

  public fail(
    jobId: string,
    workerId: string,
    error: string,
    retryable: boolean,
  ): Promise<QueueJob | undefined> {
    if (!error || error.length > 4096) throw new Error('Queue failure reason is invalid');
    const row = this.database.prepare('SELECT * FROM patchproof_jobs WHERE id = ?').get(jobId);
    if (row === undefined) return Promise.resolve(undefined);
    const job = rowToJob(row);
    if (job.status !== 'running' || job.leaseOwner !== workerId) return Promise.resolve(undefined);
    const shouldRetry = retryable && job.attempts < job.maxAttempts;
    const status: QueueJobStatus = shouldRetry ? 'queued' : 'failed';
    this.database
      .prepare(
        `UPDATE patchproof_jobs
         SET status = ?, lease_owner = NULL, lease_expires_at = NULL, failure_notified = 0,
             last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(status, error, nowIso(this.clock), jobId, workerId);
    const updated = this.database.prepare('SELECT * FROM patchproof_jobs WHERE id = ?').get(jobId);
    return Promise.resolve(updated === undefined ? undefined : rowToJob(updated));
  }

  public acknowledgeFailure(jobId: string): Promise<boolean> {
    const result = this.database
      .prepare(
        `UPDATE patchproof_jobs
         SET failure_notified = 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'failed' AND failure_notified = 0`,
      )
      .run(nowIso(this.clock), jobId);
    return Promise.resolve(result.changes === 1);
  }

  public releaseFailure(jobId: string, workerId: string): Promise<boolean> {
    const result = this.database
      .prepare(
        `UPDATE patchproof_jobs
         SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'failed' AND failure_notified = 0 AND lease_owner = ?`,
      )
      .run(nowIso(this.clock), jobId, workerId);
    return Promise.resolve(result.changes === 1);
  }

  public cancel(jobId: string, reason: string): Promise<boolean> {
    if (!reason || reason.length > 4096) throw new Error('Queue cancellation reason is invalid');
    const result = this.database
      .prepare(
        `UPDATE patchproof_jobs
         SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
             last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(reason, nowIso(this.clock), jobId);
    return Promise.resolve(result.changes === 1);
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
