import {
  buildManagedCommentPayload,
  buildQueuedCheckPayload,
  isAuthorizedCommand,
  isManagedComment,
  parseIssueCommentCommand,
  verifyWebhookSignature,
} from '@patchproof/github';
import type { GitHubTransport, ManagedStateStore, PullRequestSnapshot } from '@patchproof/github';

export interface RunEnqueueRequest {
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

function extractPullRequest(payload: Record<string, unknown>):
  | {
      repository: string;
      pullRequest: number;
      baseSha: string;
      headSha: string;
      headRepository: string;
      fork: boolean;
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
  if (
    repository === undefined ||
    pullRequest === undefined ||
    baseSha === undefined ||
    headSha === undefined ||
    headRepository === undefined
  )
    return undefined;
  return {
    repository,
    pullRequest,
    baseSha,
    headSha,
    headRepository,
    fork: headRepository !== repository,
  };
}

async function ensureRunSurfaces(
  repository: string,
  pullRequest: number,
  headSha: string,
  store: ManagedStateStore,
  github: GitHubTransport,
): Promise<void> {
  const existing = await store.getRun(repository, pullRequest);
  let checkId = existing?.checkId;
  let commentId = existing?.commentId;
  if (checkId === undefined)
    checkId = (await github.createCheck(repository, headSha, buildQueuedCheckPayload())).id;
  if (commentId === undefined)
    commentId = (
      await github.createComment(repository, pullRequest, {
        body: '<!-- patchproof:summary:start -->\n## PatchProof - queued\n\nThe webhook queued an isolated run. Pull-request code is never executed in this process.\n<!-- patchproof:summary:end -->',
      })
    ).id;
  await store.putRun(repository, pullRequest, { checkId, commentId });
}

async function markIgnored(
  store: ManagedStateStore,
  deliveryId: string,
  body: string,
): Promise<WebhookResponse> {
  await store.markDelivery(deliveryId);
  return { status: 200, body, enqueued: false };
}

export async function handleWebhook(
  request: WebhookRequest,
  dependencies: WebhookDependencies,
): Promise<WebhookResponse> {
  if (!verifyWebhookSignature(request.rawBody, request.signature, dependencies.webhookSecret))
    return { status: 401, body: 'invalid signature', enqueued: false };
  if (request.deliveryId === undefined || request.event === undefined)
    return { status: 400, body: 'missing delivery metadata', enqueued: false };
  if (await dependencies.store.getDelivery(request.deliveryId))
    return { status: 200, body: 'duplicate delivery ignored', enqueued: false };
  let payload: unknown;
  try {
    payload = JSON.parse(request.rawBody) as unknown;
  } catch {
    return markIgnored(dependencies.store, request.deliveryId, 'invalid JSON');
  }
  if (typeof payload !== 'object' || payload === null)
    return markIgnored(dependencies.store, request.deliveryId, 'invalid payload');
  const object = payload as Record<string, unknown>;

  if (request.event === 'pull_request') {
    const action = stringValue(object.action);
    const pr = extractPullRequest(object);
    if (pr === undefined || !['opened', 'reopened', 'synchronize'].includes(action ?? ''))
      return markIgnored(dependencies.store, request.deliveryId, 'event ignored');
    await ensureRunSurfaces(
      pr.repository,
      pr.pullRequest,
      pr.headSha,
      dependencies.store,
      dependencies.github,
    );
    await dependencies.enqueue({ ...pr, reason: 'pull_request' });
    await dependencies.store.markDelivery(request.deliveryId);
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

    let snapshot: PullRequestSnapshot;
    try {
      snapshot = await dependencies.github.getPullRequest(repository, pullRequest);
    } catch {
      return { status: 502, body: 'pull request refs unavailable', enqueued: false };
    }
    if (snapshot.number !== pullRequest || snapshot.state !== 'open')
      return markIgnored(dependencies.store, request.deliveryId, 'pull request is not open');
    await ensureRunSurfaces(
      repository,
      pullRequest,
      snapshot.headSha,
      dependencies.store,
      dependencies.github,
    );
    await dependencies.enqueue({
      repository,
      pullRequest,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
      headRepository: snapshot.headRepository,
      fork: snapshot.fork,
      reason: 'issue_comment',
    });
    await dependencies.store.markDelivery(request.deliveryId);
    return { status: 202, body: 'run queued', enqueued: true };
  }

  return markIgnored(dependencies.store, request.deliveryId, 'event ignored');
}

export { buildManagedCommentPayload, isAuthorizedCommand, isManagedComment };
