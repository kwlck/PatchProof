import { randomUUID } from 'node:crypto';
import type { CheckRunPayload, PullRequestCommentPayload } from './format.js';

/** The publication lease is deliberately longer than the 15s GitHub request bound. */
export const PUBLICATION_CLAIM_LEASE_MS = 5 * 60_000;

export interface GitHubMutationOptions {
  signal?: AbortSignal;
  /** Installation whose token must be used for this operation. */
  installationId?: number;
}

export interface PullRequestSnapshot {
  number: number;
  baseSha: string;
  headSha: string;
  headRepository: string;
  fork: boolean;
  state: 'open' | 'closed';
  /** Returned when GitHub includes the base repository metadata. */
  repository?: string;
}

export interface ManagedCheckLookup {
  id: number;
  headSha?: string;
}

export interface ManagedCommentLookup {
  id: number;
  body: string;
}

export interface GitHubTransport {
  /** Production adapters set this to require per-operation installation auth. */
  readonly requiresInstallationId?: boolean;
  /** App-backed adapters expose the exact GitHub App identity for reconciliation. */
  readonly appId?: number;
  /** Production adapters set this to enforce a pre-publication PR snapshot. */
  readonly requiresFreshSnapshot?: boolean;
  getPullRequest(
    repository: string,
    pullRequest: number,
    options?: GitHubMutationOptions,
  ): Promise<PullRequestSnapshot>;
  createCheck(
    repository: string,
    headSha: string,
    payload: CheckRunPayload,
    options?: GitHubMutationOptions,
  ): Promise<{ id: number }>;
  updateCheck(
    repository: string,
    checkId: number,
    payload: CheckRunPayload,
    options?: GitHubMutationOptions,
  ): Promise<void>;
  createComment(
    repository: string,
    issueNumber: number,
    payload: PullRequestCommentPayload,
    options?: GitHubMutationOptions,
  ): Promise<{ id: number; body: string }>;
  updateComment(
    repository: string,
    commentId: number,
    payload: PullRequestCommentPayload,
    options?: GitHubMutationOptions,
  ): Promise<void>;
  /** Optional reconciliation hooks. Adapters without listing support remain usable in tests. */
  findManagedCheck?(
    repository: string,
    pullRequest: number,
    headSha: string,
    options?: GitHubMutationOptions,
  ): Promise<ManagedCheckLookup | undefined>;
  findManagedComment?(
    repository: string,
    pullRequest: number,
    options?: GitHubMutationOptions,
  ): Promise<ManagedCommentLookup | undefined>;
}

export type DeliveryClaim = 'claimed' | 'completed' | 'processing';

export interface ManagedRunState {
  checkId?: number;
  commentId?: number;
  /** GitHub App identity that owns the persisted surface IDs. */
  appId?: number;
}

/**
 * A PR-wide publication claim. `leaseVersion` changes on every renewal, so a
 * caller must replace its handle after renewal before it can release or renew
 * again. `expiresAt` is an ISO timestamp from the store's clock.
 */
