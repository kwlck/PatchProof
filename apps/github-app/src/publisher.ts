import { boundLog, redactText, type EvidenceBundle } from '@patchproof/core';
import {
  buildCheckRunPayload,
  buildManagedCommentPayload,
  MANAGED_COMMENT_END,
  MANAGED_COMMENT_START,
  type CheckRunPayload,
} from '@patchproof/github';
import type { GitHubTransport, ManagedStateStore } from '@patchproof/github';

export interface PublishRunInput {
  repository: string;
  pullRequest: number;
  headSha: string;
  bundle: EvidenceBundle;
}

export interface PublicationFence {
  readonly signal: AbortSignal;
  assertOwned(): Promise<void>;
}

/** Publishes a completed run through the two managed GitHub surfaces, using persisted IDs for idempotency. */
export async function publishRunResult(
  input: PublishRunInput,
  store: ManagedStateStore,
  github: GitHubTransport,
  fence: PublicationFence,
): Promise<{ checkId: number; commentId: number }> {
  const checkPayload = buildCheckRunPayload(input.bundle);
  const commentPayload = buildManagedCommentPayload(input.bundle);
  const state = await store.getRun(input.repository, input.pullRequest);
  let checkId = state?.checkId;
  let commentId = state?.commentId;
  const saveIds = async (): Promise<void> => {
    await store.putRun(input.repository, input.pullRequest, {
      ...(checkId === undefined ? {} : { checkId }),
      ...(commentId === undefined ? {} : { commentId }),
    });
  };
  await fence.assertOwned();
  if (checkId === undefined) {
    await fence.assertOwned();
    const created = await github.createCheck(input.repository, input.headSha, checkPayload, {
      signal: fence.signal,
    });
    await fence.assertOwned();
    checkId = created.id;
  } else {
    await fence.assertOwned();
    await github.updateCheck(input.repository, checkId, checkPayload, { signal: fence.signal });
    await fence.assertOwned();
  }
  await saveIds();
  if (commentId === undefined) {
    await fence.assertOwned();
    const created = await github.createComment(
      input.repository,
      input.pullRequest,
      commentPayload,
      {
        signal: fence.signal,
      },
    );
    await fence.assertOwned();
    commentId = created.id;
  } else {
    await fence.assertOwned();
    await github.updateComment(input.repository, commentId, commentPayload, {
      signal: fence.signal,
    });
    await fence.assertOwned();
  }
  await saveIds();
  return { checkId, commentId };
}

function safeExternalError(error: string): string {
  const redacted = redactText(error, [])
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

export async function publishRunFailure(
  input: { repository: string; pullRequest: number; headSha: string; error: string },
  store: ManagedStateStore,
  github: GitHubTransport,
  fence: PublicationFence,
): Promise<{ checkId: number; commentId: number }> {
  const checkPayload = infrastructurePayload(input.error);
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
  const state = await store.getRun(input.repository, input.pullRequest);
  let checkId = state?.checkId;
  let commentId = state?.commentId;
  const saveIds = async (): Promise<void> => {
    await store.putRun(input.repository, input.pullRequest, {
      ...(checkId === undefined ? {} : { checkId }),
      ...(commentId === undefined ? {} : { commentId }),
    });
  };
  await fence.assertOwned();
  if (checkId === undefined) {
    await fence.assertOwned();
    const created = await github.createCheck(input.repository, input.headSha, checkPayload, {
      signal: fence.signal,
    });
    await fence.assertOwned();
    checkId = created.id;
  } else {
    await fence.assertOwned();
    await github.updateCheck(input.repository, checkId, checkPayload, { signal: fence.signal });
    await fence.assertOwned();
  }
  await saveIds();
  if (commentId === undefined) {
    await fence.assertOwned();
    const created = await github.createComment(
      input.repository,
      input.pullRequest,
      commentPayload,
      {
        signal: fence.signal,
      },
    );
    await fence.assertOwned();
    commentId = created.id;
  } else {
    await fence.assertOwned();
    await github.updateComment(input.repository, commentId, commentPayload, {
      signal: fence.signal,
    });
    await fence.assertOwned();
  }
  await saveIds();
  return { checkId, commentId };
}
