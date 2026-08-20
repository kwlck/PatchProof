import { boundLog, redactText, type EvidenceBundle } from '@patchproof/core';
import {
  buildCheckRunPayload,
  buildManagedCommentPayload,
  MANAGED_COMMENT_END,
  MANAGED_COMMENT_START,
  managedCheckExternalName,
  type CheckRunPayload,
} from '@patchproof/github';
import type {
  GitHubTransport,
  GitHubMutationOptions,
  ManagedStateStore,
  PublicationClaim,
} from '@patchproof/github';

export interface PublishRunInput {
  installationId?: number;
  repository: string;
  pullRequest: number;
  headSha: string;
  bundle: EvidenceBundle;
}

export interface PublicationFence {
  readonly signal: AbortSignal;
  assertOwned(): Promise<void>;
}

interface PublicationClaimState {
  claim: PublicationClaim | undefined;
}

async function renewPublicationClaim(
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
  // Every successful renewal returns a new leaseVersion. All later release,
  // renewal, and mutation fences use this replacement handle.
  claimState.claim = renewed;
}

async function assertPublicationOwned(fence: PublicationFence): Promise<void> {
  await fence.assertOwned();
}

async function renewBeforeMutation(
  fence: PublicationFence,
  store: ManagedStateStore,
  claimState: PublicationClaimState,
  repository: string,
  pullRequest: number,
): Promise<void> {
  // Queue ownership is checked before the claim CAS. Once the CAS returns,
  // the GitHub dispatch is the very next operation so the claim cannot expire
  // between renewal and mutation under normal request bounds.
  await fence.assertOwned();
  await renewPublicationClaim(store, claimState, repository, pullRequest);
}

async function renewAfterMutation(
  fence: PublicationFence,
  store: ManagedStateStore,
  claimState: PublicationClaimState,
  repository: string,
  pullRequest: number,
): Promise<void> {
  await renewPublicationClaim(store, claimState, repository, pullRequest);
  // Do not persist an accepted remote ID or report success after the queue
  // lease has been lost while the GitHub request was in flight.
  await fence.assertOwned();
}

function mutationOptions(
  installationId: number | undefined,
  signal: AbortSignal,
): GitHubMutationOptions {
  return {
    signal,
    ...(installationId === undefined ? {} : { installationId }),
  };
}

/** Publishes a completed run through the two managed GitHub surfaces, using persisted IDs for idempotency. */
async function publishRunResultUnlocked(
  input: PublishRunInput,
  store: ManagedStateStore,
  github: GitHubTransport,
  fence: PublicationFence,
  claimState: PublicationClaimState,
): Promise<{ checkId: number; commentId: number }> {
  const checkPayload = {
    ...buildCheckRunPayload(input.bundle),
    externalName: managedCheckExternalName(input.repository, input.pullRequest, input.headSha),
  };
  const commentPayload = buildManagedCommentPayload(input.bundle);
  const state = await store.getRun(
    input.repository,
    input.pullRequest,
    input.headSha,
    github.appId,
  );
  let checkId = state?.checkId;
  let commentId = state?.commentId;
  const saveIds = async (): Promise<void> => {
    await store.putRun(
      input.repository,
      input.pullRequest,
      {
        ...(checkId === undefined ? {} : { checkId }),
        ...(commentId === undefined ? {} : { commentId }),
        ...(github.appId === undefined ? {} : { appId: github.appId }),
      },
      input.headSha,
    );
  };
  await assertPublicationOwned(fence);
  if (checkId === undefined && github.findManagedCheck !== undefined)
    checkId = (
      await github.findManagedCheck(
        input.repository,
        input.pullRequest,
        input.headSha,
        mutationOptions(input.installationId, fence.signal),
      )
    )?.id;
  if (checkId === undefined) {
    await renewBeforeMutation(fence, store, claimState, input.repository, input.pullRequest);
    const created = await github.createCheck(
      input.repository,
      input.headSha,
      checkPayload,
      mutationOptions(input.installationId, fence.signal),
    );
    await renewAfterMutation(fence, store, claimState, input.repository, input.pullRequest);
    checkId = created.id;
  } else {
    await renewBeforeMutation(fence, store, claimState, input.repository, input.pullRequest);
    await github.updateCheck(
      input.repository,
      checkId,
      checkPayload,
      mutationOptions(input.installationId, fence.signal),
    );
    await renewAfterMutation(fence, store, claimState, input.repository, input.pullRequest);
  }
  await saveIds();
  if (commentId === undefined && github.findManagedComment !== undefined)
    commentId = (
      await github.findManagedComment(
        input.repository,
        input.pullRequest,
        mutationOptions(input.installationId, fence.signal),
      )
    )?.id;
  if (commentId === undefined) {
    await renewBeforeMutation(fence, store, claimState, input.repository, input.pullRequest);
    const created = await github.createComment(
      input.repository,
      input.pullRequest,
      commentPayload,
      mutationOptions(input.installationId, fence.signal),
    );
    await renewAfterMutation(fence, store, claimState, input.repository, input.pullRequest);
    commentId = created.id;
  } else {
    await renewBeforeMutation(fence, store, claimState, input.repository, input.pullRequest);
    await github.updateComment(
      input.repository,
      commentId,
      commentPayload,
      mutationOptions(input.installationId, fence.signal),
    );
    await renewAfterMutation(fence, store, claimState, input.repository, input.pullRequest);
  }
  await saveIds();
  await renewAfterMutation(fence, store, claimState, input.repository, input.pullRequest);
  return { checkId, commentId };
}

