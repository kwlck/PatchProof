import {
  buildManagedCommentPayload,
  buildCancelledCheckPayload,
  buildQueuedCheckPayload,
  isAuthorizedCommand,
  isManagedComment,
  parseIssueCommentCommand,
  verifyWebhookSignature,
  managedCheckExternalName,
} from '@patchproof/github';
import type {
  GitHubTransport,
  ManagedStateStore,
  PullRequestSnapshot,
  PublicationClaim,
} from '@patchproof/github';

export interface RunEnqueueRequest {
  installationId?: number;
  repository: string;
  pullRequest: number;
  baseSha: string;
  headSha: string;
  headRepository: string;
  fork?: boolean;
  reason: 'pull_request' | 'issue_comment';
}

export interface WebhookDependencies {
  webhookSecret: string;
  store: ManagedStateStore;
  github: GitHubTransport;
  enqueue: (request: RunEnqueueRequest) => Promise<void>;
  cancelPullRequest?: (repository: string, pullRequest: number, reason: string) => Promise<number>;
  /** Production wiring sets this true; omitted installation IDs then fail closed. */
  requireInstallationId?: boolean;
}

export interface WebhookRequest {
  rawBody: string;
  signature: string | undefined;
  deliveryId: string | undefined;
  event: string | undefined;
}