export interface PublicationClaim {
  generation: number;
  token: string;
  leaseVersion: number;
  headSha: string;
  appId?: number;
  expiresAt: string;
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

function assertPublicationAppId(appId: number | undefined): void {
  if (appId !== undefined && (!Number.isSafeInteger(appId) || appId < 1))
    throw new Error('Publication claim App identity is invalid');
}

function isClaimLive(claim: PublicationClaim | undefined, now: Date): boolean {
  return claim !== undefined && Date.parse(claim.expiresAt) > now.getTime();
}

function samePublicationClaim(
  current: PublicationClaim | undefined,
  claim: PublicationClaim,
): boolean {
  return (
    current !== undefined &&
    current.generation === claim.generation &&
    current.token === claim.token &&
    current.leaseVersion === claim.leaseVersion &&
    current.headSha === claim.headSha.toLowerCase() &&
    current.appId === claim.appId
  );
}

export interface ManagedStateStore {
  getDelivery(deliveryId: string): Promise<boolean>;
  markDelivery(deliveryId: string): Promise<void>;
  /** Atomically reserves a delivery, preventing concurrent duplicate handling. */
  claimDelivery?(deliveryId: string, staleAfterMs?: number): Promise<DeliveryClaim>;
  completeDelivery?(deliveryId: string): Promise<void>;
  releaseDelivery?(deliveryId: string, error?: string): Promise<void>;
  /** Optional durable per-surface lock for concurrent delivery/publisher reconciliation. */
  claimSurface?(repository: string, pullRequest: number, headSha: string): Promise<boolean>;
  releaseSurface?(repository: string, pullRequest: number, headSha: string): Promise<void>;
  /** Preferred PR-wide publication lock with stale-owner fencing. */
  claimPublication?(
    repository: string,
    pullRequest: number,
    headSha: string,
    appId?: number,
  ): Promise<PublicationClaim | undefined>;
  /** Compatibility overload for callers that pass App identity before head. */
  claimPublication?(
    repository: string,
    pullRequest: number,
    appId: number | undefined,
    headSha: string,
  ): Promise<PublicationClaim | undefined>;
  /** Atomically renews a still-live claim and returns its replacement handle. */
  renewPublicationClaim?(
    repository: string,
    pullRequest: number,
    claim: PublicationClaim,
  ): Promise<PublicationClaim | undefined>;
  releasePublication?(
    repository: string,
    pullRequest: number,
    claim: PublicationClaim,
  ): Promise<void>;
  getRun(
    repository: string,
    pullRequest: number,
    headSha?: string,
    appId?: number,
  ): Promise<ManagedRunState | undefined>;
  putRun(
    repository: string,
    pullRequest: number,
    value: ManagedRunState,
    headSha?: string,
    appId?: number,
  ): Promise<void>;
}

export class MemoryStateStore implements ManagedStateStore {
  private readonly deliveries = new Map<string, 'processing' | 'completed'>();
  private readonly runs = new Map<string, ManagedRunState>();
  private readonly comments = new Map<string, number>();
  private readonly commentApps = new Map<string, number | undefined>();
  private readonly publicationClaims = new Map<string, PublicationClaim>();

  public constructor(private readonly clock: () => Date = () => new Date()) {}

  public getDelivery(deliveryId: string): Promise<boolean> {
    return Promise.resolve(this.deliveries.get(deliveryId) === 'completed');
  }

  public markDelivery(deliveryId: string): Promise<void> {
    this.deliveries.set(deliveryId, 'completed');
    return Promise.resolve();
  }

  public claimDelivery(deliveryId: string): Promise<DeliveryClaim> {
    const existing = this.deliveries.get(deliveryId);
    if (existing === 'completed') return Promise.resolve('completed');
    if (existing === 'processing') return Promise.resolve('processing');
    this.deliveries.set(deliveryId, 'processing');
    return Promise.resolve('claimed');
  }

  public completeDelivery(deliveryId: string): Promise<void> {
    this.deliveries.set(deliveryId, 'completed');
    return Promise.resolve();
  }

  public releaseDelivery(deliveryId: string): Promise<void> {
    this.deliveries.delete(deliveryId);
    return Promise.resolve();
  }

  public claimSurface(repository: string, pullRequest: number, headSha: string): Promise<boolean> {
    return this.claimPublication(repository, pullRequest, headSha).then(
      (claim) => claim !== undefined,
    );
  }

  public releaseSurface(repository: string, pullRequest: number, headSha: string): Promise<void> {
    const claim = this.publicationClaims.get(`${repository}#${pullRequest}`);
    if (claim !== undefined && claim.headSha === headSha.toLowerCase())
      return this.releasePublication(repository, pullRequest, claim);
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
    assertPublicationAppId(appId);
    const key = `${repository}#${pullRequest}`;
    const existing = this.publicationClaims.get(key);
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new Error('Publication claim clock is invalid');
    // The lock is PR-wide: a different head cannot evict a live owner. It may
    // take over only after expiry, and receives a new token and generation.
    if (existing !== undefined && isClaimLive(existing, now)) return Promise.resolve(undefined);
    const generation = existing === undefined ? 1 : existing.generation + 1;
    const normalizedHead = headSha.toLowerCase();
    const claim: PublicationClaim = {
      generation,
      token: randomUUID(),
      leaseVersion: 1,
      headSha: normalizedHead,
      ...(appId === undefined ? {} : { appId }),
      expiresAt: new Date(now.getTime() + PUBLICATION_CLAIM_LEASE_MS).toISOString(),
    };
    this.publicationClaims.set(key, claim);
    return Promise.resolve(claim);
  }