async function claimPublicationSurface(
  input: { repository: string; pullRequest: number; headSha: string; appId?: number },
  store: ManagedStateStore,
): Promise<{ claim: PublicationClaim | undefined; claimed: boolean }> {
  if (store.claimPublication !== undefined) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const claim = await store.claimPublication(
        input.repository,
        input.pullRequest,
        input.headSha,
        input.appId,
      );
      if (claim !== undefined) return { claim, claimed: true };
      // Persisted surface IDs are only identities.  Webhook reconciliation
      // writes them while the surfaces are still queued, and a publication
      // owner may have crashed between either remote mutation and its final
      // fence check.  Never treat those IDs as proof that this generation
      // completed; wait for the PR-wide owner to release, then acquire and
      // perform/verify the current-generation publication.
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error('Managed GitHub surfaces are busy');
  }
  if (store.claimSurface === undefined) return { claim: undefined, claimed: true };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const claimed = await store.claimSurface(input.repository, input.pullRequest, input.headSha);
    if (claimed) return { claim: undefined, claimed: true };
    // The legacy surface lock has the same rule as the durable PR-wide lock:
    // IDs do not establish publication completion, so a contender must wait
    // and acquire the lock or fail retryably.
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error('Managed GitHub surfaces are busy');
}

async function releasePublicationSurface(
  input: { repository: string; pullRequest: number; headSha: string },
  store: ManagedStateStore,
  claim: PublicationClaim | undefined,
  claimed: boolean,
): Promise<void> {
  if (claimed && claim !== undefined && store.releasePublication !== undefined)
    await store.releasePublication(input.repository, input.pullRequest, claim);
  else if (claimed && store.releaseSurface !== undefined)
    await store.releaseSurface(input.repository, input.pullRequest, input.headSha);
}

export async function publishRunResult(
  input: PublishRunInput,
  store: ManagedStateStore,
  github: GitHubTransport,
  fence: PublicationFence,
): Promise<{ checkId: number; commentId: number }> {
  const publication = await claimPublicationSurface(
    { ...input, ...(github.appId === undefined ? {} : { appId: github.appId }) },
    store,
  );
  if (!publication.claimed) throw new Error('Managed GitHub surfaces are busy');
  const claimState: PublicationClaimState = { claim: publication.claim };
  try {
    return await publishRunResultUnlocked(input, store, github, fence, claimState);
  } finally {
    await releasePublicationSurface(input, store, claimState.claim, publication.claimed);
  }
}

function safeExternalError(error: string): string {
  const redacted = redactText(error, [])
    .replaceAll(/Authorization\s*:\s*Bearer\s+[^\s`]+/giu, 'Authorization: [credential omitted]')
    .replaceAll(
      /((?:token|secret|private[_ -]?key))\s*[:=]\s*[^\s`]+/giu,
      '$1: [credential omitted]',
    )
    .replaceAll(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/gu, '[credential omitted]')
    .replaceAll(MANAGED_COMMENT_START, '[managed marker omitted]')
    .replaceAll(MANAGED_COMMENT_END, '[managed marker omitted]');
  return boundLog(redacted, 2_000).text.replaceAll('```', '` ` `');
}

function infrastructurePayload(error: string): CheckRunPayload {
  const safeError = safeExternalError(error);
  return {
    name: 'PatchProof',
    status: 'completed',
    conclusion: 'neutral',
    output: {
      title: 'PatchProof: INFRA_ERROR',
      summary: 'The worker could not complete the evidence run. No fix claim is made.',
      text: `Worker error: ${safeError}`,
    },
  };
}