export interface WebhookResponse {
  status: number;
  body: string;
  enqueued: boolean;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function repositoryValue(value: unknown): string | undefined {
  const parsed = stringValue(value);
  return parsed !== undefined && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(parsed)
    ? parsed
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function shaValue(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractRepository(payload: Record<string, unknown>): string | undefined {
  const repository = recordValue(payload.repository);
  return repository === undefined ? undefined : repositoryValue(repository.full_name);
}

function extractInstallationId(payload: Record<string, unknown>): number | undefined {
  const installation = recordValue(payload.installation);
  return numberValue(installation?.id);
}

function extractPullRequest(payload: Record<string, unknown>):
  | {
      installationId?: number;
      repository: string;
      pullRequest: number;
      baseSha: string;
      headSha: string;
      headRepository: string;
      fork: boolean;
      beforeSha?: string;
    }
  | undefined {
  const repository = extractRepository(payload);
  const pullRequest = numberValue(payload.number);
  const pullRequestPayload = recordValue(payload.pull_request);
  const base = recordValue(pullRequestPayload?.base);
  const head = recordValue(pullRequestPayload?.head);
  const baseSha = shaValue(base?.sha);
  const headSha = shaValue(head?.sha);
  const headRepository = repositoryValue(recordValue(head?.repo)?.full_name);
  const installationId = extractInstallationId(payload);
  const beforeSha = shaValue(payload.before);
  if (
    repository === undefined ||
    pullRequest === undefined ||
    baseSha === undefined ||
    headSha === undefined ||
    headRepository === undefined
  )
    return undefined;
  return {
    ...(installationId === undefined ? {} : { installationId }),
    repository,
    pullRequest,
    baseSha,
    headSha,
    headRepository,
    fork: headRepository !== repository,
    ...(beforeSha === undefined ? {} : { beforeSha }),
  };
}

async function finalizeManagedCheck(
  repository: string,
  pullRequest: number,
  headSha: string,
  installationId: number | undefined,
  store: ManagedStateStore,
  github: GitHubTransport,
): Promise<void> {
  const options = installationId === undefined ? undefined : { installationId };
  const publication = await claimPublicationSurface(
    repository,
    pullRequest,
    headSha,
    github.appId,
    store,
  );
  const claimState: PublicationClaimState = { claim: publication.claim };
  try {
    let checkId = (await store.getRun(repository, pullRequest, headSha, github.appId))?.checkId;
    if (checkId === undefined && github.findManagedCheck !== undefined) {
      checkId = (await github.findManagedCheck(repository, pullRequest, headSha, options))?.id;
    }
    if (checkId === undefined) {
      await renewWebhookClaim(store, claimState, repository, pullRequest);
      return;
    }
    await renewWebhookClaim(store, claimState, repository, pullRequest);
    await github.updateCheck(
      repository,
      checkId,
      {
        ...buildCancelledCheckPayload(),
        externalName: managedCheckExternalName(repository, pullRequest, headSha),
      },
      options,
    );
    await renewWebhookClaim(store, claimState, repository, pullRequest);
  } finally {
    await releasePublicationSurface(repository, pullRequest, headSha, store, claimState.claim);
  }
}

interface PublicationClaimState {
  claim: PublicationClaim | undefined;
}

async function renewWebhookClaim(
  store: ManagedStateStore,
  claimState: PublicationClaimState,
  repository: string,
  pullRequest: number,
): Promise<void> {
  const claim = claimState.claim;
  if (claim === undefined) return;
  if (store.renewPublicationClaim === undefined)
    throw new Error('Managed GitHub publication claim cannot be renewed');
  const renewed = await store.renewPublicationClaim(repository, pullRequest, claim);
  if (renewed === undefined)
    throw new Error('Managed GitHub publication claim expired or was superseded');
  claimState.claim = renewed;
}

async function claimPublicationSurface(
  repository: string,
  pullRequest: number,
  headSha: string,
  appId: number | undefined,
  store: ManagedStateStore,
): Promise<{ claim: PublicationClaim | undefined; claimed: boolean }> {
  if (store.claimPublication !== undefined) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const claim = await store.claimPublication(repository, pullRequest, headSha, appId);
      if (claim !== undefined) return { claim, claimed: true };
      // A prior worker may still be unwinding an in-flight API call. Wait for
      // its PR-wide claim to release instead of using persisted IDs as proof.
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error('Managed GitHub surfaces are busy');
  }
  if (store.claimSurface === undefined) return { claim: undefined, claimed: true };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const claimed = await store.claimSurface(repository, pullRequest, headSha);
    if (claimed) return { claim: undefined, claimed: true };
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error('Managed GitHub surfaces are busy');
}

async function releasePublicationSurface(
  repository: string,
  pullRequest: number,
  headSha: string,
  store: ManagedStateStore,
  claim: PublicationClaim | undefined,
): Promise<void> {
  if (claim !== undefined && store.releasePublication !== undefined)
    await store.releasePublication(repository, pullRequest, claim);
  else if (store.releaseSurface !== undefined)
    await store.releaseSurface(repository, pullRequest, headSha);
}

async function ensureRunSurfaces(
  repository: string,
  pullRequest: number,
  headSha: string,
  installationId: number | undefined,
  store: ManagedStateStore,
  github: GitHubTransport,
): Promise<void> {
  const options = installationId === undefined ? undefined : { installationId };
  const publication = await claimPublicationSurface(
    repository,
    pullRequest,
    headSha,
    github.appId,
    store,
  );
  const claimState: PublicationClaimState = { claim: publication.claim };
  try {
    const existing = await store.getRun(repository, pullRequest, headSha, github.appId);
    let checkId = existing?.checkId;
    let commentId = existing?.commentId;
    if (checkId === undefined && github.findManagedCheck !== undefined) {
      checkId = (await github.findManagedCheck(repository, pullRequest, headSha, options))?.id;
    }
    if (checkId === undefined) {
      await renewWebhookClaim(store, claimState, repository, pullRequest);
      checkId = (
        await github.createCheck(
          repository,
          headSha,
          {
            ...buildQueuedCheckPayload(),
            externalName: managedCheckExternalName(repository, pullRequest, headSha),
          },
          options,
        )
      ).id;
      await renewWebhookClaim(store, claimState, repository, pullRequest);
      // Persist each accepted remote identity before the next mutation.
      await store.putRun(
        repository,
        pullRequest,
        { checkId, ...(github.appId === undefined ? {} : { appId: github.appId }) },
        headSha,
      );
    } else {
      // A rerun must make a previously completed Check non-authoritative
      // before any new worker can publish a result.
      await renewWebhookClaim(store, claimState, repository, pullRequest);
      await github.updateCheck(
        repository,
        checkId,
        {
          ...buildQueuedCheckPayload(),
          externalName: managedCheckExternalName(repository, pullRequest, headSha),
        },
        options,
      );
      await renewWebhookClaim(store, claimState, repository, pullRequest);
    }
    if (commentId === undefined && github.findManagedComment !== undefined) {
      commentId = (await github.findManagedComment(repository, pullRequest, options))?.id;
    }
    if (commentId === undefined) {
      await renewWebhookClaim(store, claimState, repository, pullRequest);
      commentId = (
        await github.createComment(
          repository,
          pullRequest,
          {
            body: '<!-- patchproof:summary:start -->\n## PatchProof - queued\n\nThe webhook queued an isolated run. Pull-request code is never executed in this process.\n<!-- patchproof:summary:end -->',
          },
          options,
        )
      ).id;
      await renewWebhookClaim(store, claimState, repository, pullRequest);
    }
    await renewWebhookClaim(store, claimState, repository, pullRequest);
    await store.putRun(
      repository,
      pullRequest,
      { checkId, commentId, ...(github.appId === undefined ? {} : { appId: github.appId }) },
      headSha,
    );
    await renewWebhookClaim(store, claimState, repository, pullRequest);
  } finally {
    await releasePublicationSurface(repository, pullRequest, headSha, store, claimState.claim);
  }
}

async function markIgnored(
  store: ManagedStateStore,
  deliveryId: string,
  body: string,
): Promise<WebhookResponse> {
  if (store.completeDelivery !== undefined) await store.completeDelivery(deliveryId);
  else await store.markDelivery(deliveryId);
  return { status: 200, body, enqueued: false };
}

async function completeDelivery(store: ManagedStateStore, deliveryId: string): Promise<void> {
  if (store.completeDelivery !== undefined) await store.completeDelivery(deliveryId);
  else await store.markDelivery(deliveryId);
}

async function releaseDelivery(
  store: ManagedStateStore,
  deliveryId: string,
  error?: string,
): Promise<void> {
  if (store.releaseDelivery !== undefined) await store.releaseDelivery(deliveryId, error);
}

export async function handleWebhook(
  request: WebhookRequest,
  dependencies: WebhookDependencies,
): Promise<WebhookResponse> {
  if (!verifyWebhookSignature(request.rawBody, request.signature, dependencies.webhookSecret))
    return { status: 401, body: 'invalid signature', enqueued: false };
  if (request.deliveryId === undefined || request.event === undefined)
    return { status: 400, body: 'missing delivery metadata', enqueued: false };
  let deliveryClaimed = false;
  if (dependencies.store.claimDelivery !== undefined) {
    const claim = await dependencies.store.claimDelivery(request.deliveryId);
    if (claim === 'completed')
      return { status: 200, body: 'duplicate delivery ignored', enqueued: false };
    if (claim === 'processing')
      return { status: 202, body: 'delivery already processing', enqueued: false };
    deliveryClaimed = true;
  } else if (await dependencies.store.getDelivery(request.deliveryId)) {
    return { status: 200, body: 'duplicate delivery ignored', enqueued: false };
  }
  const failDelivery = async (error?: string): Promise<void> => {
    if (deliveryClaimed)
      await releaseDelivery(dependencies.store, request.deliveryId as string, error);
  };
  let payload: unknown;
  try {
    payload = JSON.parse(request.rawBody) as unknown;
  } catch {
    try {
      return await markIgnored(dependencies.store, request.deliveryId, 'invalid JSON');
    } catch (error) {
      await failDelivery(error instanceof Error ? error.message : undefined);
      throw error;
    }
  }
  if (typeof payload !== 'object' || payload === null)
    return markIgnored(dependencies.store, request.deliveryId, 'invalid payload');
  const object = payload as Record<string, unknown>;
  const installationRequired =
    dependencies.requireInstallationId === true ||
    dependencies.github.requiresInstallationId === true;

  if (request.event === 'pull_request') {
    const action = stringValue(object.action);
    const pr = extractPullRequest(object);
    if (pr === undefined)
      return markIgnored(dependencies.store, request.deliveryId, 'event ignored');
    if (installationRequired && pr.installationId === undefined)
      return markIgnored(
        dependencies.store,
        request.deliveryId,
        'installation identity unavailable',
      );
    if (action === 'closed') {
      try {
        // Fence queue workers before touching the remote Check. A stale
        // worker must not be able to publish after the closed surface wins.
        if (dependencies.cancelPullRequest !== undefined)
          await dependencies.cancelPullRequest(
            pr.repository,
            pr.pullRequest,
            'Pull request closed before PatchProof execution',
          );
        await finalizeManagedCheck(
          pr.repository,
          pr.pullRequest,
          pr.headSha,
          pr.installationId,
          dependencies.store,
          dependencies.github,
        );
      } catch (error) {
        await failDelivery(error instanceof Error ? error.message : undefined);
        throw error;
      }
      await completeDelivery(dependencies.store, request.deliveryId);
      return { status: 200, body: 'run cancelled', enqueued: false };
    }
    if (!['opened', 'reopened', 'synchronize'].includes(action ?? ''))
      return markIgnored(dependencies.store, request.deliveryId, 'event ignored');
    try {
      if (action === 'synchronize' && dependencies.cancelPullRequest !== undefined)
        await dependencies.cancelPullRequest(
          pr.repository,
          pr.pullRequest,
          'Pull request synchronized before PatchProof execution',
        );
      if (action === 'synchronize' && pr.beforeSha !== undefined && pr.beforeSha !== pr.headSha)
        await finalizeManagedCheck(
          pr.repository,
          pr.pullRequest,
          pr.beforeSha,
          pr.installationId,
          dependencies.store,
          dependencies.github,
        );
      await ensureRunSurfaces(
        pr.repository,
        pr.pullRequest,
        pr.headSha,
        pr.installationId,
        dependencies.store,
        dependencies.github,
      );
      await dependencies.enqueue({ ...pr, reason: 'pull_request' });
    } catch (error) {
      await failDelivery(error instanceof Error ? error.message : undefined);
      throw error;
    }
    await completeDelivery(dependencies.store, request.deliveryId);
    return { status: 202, body: 'run queued', enqueued: true };
  }

  if (request.event === 'issue_comment') {
    const issue = recordValue(object.issue);
    const comment = recordValue(object.comment);
    const pullRequestMarker = recordValue(issue?.pull_request);
    const userAssociation = stringValue(comment?.author_association);
    const body = stringValue(comment?.body);
    const command = body === undefined ? undefined : parseIssueCommentCommand(body);
    if (
      pullRequestMarker === undefined ||
      command?.command !== 'run' ||
      command.argument !== undefined ||
      !isAuthorizedCommand({
        login: 'webhook-actor',
        association: userAssociation as
          'OWNER' | 'MEMBER' | 'COLLABORATOR' | 'CONTRIBUTOR' | 'NONE',
      })
    )
      return markIgnored(dependencies.store, request.deliveryId, 'comment ignored');
    const repository = extractRepository(object);
    const pullRequest = numberValue(issue?.number);
    if (repository === undefined || pullRequest === undefined)
      return markIgnored(dependencies.store, request.deliveryId, 'invalid pull request comment');
    const installationId = extractInstallationId(object);
    if (installationRequired && installationId === undefined)
      return markIgnored(
        dependencies.store,
        request.deliveryId,
        'installation identity unavailable',
      );

    let snapshot: PullRequestSnapshot;
    try {
      snapshot = await dependencies.github.getPullRequest(
        repository,
        pullRequest,
        installationId === undefined ? undefined : { installationId },
      );
    } catch {
      await failDelivery('pull request refs unavailable');
      return { status: 502, body: 'pull request refs unavailable', enqueued: false };
    }
    if (snapshot.number !== pullRequest || snapshot.state !== 'open')
      return markIgnored(dependencies.store, request.deliveryId, 'pull request is not open');
    try {
      // A comment rerun supersedes an unnotified terminal failure (and any
      // active worker) before resetting the queued Check or managed comment.
      if (dependencies.cancelPullRequest !== undefined)
        await dependencies.cancelPullRequest(
          repository,
          pullRequest,
          'Pull request rerun requested before PatchProof execution',
        );
      await ensureRunSurfaces(
        repository,
        pullRequest,
        snapshot.headSha,
        installationId,
        dependencies.store,
        dependencies.github,
      );
      await dependencies.enqueue({
        ...(installationId === undefined ? {} : { installationId }),
        repository,
        pullRequest,
        baseSha: snapshot.baseSha,
        headSha: snapshot.headSha,
        headRepository: snapshot.headRepository,
        fork: snapshot.fork,
        reason: 'issue_comment',
      });
    } catch (error) {
      await failDelivery(error instanceof Error ? error.message : undefined);
      throw error;
    }
    await completeDelivery(dependencies.store, request.deliveryId);
    return { status: 202, body: 'run queued', enqueued: true };
  }

  return markIgnored(dependencies.store, request.deliveryId, 'event ignored');
}

export { buildManagedCommentPayload, isAuthorizedCommand, isManagedComment };
