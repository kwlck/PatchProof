import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCheckRunPayload,
  buildManagedCommentPayload,
  computeWebhookSignature,
  isManagedComment,
  parseIssueCommentCommand,
  verifyWebhookSignature,
} from '@patchproof/github';
import { renderMarkdownReport } from '@patchproof/report';
import { createIntegrity, type EvidenceBundle } from '@patchproof/core';

function bundle(): EvidenceBundle {
  const execution = (revision: 'base' | 'head') => ({
    revision,
    command: ['node'],
    cwd: '.',
    environment: {},
    launcherEnvironment: { omitted: true as const, keys: [], sha256: '0'.repeat(64) },
    toolchain: {
      node: 'v24',
      platform: 'win32',
      arch: 'x64',
      runner: 'test',
      dependencyLock: { status: 'not-detected' },
    },
    exitCode: revision === 'base' ? 1 : 0,
    timedOut: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 2,
    stdout: { artifactId: `${revision}-out`, preview: 'safe', truncated: false, sizeBytes: 4 },
    stderr: { artifactId: `${revision}-err`, preview: '', truncated: false, sizeBytes: 0 },
  });
  const unsigned: Omit<EvidenceBundle, 'integrity'> = {
    schemaVersion: 1,
    product: { name: 'PatchProof', version: '0.1.0' },
    bundleId: 'github-test',
    createdAt: '2026-01-01T00:00:00.000Z',
    outcome: 'PASS',
    verdict: 'safe',
    scenario: {
      id: 'id',
      name: 'name',
      command: ['node'],
      cwd: '.',
      trustedSource: 'base',
      expectedFailure: { exitCode: 1 },
      sha256: 's',
    },
    sources: {
      base: { revision: 'base', ref: 'base', sha256: 'b', kind: 'directory-tree', location: 'b' },
      head: { revision: 'head', ref: 'head', sha256: 'h', kind: 'directory-tree', location: 'h' },
    },
    policy: {
      backend: 'docker',
      network: 'none',
      allowedHosts: [],
      unsafeLocalProcess: false,
      fork: false,
      trustedConfigRevision: 'base',
      limits: { timeoutMs: 1, outputBytes: 1, memoryMb: 1, cpuCount: 1, pids: 1 },
    },
    executions: { base: execution('base'), head: execution('head') },
    artifacts: [],
    completeness: { complete: true, checks: { all: true }, missing: [] },
    replay: {
      supported: true,
      baseLocation: 'b',
      headLocation: 'h',
      requiresExplicitConfirmation: true,
      recordedEnvironment: { node: 'v24', platform: 'win32', arch: 'x64' },
    },
  };
  return { ...unsigned, integrity: createIntegrity(unsigned) };
}

test('webhook signatures are HMAC checked and comments/checks are stable', () => {
  const body = '{"ok":true}';
  const signature = computeWebhookSignature(body, 'test-webhook-secret');
  assert.equal(verifyWebhookSignature(body, signature, 'test-webhook-secret'), true);
  assert.equal(verifyWebhookSignature(body, `${signature}0`, 'test-webhook-secret'), false);
  const report = renderMarkdownReport(bundle());
  assert.equal(isManagedComment(report), true);
  assert.equal(buildCheckRunPayload(bundle()).conclusion, 'success');
  assert.equal(buildManagedCommentPayload(bundle()).body, report);
});

test('slash commands are constrained to a single supported command', () => {
  assert.deepEqual(parseIssueCommentCommand('/patchproof run'), { command: 'run' });
  assert.deepEqual(parseIssueCommentCommand('/patchproof verify bundle.json'), {
    command: 'verify',
    argument: 'bundle.json',
  });
  assert.equal(parseIssueCommentCommand('/patchproof rm -rf /'), undefined);
});
