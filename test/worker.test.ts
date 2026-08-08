import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEvidenceBundle } from '@patchproof/core';
import { computeWebhookSignature, MemoryStateStore } from '@patchproof/github';
import { runTwoRevisions } from '@patchproof/runner';
import { handleWebhook } from '../apps/github-app/dist/webhook.js';
import { SqliteQueue } from '../apps/github-app/dist/queue.js';
import { PatchProofWorker, type WorkerRunInput } from '../apps/github-app/dist/worker.js';
import type { SourceAdapter } from '../apps/github-app/dist/source.js';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

class FixtureSourceAdapter implements SourceAdapter {
  public constructor(
    private readonly configPath = 'fixtures/pass/.patchproof.yml',
    private readonly headRepository = 'octo/example',
  ) {}

  public async materializeRevision(
    repository: string,
    sha: string,
    destination: string,
  ): Promise<void> {
    assert.equal(repository, sha === baseSha ? 'octo/example' : this.headRepository);
    const source = sha === baseSha ? 'fixtures/pass/base' : 'fixtures/pass/head';
    await cp(source, destination, { recursive: true, dereference: false });
    await cp(this.configPath, join(destination, '.patchproof.yml'));
  }
}

test('real issue_comment shape reaches durable queue, worker, evidence, Check, and managed comment', async () => {
  const queue = new SqliteQueue(':memory:');
  const store = new MemoryStateStore();
  const calls: string[] = [];
  const github = {
    async getPullRequest(repository: string, pullRequest: number) {
      assert.equal(repository, 'octo/example');
      assert.equal(pullRequest, 7);
      return {
        number: 7,
        baseSha,
        headSha,
        headRepository: 'contrib/example',
        fork: true,
        state: 'open' as const,
      };
    },
    async createCheck() {
      calls.push('create-check');
      return { id: 101 };
    },
    async updateCheck(repository: string, checkId: number) {
      calls.push(`update-check:${repository}:${checkId}`);
    },
    async createComment() {
      calls.push('create-comment');
      return { id: 202, body: 'managed' };
    },
    async updateComment(repository: string, commentId: number) {
      calls.push(`update-comment:${repository}:${commentId}`);
    },
  };
  const payload = JSON.stringify({
    action: 'created',
    repository: { full_name: 'octo/example' },
    issue: {
      number: 7,
      pull_request: { url: 'https://api.github.com/repos/octo/example/pulls/7' },
    },
    comment: { body: '/patchproof run', author_association: 'OWNER' },
  });
  const response = await handleWebhook(
    {
      rawBody: payload,
      signature: computeWebhookSignature(payload, 'worker-test-secret'),
      deliveryId: 'worker-delivery-1',
      event: 'issue_comment',
    },
    {
      webhookSecret: 'worker-test-secret',
      store,
      github,
      enqueue: async (request) => {
        await queue.enqueue(request);
      },
    },
  );
  assert.equal(response.status, 202);
  assert.equal(response.enqueued, true);
  assert.deepEqual(calls, ['create-check', 'create-comment']);
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-it-'));
  try {
    const worker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter('fixtures/pass-fork/.patchproof.yml', 'contrib/example'),
      store,
      github,
      outputRoot,
      workerId: 'worker-test',
      backendOverride: 'local',
      allowUnsafeLocal: true,
    });
    const results = await worker.runUntilIdle();
    assert.equal(
      results.some((result) => result.status === 'completed'),
      true,
    );
    const jobs = await queue.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, 'succeeded');
    assert.equal(jobs[0]?.headRepository, 'contrib/example');
    const evidencePath = jobs[0]?.evidencePath;
    assert.equal(typeof evidencePath, 'string');
    const verified = await verifyEvidenceBundle(evidencePath as string);
    assert.equal(verified.valid, true, verified.errors.join('; '));
    const evidence = JSON.parse(await readFile(evidencePath as string, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(evidence.outcome, 'PASS');
    assert.deepEqual(calls, [
      'create-check',
      'create-comment',
      'update-check:octo/example:101',
      'update-comment:octo/example:202',
    ]);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    queue.close();
  }
});

