import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhook } from '../apps/github-app/dist/webhook.js';
import { GitHubApiTransport } from '../apps/github-app/dist/github-api.js';
import { SqliteStateStore } from '../apps/github-app/dist/sqlite.js';
import { publishRunResult } from '../apps/github-app/dist/publisher.js';
import { computeWebhookSignature, MemoryStateStore } from '@patchproof/github';
import { createIntegrity, type EvidenceBundle } from '@patchproof/core';

const payload = JSON.stringify({
  action: 'opened',
  number: 7,
  repository: { full_name: 'octo/example' },
  pull_request: {
    base: { sha: 'a'.repeat(40) },
    head: { sha: 'b'.repeat(40), repo: { full_name: 'octo/example' } },
  },
});

test('webhook verifies, queues, persists minimal state, and ignores duplicate deliveries', async () => {
  const deliveries: string[] = [];
  const checks: string[] = [];
  const store = new MemoryStateStore();
  const response = await handleWebhook(
    {
      rawBody: payload,
      signature: computeWebhookSignature(payload, '0123456789012345'),
      deliveryId: 'delivery-1',
      event: 'pull_request',
    },
    {
      webhookSecret: '0123456789012345',
      store,
      github: {
        async getPullRequest() {
          return {
            number: 7,
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            headRepository: 'octo/example',
            fork: false,
            state: 'open' as const,
          };
        },
        async createCheck() {
          checks.push('check');
          return { id: 1 };
        },
        async updateCheck() {},
        async createComment() {
          checks.push('comment');
          return { id: 2, body: 'managed' };
        },
        async updateComment() {},
      },
      enqueue: async (request) => {
        deliveries.push(request.headSha);
      },
    },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(deliveries, ['b'.repeat(40)]);
  assert.deepEqual(checks, ['check', 'comment']);
  const duplicate = await handleWebhook(
    {
      rawBody: payload,
      signature: computeWebhookSignature(payload, '0123456789012345'),
      deliveryId: 'delivery-1',
      event: 'pull_request',
    },
    {
      webhookSecret: '0123456789012345',
      store,
      github: {
        async getPullRequest() {
          return {
            number: 7,
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            headRepository: 'octo/example',
            fork: false,
            state: 'open' as const,
          };
        },
        async createCheck() {
          return { id: 3 };
        },
        async updateCheck() {},
        async createComment() {
          return { id: 4, body: 'unexpected' };
        },
        async updateComment() {},
      },
      enqueue: async () => {
        throw new Error('duplicate executed');
      },
    },
  );
  assert.equal(duplicate.enqueued, false);
});

test('SQLite state store works without a GitHub credential', async () => {
  const store = new SqliteStateStore(':memory:');
  await store.markDelivery('d');
  assert.equal(await store.getDelivery('d'), true);
  await store.putRun('o/r', 1, { checkId: 5, commentId: 6 });
  assert.deepEqual(await store.getRun('o/r', 1), { checkId: 5, commentId: 6 });
  store.close();
});

test('issue_comment fetches refs from GitHub after authorization and handles API retry cases', async () => {
  const store = new MemoryStateStore();
  const baseSha = 'c'.repeat(40);
  const headSha = 'd'.repeat(40);
  const queued: Array<{ baseSha: string; headSha: string; headRepository: string }> = [];
  const modes: Array<'ok' | 'error' | 'closed'> = ['ok'];
  let getCalls = 0;
  const github = {
    async getPullRequest() {
      getCalls += 1;
      const mode = modes[0];
      if (mode === 'error') throw new Error('API unavailable');
      return {
        number: 7,
        baseSha,
        headSha,
        headRepository: 'contrib/example',
        fork: true,
        state: mode === 'closed' ? ('closed' as const) : ('open' as const),
      };
    },
    async createCheck() {
      return { id: 10 };
    },
    async updateCheck() {},
    async createComment() {
      return { id: 11, body: 'managed' };
    },
    async updateComment() {},
  };
  const makeRequest = (deliveryId: string, body: string, association = 'OWNER') => {
    const rawBody = JSON.stringify({
      action: 'created',
      repository: { full_name: 'octo/example' },
      issue: {
        number: 7,
        pull_request: { url: 'https://api.github.com/repos/octo/example/pulls/7' },
      },
      comment: { body, author_association: association },
    });
    return {
      rawBody,
      signature: computeWebhookSignature(rawBody, 'issue-comment-secret'),
      deliveryId,
      event: 'issue_comment',
    };
  };
  const dependencies = {
    webhookSecret: 'issue-comment-secret',
    store,
    github,
    enqueue: async (request: { baseSha: string; headSha: string; headRepository: string }) => {
      queued.push({
        baseSha: request.baseSha,
        headSha: request.headSha,
        headRepository: request.headRepository,
      });
    },
  };
  const first = await handleWebhook(makeRequest('comment-1', '/patchproof run'), dependencies);
  assert.equal(first.status, 202);
  assert.deepEqual(queued, [{ baseSha, headSha, headRepository: 'contrib/example' }]);
  modes[0] = 'error';
  const failed = await handleWebhook(makeRequest('comment-2', '/patchproof run'), dependencies);
  assert.equal(failed.status, 502);
  assert.equal(failed.enqueued, false);
  modes[0] = 'ok';
  const retried = await handleWebhook(makeRequest('comment-2', '/patchproof run'), dependencies);
  assert.equal(retried.status, 202);
  assert.equal(queued.length, 2);
  const nonPr = JSON.stringify({
    action: 'created',
    repository: { full_name: 'octo/example' },
    issue: { number: 8 },
    comment: { body: '/patchproof run', author_association: 'OWNER' },
  });
  const nonPrResult = await handleWebhook(
    {
      rawBody: nonPr,
      signature: computeWebhookSignature(nonPr, 'issue-comment-secret'),
      deliveryId: 'comment-3',
      event: 'issue_comment',
    },
    dependencies,
  );
  assert.equal(nonPrResult.enqueued, false);
  const unauthorized = await handleWebhook(
    makeRequest('comment-4', '/patchproof run', 'NONE'),
    dependencies,
  );
  assert.equal(unauthorized.enqueued, false);
  const unsupportedArgument = await handleWebhook(
    makeRequest('comment-unsupported', '/patchproof run unexpected'),
    dependencies,
  );
  assert.equal(unsupportedArgument.enqueued, false);
  modes[0] = 'closed';
  const closed = await handleWebhook(makeRequest('comment-5', '/patchproof run'), dependencies);
  assert.equal(closed.enqueued, false);
  assert.equal(getCalls, 4);
  const duplicate = await handleWebhook(makeRequest('comment-1', '/patchproof run'), dependencies);
  assert.equal(duplicate.body, 'duplicate delivery ignored');
  assert.equal(queued.length, 2);
});

test('GitHub transport fetches and validates pull request refs through the least-privilege GET path', async () => {
  let invalid = false;
  let headRepository: string | null = 'octo/example';
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/repos/octo/example/pulls/7');
    assert.equal(request.headers.authorization, 'Bearer test-token');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        number: 7,
        state: 'open',
        base: { sha: invalid ? 'short' : 'a'.repeat(40) },
        head: {
          sha: invalid ? 'short' : 'b'.repeat(40),
          repo: headRepository === null ? null : { full_name: headRepository },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const transport = new GitHubApiTransport('test-token', `http://127.0.0.1:${address.port}`);
  try {
    assert.deepEqual(await transport.getPullRequest('octo/example', 7), {
      number: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      headRepository: 'octo/example',
      fork: false,
      state: 'open',
    });
    headRepository = 'contrib/example';
    assert.deepEqual(await transport.getPullRequest('octo/example', 7), {
      number: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      headRepository: 'contrib/example',
      fork: true,
      state: 'open',
    });
    invalid = true;
    await assert.rejects(
      () => transport.getPullRequest('octo/example', 7),
      /invalid pull request refs/u,
    );
    invalid = false;
    headRepository = null;
    await assert.rejects(
      () => transport.getPullRequest('octo/example', 7),
      /invalid pull request refs/u,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('completed runs update the same Check and managed comment IDs', async () => {
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
    durationMs: 1,
    stdout: { artifactId: `${revision}-out`, preview: '', truncated: false, sizeBytes: 0 },
    stderr: { artifactId: `${revision}-err`, preview: '', truncated: false, sizeBytes: 0 },
  });
  const unsigned: Omit<EvidenceBundle, 'integrity'> = {
    schemaVersion: 1,
    product: { name: 'PatchProof', version: '0.1.0' },
    bundleId: 'publisher-test',
    createdAt: '2026-01-01T00:00:00.000Z',
    outcome: 'PASS',
    verdict: 'fixed',
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
      base: { revision: 'base', ref: 'b', sha256: 'b', kind: 'directory-tree', location: 'b' },
      head: { revision: 'head', ref: 'h', sha256: 'h', kind: 'directory-tree', location: 'h' },
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
  const bundle = { ...unsigned, integrity: createIntegrity(unsigned) };
  const store = new MemoryStateStore();
  const calls: string[] = [];
  const github = {
    async getPullRequest() {
      return {
        number: 1,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        headRepository: 'octo/example',
        fork: false,
        state: 'open' as const,
      };
    },
    async createCheck() {
      calls.push('create-check');
      return { id: 1 };
    },
    async updateCheck() {
      calls.push('update-check');
    },
    async createComment() {
      calls.push('create-comment');
      return { id: 2, body: 'managed' };
    },
    async updateComment() {
      calls.push('update-comment');
    },
  };
  await publishRunResult(
    { repository: 'o/r', pullRequest: 1, headSha: 'h', bundle },
    store,
    github,
  );
  await publishRunResult(
    { repository: 'o/r', pullRequest: 1, headSha: 'h', bundle },
    store,
    github,
  );
  assert.deepEqual(calls, ['create-check', 'create-comment', 'update-check', 'update-comment']);

  const partialStore = new MemoryStateStore();
  const partialCalls: string[] = [];
  let failComment = true;
  const partialGithub = {
    ...github,
    async createCheck() {
      partialCalls.push('create-check');
      return { id: 11 };
    },
    async updateCheck() {
      partialCalls.push('update-check');
    },
    async createComment() {
      partialCalls.push('create-comment');
      if (failComment) {
        failComment = false;
        throw new Error('temporary comment failure');
      }
      return { id: 22, body: 'managed' };
    },
  };
  await assert.rejects(
    () =>
      publishRunResult(
        { repository: 'o/r', pullRequest: 2, headSha: 'h', bundle },
        partialStore,
        partialGithub,
      ),
    /temporary comment failure/u,
  );
  await publishRunResult(
    { repository: 'o/r', pullRequest: 2, headSha: 'h', bundle },
    partialStore,
    partialGithub,
  );
  assert.deepEqual(partialCalls, [
    'create-check',
    'create-comment',
    'update-check',
    'create-comment',
  ]);
});
