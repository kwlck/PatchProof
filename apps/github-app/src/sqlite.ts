import { randomUUID } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
  DeliveryClaim,
  ManagedRunState,
  ManagedStateStore,
  PublicationClaim,
} from '@patchproof/github';
import { PUBLICATION_CLAIM_LEASE_MS } from '@patchproof/github';

const DEFAULT_DELIVERY_STALE_MS = 5 * 60_000;
let warnedWindowsPermissions = false;

function assertDeliveryId(deliveryId: string): void {
  if (!deliveryId || deliveryId.length > 256) throw new Error('Delivery identity is invalid');
}

function assertRunIdentity(repository: string, pullRequest: number, headSha?: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error('Run repository is invalid');
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
    throw new Error('Run pull request is invalid');
  if (headSha !== undefined && !/^[0-9a-f]{40}$/iu.test(headSha))
    throw new Error('Run head SHA is invalid');
}

function assertAppId(appId: number | undefined): void {
  if (appId !== undefined && (!Number.isSafeInteger(appId) || appId < 1))
    throw new Error('Run GitHub App identity is invalid');
}

function parsePublicationClaimArguments(
  headOrApp: string | number | undefined,
  appOrHead: number | string | undefined,
): { headSha: string; appId: number | undefined } {
  if (typeof headOrApp === 'string') {
    if (appOrHead !== undefined && typeof appOrHead !== 'number')
      throw new Error('Publication claim App identity is invalid');
    return { headSha: headOrApp, appId: appOrHead };
  }
  if (typeof appOrHead !== 'string') throw new Error('Publication claim head is required');
  return { headSha: appOrHead, appId: headOrApp };
}

interface PublicationClaimRow {
  app_id: unknown;
  claimed_at: unknown;
  claim_token: unknown;
  expires_at: unknown;
  generation: unknown;
  head_sha: unknown;
  lease_version: unknown;
  renewed_at: unknown;
}

interface PublicationClaimTimestampRow {
  claimed_at: unknown;
  expires_at: unknown;
  pull_request: unknown;
  renewed_at: unknown;
  repository: unknown;
}

const CANONICAL_UTC_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u;
const LEGACY_SQLITE_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u;

/**
 * Canonicalize persisted timestamps without allowing the host timezone to
 * reinterpret legacy SQLite's `YYYY-MM-DD HH:mm:ss` UTC text.
 */
function canonicalUtcIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = CANONICAL_UTC_ISO_PATTERN.exec(value) ?? LEGACY_SQLITE_DATETIME_PATTERN.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7]);
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (!Number.isFinite(milliseconds)) return undefined;
  const parsed = new Date(milliseconds);
  // Date.UTC maps years 0-99 to 1900-1999. Restore the explicit four-digit
  // year before checking every component for calendar overflow.
  if (year <= 99) parsed.setUTCFullYear(year);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second ||
    parsed.getUTCMilliseconds() !== millisecond
  )
    return undefined;
  const canonical = parsed.toISOString();
  return CANONICAL_UTC_ISO_PATTERN.test(value) && canonical !== value ? undefined : canonical;
}

function isMissingLegacyRenewedAt(value: unknown): boolean {
  return value === null || value === undefined;
}