  public renewPublicationClaim(
    repository: string,
    pullRequest: number,
    claim: PublicationClaim,
  ): Promise<PublicationClaim | undefined> {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new Error('Publication claim clock is invalid');
    const current = this.publicationClaims.get(`${repository}#${pullRequest}`);
    // This is the in-process equivalent of the SQLite compare-and-swap. The
    // expiry comparison is strict: a claim at its exact boundary is expired.
    if (
      current === undefined ||
      !samePublicationClaim(current, claim) ||
      !isClaimLive(current, now)
    )
      return Promise.resolve(undefined);
    const renewed: PublicationClaim = {
      ...current,
      leaseVersion: current.leaseVersion + 1,
      expiresAt: new Date(now.getTime() + PUBLICATION_CLAIM_LEASE_MS).toISOString(),
    };
    this.publicationClaims.set(`${repository}#${pullRequest}`, renewed);
    return Promise.resolve(renewed);
  }

  public releasePublication(
    repository: string,
    pullRequest: number,
    claim: PublicationClaim,
  ): Promise<void> {
    const key = `${repository}#${pullRequest}`;
    const current = this.publicationClaims.get(key);
    if (
      current?.generation === claim.generation &&
      current.token === claim.token &&
      current.headSha === claim.headSha &&
      current.leaseVersion === claim.leaseVersion &&
      current.appId === claim.appId
    )
      // Retain an expired tombstone so the next acquisition gets a strictly
      // higher generation even when the previous owner released cleanly.
      this.publicationClaims.set(key, {
        ...current,
        expiresAt: new Date(this.clock().getTime()).toISOString(),
      });
    return Promise.resolve();
  }

  public getRun(
    repository: string,
    pullRequest: number,
    headSha?: string,
    appId?: number,
  ): Promise<ManagedRunState | undefined> {
    const commentId = this.comments.get(`${repository}#${pullRequest}`);
    const commentAppId = this.commentApps.get(`${repository}#${pullRequest}`);
    const state =
      headSha === undefined
        ? this.runs.get(`${repository}#${pullRequest}`)
        : this.runs.get(`${repository}#${pullRequest}#${headSha.toLowerCase()}`);
    const checkAllowed = appId === undefined || state?.appId === appId;
    const commentAllowed = appId === undefined || commentAppId === appId;
    if (!checkAllowed && !commentAllowed) return Promise.resolve(undefined);
    if (state === undefined && (commentId === undefined || !commentAllowed))
      return Promise.resolve(undefined);
    return Promise.resolve({
      ...(state?.checkId === undefined || !checkAllowed ? {} : { checkId: state.checkId }),
      ...(commentId === undefined || !commentAllowed
        ? state?.commentId === undefined
          ? {}
          : commentAllowed
            ? { commentId: state.commentId }
            : {}
        : { commentId }),
    });
  }

  public putRun(
    repository: string,
    pullRequest: number,
    value: ManagedRunState,
    headSha?: string,
    appId?: number,
  ): Promise<void> {
    const key =
      headSha === undefined
        ? `${repository}#${pullRequest}`
        : `${repository}#${pullRequest}#${headSha.toLowerCase()}`;
    const next: ManagedRunState = {};
    if (value.checkId !== undefined) next.checkId = value.checkId;
    if (value.commentId !== undefined) next.commentId = value.commentId;
    const effectiveAppId = value.appId ?? appId;
    if (effectiveAppId !== undefined) next.appId = effectiveAppId;
    this.runs.set(key, next);
    if (headSha !== undefined) {
      const legacyKey = `${repository}#${pullRequest}`;
      const legacy = this.runs.get(legacyKey);
      const merged: ManagedRunState = {};
      if (legacy?.checkId !== undefined) merged.checkId = legacy.checkId;
      if (next.checkId !== undefined) merged.checkId = next.checkId;
      if (legacy?.commentId !== undefined) merged.commentId = legacy.commentId;
      if (next.commentId !== undefined) merged.commentId = next.commentId;
      this.runs.set(legacyKey, merged);
    }
    if (value.commentId !== undefined)
      this.comments.set(`${repository}#${pullRequest}`, value.commentId);
    if (value.commentId !== undefined || value.appId !== undefined || appId !== undefined)
      this.commentApps.set(`${repository}#${pullRequest}`, value.appId ?? appId);
    return Promise.resolve();
  }
}