test('worker accepts an injected scenario executor for offline command-path tests', async () => {
  const queue = new SqliteQueue(':memory:');
  const job = await queue.enqueue({
    repository: 'octo/example',
    pullRequest: 7,
    baseSha,
    headSha,
    reason: 'pull_request',
  });
  const store = new MemoryStateStore();
  const github = {
    async getPullRequest() {
      return {
        number: 7,
        baseSha,
        headSha,
        headRepository: 'octo/example',
        fork: false,
        state: 'open' as const,
      };
    },
    async createCheck() {
      return { id: 1 };
    },
    async updateCheck() {},
    async createComment() {
      return { id: 2, body: 'managed' };
    },
    async updateComment() {},
  };
  let injected = false;
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-injected-'));
  try {
    const worker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store,
      github,
      outputRoot,
      workerId: 'worker-injected',
      backendOverride: 'local',
      allowUnsafeLocal: true,
      executeScenario: async (input: WorkerRunInput) => {
        injected = true;
        assert.equal(input.configResult.sourceRevision, 'base');
        assert.match(input.configResult.sourcePath, /\.patchproof\.yml$/u);
        return runTwoRevisions({
          config: input.configResult.config,
          basePath: input.basePath,
          headPath: input.headPath,
          backendOverride: 'local',
          allowUnsafeLocal: true,
          trustedConfig: true,
        });
      },
    });
    const result = await worker.runOnce();
    assert.equal(result.status, 'completed', result.error);
    assert.equal(injected, true);
    assert.equal((await queue.list())[0]?.status, 'succeeded');
    void job;
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    queue.close();
  }
});

test('worker retries transient source failures and publishes terminal INFRA_ERROR', async () => {
  const queue = new SqliteQueue(':memory:');
  await queue.enqueue({
    repository: 'octo/example',
    pullRequest: 7,
    baseSha,
    headSha,
    reason: 'pull_request',
  });
  const calls: string[] = [];
  const github = {
    async getPullRequest() {
      return {
        number: 7,
        baseSha,
        headSha,
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
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-failure-'));
  try {
    const worker = new PatchProofWorker({
      queue,
      source: {
        async materializeRevision() {
          throw new Error('temporary network failure');
        },
      },
      store: new MemoryStateStore(),
      github,
      outputRoot,
      workerId: 'worker-failure',
    });
    const results = await worker.runUntilIdle();
    assert.deepEqual(
      results.map((result) => result.status),
      ['retried', 'retried', 'failed', 'idle'],
    );
    assert.deepEqual(calls, ['create-check', 'create-comment']);
    assert.equal((await queue.list())[0]?.status, 'failed');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    queue.close();
  }
});

test('SQLite queue persists fork source identity, supersedes work, and reaps stale leases', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const queue = new SqliteQueue(':memory:', () => new Date(now));
  const first = await queue.enqueue({
    repository: 'octo/example',
    pullRequest: 7,
    baseSha,
    headSha,
    reason: 'pull_request',
  });
  const firstClaim = await queue.claim('worker-a', 1_000);
  assert.equal(firstClaim?.id, first.id);
  assert.equal(await queue.heartbeat(first.id, 'worker-b', 1_000), false);

  const second = await queue.enqueue({
    repository: 'octo/example',
    pullRequest: 7,
    baseSha,
    headSha: 'c'.repeat(40),
    headRepository: 'contrib/example',
    fork: true,
    reason: 'issue_comment',
  });
  const superseded = await queue.list();
  assert.equal(superseded.find((job) => job.id === first.id)?.status, 'cancelled');
  assert.equal(superseded.find((job) => job.id === second.id)?.headRepository, 'contrib/example');

  const secondClaim = await queue.claim('worker-b', 1_000);
  assert.equal(secondClaim?.id, second.id);
  now = new Date(now.getTime() + 2_000);
  const reaped = await queue.claim('worker-c', 1_000);
  assert.equal(reaped?.id, second.id);
  assert.equal(reaped?.attempts, 2);
  assert.equal(await queue.cancel(second.id, 'operator cancelled'), true);
  assert.equal(await queue.heartbeat(second.id, 'worker-c', 1_000), false);

  const terminal = await queue.enqueue(
    {
      repository: 'octo/example',
      pullRequest: 8,
      baseSha,
      headSha: 'd'.repeat(40),
      reason: 'pull_request',
    },
    1,
  );
  assert.equal((await queue.claim('worker-d', 1_000))?.id, terminal.id);
  now = new Date(now.getTime() + 2_000);
  const terminalNotification = await queue.claim('worker-e', 1_000);
  assert.equal(terminalNotification?.id, terminal.id);
  assert.equal(terminalNotification?.status, 'failed');
  assert.equal(await queue.acknowledgeFailure(terminal.id), true);
  assert.equal(await queue.claim('worker-f', 1_000), undefined);
  assert.equal((await queue.list()).find((job) => job.id === terminal.id)?.status, 'failed');
  queue.close();
});