function isMissingLegacyExpiry(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function parseStoredPublicationClaimTimestamp(value: unknown, field: string): number {
  const canonical = canonicalUtcIso(value);
  if (canonical === undefined)
    throw new Error(`SQLite publication claim ${field} timestamp is invalid`);
  const milliseconds = Date.parse(canonical);
  if (!Number.isFinite(milliseconds))
    throw new Error(`SQLite publication claim ${field} timestamp is invalid`);
  return milliseconds;
}

function assertStoredPublicationClaimTimestamps(
  row: Pick<PublicationClaimRow, 'claimed_at' | 'renewed_at' | 'expires_at'>,
): void {
  parseStoredPublicationClaimTimestamp(row.claimed_at, 'claimed_at');
  parseStoredPublicationClaimTimestamp(row.renewed_at, 'renewed_at');
  parseStoredPublicationClaimTimestamp(row.expires_at, 'expires_at');
}

function publicationClaimFromRow(row: PublicationClaimRow): PublicationClaim {
  if (
    (row.app_id !== null && typeof row.app_id !== 'number') ||
    typeof row.claim_token !== 'string' ||
    typeof row.expires_at !== 'string' ||
    typeof row.generation !== 'number' ||
    !Number.isSafeInteger(row.generation) ||
    typeof row.head_sha !== 'string' ||
    typeof row.lease_version !== 'number' ||
    !Number.isSafeInteger(row.lease_version)
  )
    throw new Error('SQLite publication claim row is invalid');
  parseStoredPublicationClaimTimestamp(row.expires_at, 'expires_at');
  const appId = row.app_id === null ? undefined : row.app_id;
  return {
    generation: row.generation,
    token: row.claim_token,
    leaseVersion: row.lease_version,
    headSha: row.head_sha,
    ...(appId === undefined ? {} : { appId }),
    expiresAt: row.expires_at,
  };
}

function secureDatabaseFile(filename: string): void {
  if (filename === ':memory:') return;
  if (process.platform === 'win32') {
    if (!warnedWindowsPermissions) {
      warnedWindowsPermissions = true;
      console.warn('PatchProof SQLite POSIX mode 0600 is unavailable on Windows; use ACLs.');
    }
    return;
  }
  try {
    const stats = statSync(filename);
    const getUid = process.getuid;
    if (typeof getUid === 'function' && stats.uid !== getUid()) {
      console.warn('PatchProof SQLite file ownership could not be validated; mode unchanged');
      return;
    }
    chmodSync(filename, 0o600);
  } catch {
    // A newly-created file can be checked/chmodded by the OS umask. Do not
    // chmod an unresolved or non-owned path.
  }
}

export class SqliteStateStore implements ManagedStateStore {
  private readonly database: DatabaseSync;
  private readonly clock: () => Date;
  private readonly legacySurfaceClaims = new Map<string, PublicationClaim>();

  public constructor(filename = ':memory:', clock: () => Date = () => new Date()) {
    this.database = new DatabaseSync(filename);
    this.clock = clock;
    try {
      secureDatabaseFile(filename);
      this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        claimed_at TEXT,
        completed_at TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        check_id INTEGER,
        comment_id INTEGER,
        app_id INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repository, pull_request)
      );
      CREATE TABLE IF NOT EXISTS managed_checks (
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        check_id INTEGER NOT NULL,
        app_id INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repository, pull_request, head_sha)
      );
      CREATE TABLE IF NOT EXISTS managed_comments (
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
        app_id INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repository, pull_request)
      );
      CREATE TABLE IF NOT EXISTS surface_claims (
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (repository, pull_request, head_sha)
      );
      CREATE TABLE IF NOT EXISTS publication_claims (
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        app_id INTEGER,
        head_sha TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        generation INTEGER NOT NULL,
        claimed_at TEXT NOT NULL,
        renewed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        lease_version INTEGER NOT NULL,
        PRIMARY KEY (repository, pull_request)
      );
      `);
      for (const column of [
        "ALTER TABLE deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'",
        'ALTER TABLE deliveries ADD COLUMN claimed_at TEXT',
        'ALTER TABLE deliveries ADD COLUMN completed_at TEXT',
        'ALTER TABLE deliveries ADD COLUMN last_error TEXT',
        'ALTER TABLE runs ADD COLUMN app_id INTEGER',
        'ALTER TABLE managed_checks ADD COLUMN app_id INTEGER',
        'ALTER TABLE managed_comments ADD COLUMN app_id INTEGER',
        'ALTER TABLE publication_claims ADD COLUMN app_id INTEGER',
        'ALTER TABLE publication_claims ADD COLUMN renewed_at TEXT',
        'ALTER TABLE publication_claims ADD COLUMN expires_at TEXT',
        'ALTER TABLE publication_claims ADD COLUMN lease_version INTEGER NOT NULL DEFAULT 1',
      ]) {
        try {
          this.database.exec(column);
        } catch {
          // Existing databases already have the migration column.
        }
      }
      // Legacy claim rows may contain SQLite's space-form UTC datetime. Normalize
      // them in JavaScript so Date.parse never interprets that text as local
      // time (and make the migration idempotent). Missing expiry values inherit
      // the original five-minute lease from the claimed-at instant.
      this.normalizePublicationClaimTimestamps();
      // Preserve the old PR-scoped comment identity while deliberately not
      // reusing old check IDs for a head-specific publication.
      this.database.exec(`
      INSERT OR IGNORE INTO managed_comments(repository, pull_request, comment_id, app_id, updated_at)
      SELECT repository, pull_request, comment_id, app_id, updated_at
      FROM runs
      WHERE comment_id IS NOT NULL;
    `);
    } catch (error) {
      // Construction failed after the SQLite connection opened. Release it
      // exactly once while preserving the original setup or migration error.
      try {
        this.database.close();
      } catch {
        // Preserve the original setup failure.
      }
      throw error;
    }
  }

  private normalizePublicationClaimTimestamps(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      // Acquire the write lock before selecting rows. A concurrent renewal or
      // acquisition must commit before this snapshot is read, and cannot be
      // overwritten by a stale migration update below.
      const rows = this.database
        .prepare(
          `SELECT repository, pull_request, claimed_at, renewed_at, expires_at
           FROM publication_claims`,
        )
        .all() as unknown as PublicationClaimTimestampRow[];
      const update = this.database.prepare(
        `UPDATE publication_claims
         SET claimed_at = ?, renewed_at = ?, expires_at = ?
         WHERE repository = ? AND pull_request = ?`,
      );
      for (const row of rows) {
        if (typeof row.repository !== 'string' || typeof row.pull_request !== 'number') continue;
        const claimedAt = canonicalUtcIso(row.claimed_at);
        if (claimedAt === undefined)
          throw new Error('SQLite publication claim claimed_at timestamp is invalid');
        const renewedAt = isMissingLegacyRenewedAt(row.renewed_at)
          ? claimedAt
          : canonicalUtcIso(row.renewed_at);
        if (renewedAt === undefined)
          throw new Error('SQLite publication claim renewed_at timestamp is invalid');
        let expiresAt: string;
        if (isMissingLegacyExpiry(row.expires_at)) {
          const claimedMilliseconds = Date.parse(claimedAt);
          if (!Number.isFinite(claimedMilliseconds))
            throw new Error('SQLite publication claim claimed_at timestamp is invalid');
          expiresAt = new Date(claimedMilliseconds + PUBLICATION_CLAIM_LEASE_MS).toISOString();
        } else {
          expiresAt = canonicalUtcIso(row.expires_at) ?? '';
          if (expiresAt === '')
            throw new Error('SQLite publication claim expires_at timestamp is invalid');
        }
        const currentClaimedAt = typeof row.claimed_at === 'string' ? row.claimed_at : null;
        const currentRenewedAt = typeof row.renewed_at === 'string' ? row.renewed_at : null;
        const currentExpiresAt = typeof row.expires_at === 'string' ? row.expires_at : null;
        if (
          claimedAt !== currentClaimedAt ||
          renewedAt !== currentRenewedAt ||
          expiresAt !== currentExpiresAt
        )
          update.run(claimedAt, renewedAt, expiresAt, row.repository, row.pull_request);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the migration failure.
      }
      throw error;
    }
  }

  private withImmediateTransaction<T>(operation: (now: string) => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const now = this.clock().toISOString();
      const result = operation(now);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the operation failure.
      }
      throw error;
    }
  }

  public getDelivery(deliveryId: string): Promise<boolean> {
    assertDeliveryId(deliveryId);
    return Promise.resolve(
      this.database
        .prepare(
          "SELECT delivery_id FROM deliveries WHERE delivery_id = ? AND status = 'completed'",
        )
        .get(deliveryId) !== undefined,
    );
  }

  public markDelivery(deliveryId: string): Promise<void> {
    assertDeliveryId(deliveryId);
    void this.completeDelivery(deliveryId);
    return Promise.resolve();
  }

  public claimDelivery(
    deliveryId: string,
    staleAfterMs = DEFAULT_DELIVERY_STALE_MS,
  ): Promise<DeliveryClaim> {
    assertDeliveryId(deliveryId);
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 86_400_000)
      throw new Error('Delivery stale timeout is invalid');
    return Promise.resolve(
      this.withImmediateTransaction((now) => {
        const row = this.database
          .prepare('SELECT status, claimed_at FROM deliveries WHERE delivery_id = ?')
          .get(deliveryId);
        if (row !== undefined && row.status === 'completed') return 'completed';
        // Parse through the same canonical UTC path as publication claims: a
        // legacy local-time or malformed stamp must not silently extend or
        // collapse the processing lock.
        const claimedAt =
          typeof row?.claimed_at === 'string' ? canonicalUtcIso(row.claimed_at) : undefined;
        const claimedAtMs = claimedAt === undefined ? Number.NaN : Date.parse(claimedAt);
        const active = Number.isFinite(claimedAtMs) && Date.parse(now) - claimedAtMs < staleAfterMs;
        if (active) return 'processing';
        if (row === undefined) {
          this.database
            .prepare(
              "INSERT INTO deliveries(delivery_id, received_at, status, claimed_at) VALUES (?, ?, 'processing', ?)",
            )
            .run(deliveryId, now, now);
        } else {
          this.database
            .prepare(
              "UPDATE deliveries SET status = 'processing', claimed_at = ?, completed_at = NULL, last_error = NULL WHERE delivery_id = ?",
            )
            .run(now, deliveryId);
        }
        return 'claimed';
      }),
    );
  }

  public completeDelivery(deliveryId: string): Promise<void> {
    assertDeliveryId(deliveryId);
    this.withImmediateTransaction((now) => {
      this.database
        .prepare(
          "INSERT INTO deliveries(delivery_id, received_at, status, completed_at) VALUES (?, ?, 'completed', ?) ON CONFLICT(delivery_id) DO UPDATE SET status = 'completed', completed_at = excluded.completed_at, claimed_at = NULL",
        )
        .run(deliveryId, now, now);
      return undefined;
    });
    return Promise.resolve();
  }

  /**
   * Delete completed deliveries and expired publication claim tombstones that
   * aged past the retention window. Busy installations otherwise accumulate
   * one row per webhook delivery forever, and the boot-time claim scan grows
   * linearly with them.
   */
  public prune(retentionMs: number): Promise<number> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 3_600_000)
      return Promise.reject(new Error('Retention window is invalid'));
    return Promise.resolve(
      this.withImmediateTransaction((now) => {
        const cutoff = new Date(Date.parse(now) - retentionMs).toISOString();
        const deliveries = this.database
          .prepare(
            "DELETE FROM deliveries WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < ?",
          )
          .run(cutoff);
        const claims = this.database
          .prepare('DELETE FROM publication_claims WHERE expires_at < ?')
          .run(cutoff);
        return deliveries.changes + claims.changes;
      }),
    );
  }

  public releaseDelivery(deliveryId: string, error = 'delivery processing failed'): Promise<void> {
    assertDeliveryId(deliveryId);
    void error;
    // Delivery recovery state is not an operator log. Keep credentials and
    // arbitrary provider diagnostics out of SQLite entirely.
    error = 'delivery processing failed';
    this.database
      .prepare(
        "UPDATE deliveries SET status = 'failed', claimed_at = NULL, last_error = ? WHERE delivery_id = ? AND status = 'processing'",
      )
      .run(error, deliveryId);
    return Promise.resolve();
  }

  public claimPublication(
    repository: string,
    pullRequest: number,
    headSha: string,
    appId?: number,
  ): Promise<PublicationClaim | undefined>;

  public claimPublication(
    repository: string,
    pullRequest: number,
    appId: number | undefined,
    headSha: string,
  ): Promise<PublicationClaim | undefined>;

  public claimPublication(
    repository: string,
    pullRequest: number,
    headOrApp: string | number | undefined,
    appOrHead?: number | string,
  ): Promise<PublicationClaim | undefined> {
    const { headSha, appId } = parsePublicationClaimArguments(headOrApp, appOrHead);
    assertRunIdentity(repository, pullRequest, headSha);
    assertAppId(appId);
    const normalizedHead = headSha.toLowerCase();
    return Promise.resolve(
      this.withImmediateTransaction((nowText) => {
        const now = new Date(nowText);
        const existing = this.database
          .prepare(
            `SELECT app_id, head_sha, claim_token, generation, lease_version,
                    claimed_at, renewed_at, expires_at
             FROM publication_claims
             WHERE repository = ? AND pull_request = ?`,
          )
          .get(repository, pullRequest) as unknown as PublicationClaimRow | undefined;
        // The claim is PR-wide. No App or head may evict a live owner.
        if (existing !== undefined) {
          assertStoredPublicationClaimTimestamps(existing);
          const expiresAt = parseStoredPublicationClaimTimestamp(existing.expires_at, 'expires_at');
          if (expiresAt > now.getTime()) return undefined;
        }
        const generation =
          typeof existing?.generation === 'number' && Number.isSafeInteger(existing.generation)
            ? existing.generation + 1
            : 1;
        const token = randomUUID();
        const expiresAt = new Date(now.getTime() + PUBLICATION_CLAIM_LEASE_MS).toISOString();
        this.database
          .prepare(
            `INSERT INTO publication_claims(
               repository, pull_request, app_id, head_sha, claim_token, generation,
               claimed_at, renewed_at, expires_at, lease_version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
             ON CONFLICT(repository, pull_request) DO UPDATE SET
               app_id = excluded.app_id,
               head_sha = excluded.head_sha,
               claim_token = excluded.claim_token,
               generation = excluded.generation,
               claimed_at = excluded.claimed_at,
               renewed_at = excluded.renewed_at,
               expires_at = excluded.expires_at,
               lease_version = excluded.lease_version`,
          )
          .run(
            repository,
            pullRequest,
            appId ?? null,
            normalizedHead,
            token,
            generation,
            nowText,
            nowText,
            expiresAt,
          );
        return {
          generation,
          token,
          leaseVersion: 1,
          headSha: normalizedHead,
          ...(appId === undefined ? {} : { appId }),
          expiresAt,
        };
      }),
    );
  }

  public renewPublicationClaim(
    repository: string,
    pullRequest: number,
    claim: PublicationClaim,
  ): Promise<PublicationClaim | undefined> {
    assertRunIdentity(repository, pullRequest, claim.headSha);
    assertAppId(claim.appId);
    return Promise.resolve(
      this.withImmediateTransaction((nowText) => {
        const now = new Date(nowText);
        const expiresAt = new Date(now.getTime() + PUBLICATION_CLAIM_LEASE_MS).toISOString();
        const nextLeaseVersion = claim.leaseVersion + 1;
        const current = this.database
          .prepare(
            `SELECT app_id, head_sha, claim_token, generation, lease_version,
                    claimed_at, renewed_at, expires_at
             FROM publication_claims
             WHERE repository = ? AND pull_request = ?`,
          )
          .get(repository, pullRequest) as unknown as PublicationClaimRow | undefined;
        if (current === undefined) return undefined;
        assertStoredPublicationClaimTimestamps(current);
        const currentExpiresAt = parseStoredPublicationClaimTimestamp(
          current.expires_at,
          'expires_at',
        );
        if (currentExpiresAt <= now.getTime()) return undefined;
        const updated = this.database
          .prepare(
            `UPDATE publication_claims
             SET lease_version = ?, renewed_at = ?, expires_at = ?
             WHERE repository = ? AND pull_request = ?
               AND app_id IS ? AND head_sha = ? AND claim_token = ?
               AND generation = ? AND lease_version = ?`,
          )
          .run(
            nextLeaseVersion,
            nowText,
            expiresAt,
            repository,
            pullRequest,
            claim.appId ?? null,
            claim.headSha.toLowerCase(),
            claim.token,
            claim.generation,
            claim.leaseVersion,
          );
        if (updated.changes !== 1) return undefined;
        const row = this.database
          .prepare(
            `SELECT app_id, head_sha, claim_token, generation, lease_version,
                    claimed_at, renewed_at, expires_at
             FROM publication_claims
             WHERE repository = ? AND pull_request = ?
               AND app_id IS ? AND head_sha = ? AND claim_token = ?
               AND generation = ? AND lease_version = ?`,
          )
          .get(
            repository,
            pullRequest,
            claim.appId ?? null,
            claim.headSha.toLowerCase(),
            claim.token,
            claim.generation,
            nextLeaseVersion,
          ) as unknown as PublicationClaimRow | undefined;
        return row === undefined ? undefined : publicationClaimFromRow(row);
      }),
    );
  }

  public releasePublication(
    repository: string,
    pullRequest: number,
    claim: PublicationClaim,
  ): Promise<void> {
    assertRunIdentity(repository, pullRequest, claim.headSha);
    this.withImmediateTransaction((nowText) => {
      // Keep an expired tombstone so a subsequent acquisition receives a
      // higher generation. The CAS identity includes leaseVersion, preventing
      // a stale releaser from expiring a later renewal or takeover.
      this.database
        .prepare(
          `UPDATE publication_claims
           SET expires_at = ?
           WHERE repository = ? AND pull_request = ? AND app_id IS ?
             AND head_sha = ? AND claim_token = ? AND generation = ?
             AND lease_version = ?`,
        )
        .run(
          nowText,
          repository,
          pullRequest,
          claim.appId ?? null,
          claim.headSha.toLowerCase(),
          claim.token,
          claim.generation,
          claim.leaseVersion,
        );
      return undefined;
    });
    return Promise.resolve();
  }

  /** Compatibility lock retained for older adapters; it is PR-wide now. */
  public claimSurface(repository: string, pullRequest: number, headSha: string): Promise<boolean> {
    return this.claimPublication(repository, pullRequest, headSha).then((claim) => {
      if (claim === undefined) return false;
      this.legacySurfaceClaims.set(`${repository}#${pullRequest}`, claim);
      return true;
    });
  }

  public releaseSurface(repository: string, pullRequest: number, headSha: string): Promise<void> {
    assertRunIdentity(repository, pullRequest, headSha);
    const key = `${repository}#${pullRequest}`;
    const claim = this.legacySurfaceClaims.get(key);
    this.legacySurfaceClaims.delete(key);
    if (claim === undefined) return Promise.resolve();
    return this.releasePublication(repository, pullRequest, claim);
  }

  public getRun(
    repository: string,
    pullRequest: number,
    headSha?: string,
    appId?: number,
  ): Promise<ManagedRunState | undefined> {
    assertRunIdentity(repository, pullRequest, headSha);
    assertAppId(appId);
    const appFilter = appId === undefined ? '' : ' AND app_id = ?';
    const appParameter = appId === undefined ? [] : [appId];
    const comment = this.database
      .prepare(
        `SELECT comment_id FROM managed_comments
         WHERE repository = ? AND pull_request = ?${appFilter}`,
      )
      .get(repository, pullRequest, ...appParameter);
    // Legacy/unbound rows are intentionally not a fallback when the caller
    // supplies the current App identity. They must be reconciled remotely.
    const legacy =
      appId === undefined && comment === undefined
        ? this.database
            .prepare('SELECT comment_id FROM runs WHERE repository = ? AND pull_request = ?')
            .get(repository, pullRequest)
        : undefined;
    const check =
      headSha === undefined
        ? this.database
            .prepare(
              `SELECT check_id FROM managed_checks
               WHERE repository = ? AND pull_request = ?${appFilter}
               ORDER BY updated_at DESC LIMIT 1`,
            )
            .get(repository, pullRequest, ...appParameter)
        : this.database
            .prepare(
              `SELECT check_id FROM managed_checks
               WHERE repository = ? AND pull_request = ? AND head_sha = ?${appFilter}`,
            )
            .get(repository, pullRequest, headSha.toLowerCase(), ...appParameter);
    const legacyCheck =
      appId === undefined && headSha === undefined
        ? this.database
            .prepare('SELECT check_id FROM runs WHERE repository = ? AND pull_request = ?')
            .get(repository, pullRequest)
        : undefined;
    const commentId =
      typeof comment?.comment_id === 'number'
        ? comment.comment_id
        : typeof legacy?.comment_id === 'number'
          ? legacy.comment_id
          : undefined;
    const checkId =
      typeof check?.check_id === 'number'
        ? check.check_id
        : typeof legacyCheck?.check_id === 'number'
          ? legacyCheck.check_id
          : undefined;
    if (checkId === undefined && commentId === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      ...(checkId === undefined ? {} : { checkId }),
      ...(commentId === undefined ? {} : { commentId }),
    });
  }

  public putRun(
    repository: string,
    pullRequest: number,
    value: ManagedRunState,
    headSha?: string,
    appId?: number,
  ): Promise<void> {
    assertRunIdentity(repository, pullRequest, headSha);
    const effectiveAppId = value.appId ?? appId;
    assertAppId(effectiveAppId);
    const now = this.clock().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (headSha !== undefined && value.checkId !== undefined) {
        this.database
          .prepare(
            `INSERT INTO managed_checks(
               repository, pull_request, head_sha, check_id, app_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(repository, pull_request, head_sha) DO UPDATE SET
               check_id = excluded.check_id,
               app_id = excluded.app_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            repository,
            pullRequest,
            headSha.toLowerCase(),
            value.checkId,
            effectiveAppId ?? null,
            now,
          );
      }
      if (value.commentId !== undefined) {
        this.database
          .prepare(
            `INSERT INTO managed_comments(
               repository, pull_request, comment_id, app_id, updated_at
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(repository, pull_request) DO UPDATE SET
               comment_id = excluded.comment_id,
               app_id = excluded.app_id,
               updated_at = excluded.updated_at`,
          )
          .run(repository, pullRequest, value.commentId, effectiveAppId ?? null, now);
      }
      // Keep the legacy compatibility table populated for offline callers that
      // query getRun without a head. New publication never uses its old check.
      this.database
        .prepare(
          `INSERT INTO runs(repository, pull_request, check_id, comment_id, app_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(repository, pull_request) DO UPDATE SET
             check_id = COALESCE(excluded.check_id, runs.check_id),
             comment_id = COALESCE(excluded.comment_id, runs.comment_id),
             app_id = COALESCE(excluded.app_id, runs.app_id),
             updated_at = excluded.updated_at`,
        )
        .run(
          repository,
          pullRequest,
          value.checkId ?? null,
          value.commentId ?? null,
          effectiveAppId ?? null,
          now,
        );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return Promise.resolve();
  }

  public close(): void {
    this.database.close();
  }
}
