import type { EvidenceBundle, RunOutcome } from '@patchproof/core';
import { renderMarkdownReport } from '@patchproof/report';

export const MANAGED_COMMENT_START = '<!-- patchproof:summary:start -->';
export const MANAGED_COMMENT_END = '<!-- patchproof:summary:end -->';

export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'action_required' | 'timed_out';

export interface CheckRunPayload {
  name: 'PatchProof';
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: CheckConclusion;
  output: {
    title: string;
    summary: string;
    text: string;
  };
}

export interface PullRequestCommentPayload {
  body: string;
}

function singleLine(value: string): string {
  return [...value]
    .filter((character) => (character.codePointAt(0) ?? 0) >= 32)
    .join('')
    .replaceAll(/[\r\n]+/gu, ' ');
}

function conclusion(outcome: RunOutcome): CheckConclusion {
  if (outcome === 'PASS') return 'success';
  if (outcome === 'FAIL') return 'failure';
  if (outcome === 'INFRA_ERROR') return 'neutral';
  if (outcome === 'POLICY_DENIED') return 'action_required';
  return 'neutral';
}

export function buildCheckRunPayload(bundle: EvidenceBundle): CheckRunPayload {
  return {
    name: 'PatchProof',
    status: 'completed',
    conclusion: conclusion(bundle.outcome),
    output: {
      title: `PatchProof: ${bundle.outcome}`,
      summary: bundle.verdict,
      text: [
        `Scenario: ${singleLine(bundle.scenario.id)}`,
        `Base: ${bundle.executions.base.exitCode ?? 'null'} (${bundle.executions.base.durationMs} ms)`,
        `Head: ${bundle.executions.head.exitCode ?? 'null'} (${bundle.executions.head.durationMs} ms)`,
        `Integrity: ${bundle.integrity.canonicalSha256}`,
        'Hash integrity is not signer identity or remote attestation.',
      ].join('\n'),
    },
  };
}

export function buildQueuedCheckPayload(scenarioId = 'configured scenario'): CheckRunPayload {
  return {
    name: 'PatchProof',
    status: 'queued',
    output: {
      title: 'PatchProof: queued',
      summary: `PatchProof will evaluate ${scenarioId} in the isolated runner.`,
      text: 'The webhook process only queued this run; it does not execute pull-request code.',
    },
  };
}

export function buildManagedCommentPayload(bundle: EvidenceBundle): PullRequestCommentPayload {
  return { body: renderMarkdownReport(bundle) };
}

export function isManagedComment(body: string): boolean {
  return body.includes(MANAGED_COMMENT_START) && body.includes(MANAGED_COMMENT_END);
}