async function publishRunFailureUnlocked(
  input: {
    installationId?: number;
    repository: string;
    pullRequest: number;
    headSha: string;
    error: string;
  },
  store: ManagedStateStore,
  github: GitHubTransport,
  fence: PublicationFence,
  claimState: PublicationClaimState,
): Promise<{ checkId: number; commentId: number }> {
  const checkPayload = {
    ...infrastructurePayload(input.error),
    externalName: managedCheckExternalName(input.repository, input.pullRequest, input.headSha),
  };
  const safeError = safeExternalError(input.error);
  const commentPayload = {
    body: [
      MANAGED_COMMENT_START,
      '## PatchProof - INFRA_ERROR',
      '',
      'The worker could not complete this run. No fix claim is made.',
      '',
      'Worker error:',
      '```text',
      safeError,
      '```',
      '',
      MANAGED_COMMENT_END,
    ].join('\n'),
  };
  const state = await store.getRun(
    input.repository,
    input.pullRequest,
    input.headSha,
    github.appId,
  );
  let checkId = state?.checkId;
  let commentId = state?.commentId;
  const saveIds = async (): Promise<void> => {
    await store.putRun(
      input.repository,
      input.pullRequest,
      {
        ...(checkId === undefined ? {} : { checkId }),
        ...(commentId === undefined ? {} : { commentId }),
        ...(github.appId === undefined ? {} : { appId: github.appId }),
      },
      input.headSha,
    );
  };
  await assertPublicationOwned(fence);
  if (checkId === undefined && github.findManagedCheck !== undefined)
    checkId = (
      await github.findManagedCheck(
        input.repository,
        input.pullRequest,
        input.headSha,
        mutationOptions(input.installationId, fence.signal),
      )
    )?.id;
  if (checkId === undefined) {
    await renewBeforeMutation(fence, store, claimState, input.repository, input.pullRequest);
    const created = await github.createCheck(
      input.repository,
      input.headSha,
      checkPayload,
      mutationOptions(input.installationId, fence.signal),
    );
    await renewAfterMutation(fence, store, claimState, input.repository, input.pullRequest);
    checkId = created.id;
  } else {
    await renewBeforeMutation(fence, store, claimState, input.repository, input.pullRequest);
    await github.updateCheck(
      input.repository,
      checkId,
      checkPayload,
      mutationOptions(input.installationId, fence.signal),
    );
    await renewAfterMutation(fence, store, claimState, input.repository, input.pullRequest);
  }
  await saveIds();
  if (commentId === undefined && github.findManagedComment !== undefined)
    commentId = (
      await github.findManagedComment(
        input.repository,
        input.pullRequest,
        mutationOptions(input.installationId, fence.signal),
      )
    )?.id;
  if (commentId === undefined) {
    await renewBeforeMutation(fence, store, claimState, input.repository, input.pullRequest);
    const created = await github.createComment(
      input.repository,
      input.pullRequest,
      commentPayload,
      mutationOptions(input.installationId, fence.signal),
    );
    await renewAfterMutation(fence, store, claimState, input.repository, input.pullRequest);
    commentId = created.id;
  } else {
    await renewBeforeMutation(fence, store, claimState, input.repository, input.pullRequest);
    await github.updateComment(
      input.repository,
      commentId,
      commentPayload,
      mutationOptions(input.installationId, fence.signal),
    );
    await renewAfterMutation(fence, store, claimState, input.repository, input.pullRequest);
  }
  await saveIds();
  await renewAfterMutation(fence, store, claimState, input.repository, input.pullRequest);
  return { checkId, commentId };
}

export async function publishRunFailure(
  input: {
    installationId?: number;
    repository: string;
    pullRequest: number;
    headSha: string;
    error: string;
  },
  store: ManagedStateStore,
  github: GitHubTransport,
  fence: PublicationFence,
): Promise<{ checkId: number; commentId: number }> {
  const publication = await claimPublicationSurface(
    { ...input, ...(github.appId === undefined ? {} : { appId: github.appId }) },
    store,
  );
  if (!publication.claimed) throw new Error('Managed GitHub surfaces are busy');
  const claimState: PublicationClaimState = { claim: publication.claim };
  try {
    return await publishRunFailureUnlocked(input, store, github, fence, claimState);
  } finally {
    await releasePublicationSurface(input, store, claimState.claim, publication.claimed);
  }
}
