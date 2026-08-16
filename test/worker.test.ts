import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function attemptRootFromEvidence(evidencePath: string): string {
  return join(evidencePath, '..', '..');
}

async function attemptRoots(outputRoot: string, jobId: string): Promise<string[]> {
  const names = await readdir(join(outputRoot, jobId, 'attempts'));
  return names
    .filter((name) => /^\d+-[0-9a-f-]{36}$/iu.test(name))
    .map((name) => join(outputRoot, jobId, 'attempts', name));
}

class Deferred {
  public readonly promise: Promise<void>;
  private resolvePromise!: () => void;

  public constructor() {
    this.promise = new Promise<void>((resolvePromise) => {
      this.resolvePromise = resolvePromise;
    });
  }

  public resolve(): void {
    this.resolvePromise();
  }
}

function publicationGithub(calls: string[], failCreateCheck = false) {
  return {
    async createCheck() {
      calls.push('create-check');
      if (failCreateCheck) throw new Error('temporary GitHub failure');
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
}

async function enqueueWorkerJob(queue: SqliteQueue, maxAttempts?: number) {
  return queue.enqueue(
    {
      repository: 'octo/example',
      pullRequest: 7,
      baseSha,
      headSha,
      reason: 'pull_request',
    },
    maxAttempts,
  );
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
    const attemptRoot = attemptRootFromEvidence(evidencePath as string);
    assert.equal(await pathExists(join(attemptRoot, 'sources')), false);
    assert.equal(await pathExists(join(attemptRoot, 'evidence', 'artifacts')), true);
    const verified = await verifyEvidenceBundle(evidencePath as string);
    assert.equal(verified.valid, true, verified.errors.join('; '));
    const evidence = JSON.parse(await readFile(evidencePath as string, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(evidence.outcome, 'PASS');
    const sources = evidence.sources as {
      base: { revision: string; location: string };
      head: { revision: string; location: string };
    };
    assert.deepEqual(
      {
        base: { revision: sources.base.revision, location: sources.base.location },
        head: { revision: sources.head.revision, location: sources.head.location },
      },
      {
        base: { revision: 'base', location: 'base' },
        head: { revision: 'head', location: 'head' },
      },
    );
    assert.equal(JSON.stringify(evidence).includes(outputRoot), false);
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

test('publication failure retries with verified evidence and no generated sources', async () => {
  const queue = new SqliteQueue(':memory:');
  const job = await enqueueWorkerJob(queue);
  const calls: string[] = [];
  let failPublication = true;
  const github = {
    async createCheck() {
      calls.push('create-check');
      if (failPublication) throw new Error('temporary GitHub failure');
      return { id: 11 };
    },
    async updateCheck() {
      calls.push('update-check');
    },
    async createComment() {
      calls.push('create-comment');
      return { id: 12, body: 'managed' };
    },
    async updateComment() {
      calls.push('update-comment');
    },
  };
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-publication-'));
  try {
    const worker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store: new MemoryStateStore(),
      github,
      outputRoot,
      workerId: 'worker-publication',
      backendOverride: 'local',
      allowUnsafeLocal: true,
    });
    const retried = await worker.runOnce();
    assert.equal(retried.status, 'retried');
    assert.equal(retried.error, 'temporary GitHub failure');
    assert.equal(typeof retried.bundlePath, 'string');
    assert.equal(
      await pathExists(join(attemptRootFromEvidence(retried.bundlePath as string), 'sources')),
      false,
    );
    assert.equal((await verifyEvidenceBundle(retried.bundlePath as string)).valid, true);
    failPublication = false;
    const completed = await worker.runOnce();
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(
      await pathExists(join(attemptRootFromEvidence(completed.bundlePath as string), 'sources')),
      false,
    );
    assert.deepEqual(calls, ['create-check', 'create-check', 'create-comment']);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    queue.close();
  }
});

test('partial materialization removes sources and retains the primary error', async () => {
  const queue = new SqliteQueue(':memory:');
  const job = await enqueueWorkerJob(queue);
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-partial-'));
  try {
    const worker = new PatchProofWorker({
      queue,
      source: {
        async materializeRevision(repository, sha, destination) {
          const source = sha === baseSha ? 'fixtures/pass/base' : 'fixtures/pass/head';
          await cp(source, destination, { recursive: true, dereference: false });
          if (sha === baseSha)
            await cp('fixtures/pass/.patchproof.yml', join(destination, '.patchproof.yml'));
          if (repository === 'octo/example' && sha === headSha)
            throw new Error('head materialization failed');
        },
      },
      store: new MemoryStateStore(),
      github: publicationGithub([]),
      outputRoot,
      workerId: 'worker-partial',
      backendOverride: 'local',
      allowUnsafeLocal: true,
    });
    const result = await worker.runOnce();
    assert.equal(result.status, 'retried');
    assert.equal(result.error, 'head materialization failed');
    assert.equal((await queue.list())[0]?.lastError, 'head materialization failed');
    const attempts = await attemptRoots(outputRoot, job.id);
    assert.equal(attempts.length, 1);
    assert.equal(await pathExists(join(attempts[0] as string, 'sources')), false);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    queue.close();
  }
});

test('cleanup-only failure is generic and retryable, then stale sources are pre-cleaned', async () => {
  const queue = new SqliteQueue(':memory:');
  const job = await enqueueWorkerJob(queue);
  const calls: string[] = [];
  let failCleanup = true;
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-cleanup-retry-'));
  try {
    const worker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store: new MemoryStateStore(),
      github: publicationGithub(calls),
      outputRoot,
      workerId: 'worker-cleanup-retry',
      backendOverride: 'local',
      allowUnsafeLocal: true,
      removeSources: async (sourcesPath) => {
        if (failCleanup) {
          failCleanup = false;
          throw new Error(`cleanup failed at ${sourcesPath}`);
        }
        await rm(sourcesPath, { recursive: true, force: true });
      },
    });
    const retried = await worker.runOnce();
    assert.equal(retried.status, 'retried');
    assert.equal(retried.error, 'Generated source cleanup failed');
    assert.equal(typeof retried.bundlePath, 'string');
    const failedAttempt = attemptRootFromEvidence(retried.bundlePath as string);
    assert.equal(await pathExists(join(failedAttempt, 'sources')), false);
    assert.equal(
      (await readdir(failedAttempt)).some((entry) => entry.startsWith('.sources-trash-')),
      true,
    );
    assert.equal((await verifyEvidenceBundle(retried.bundlePath as string)).valid, true);
    assert.deepEqual(calls, []);
    const completed = await worker.runOnce();
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(
      await pathExists(join(attemptRootFromEvidence(completed.bundlePath as string), 'sources')),
      false,
    );
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    queue.close();
  }
});

test('primary and cleanup failures preserve the primary queue error', async () => {
  const queue = new SqliteQueue(':memory:');
  const job = await enqueueWorkerJob(queue);
  const calls: string[] = [];
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-primary-cleanup-'));
  try {
    const worker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store: new MemoryStateStore(),
      github: publicationGithub(calls),
      outputRoot,
      workerId: 'worker-primary-cleanup',
      backendOverride: 'local',
      allowUnsafeLocal: true,
      executeScenario: async (input) => {
        const mixedWorkerPath = input.basePath.replaceAll('\\', '/').toUpperCase();
        throw new Error(`primary executor failure at ${mixedWorkerPath}`);
      },
      removeSources: async (sourcesPath) => {
        throw new Error(`cleanup failed at ${sourcesPath}`);
      },
    });
    const result = await worker.runOnce();
    assert.equal(result.status, 'retried');
    assert.equal(result.error, 'primary executor failure at [worker path omitted]');
    assert.equal(
      (await queue.list())[0]?.lastError,
      'primary executor failure at [worker path omitted]',
    );
    assert.equal(result.error?.includes(outputRoot), false);
    assert.deepEqual(calls, []);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    queue.close();
  }
});

test('explicit heartbeat loss cancels without publication and keeps evidence', async () => {
  const queue = new SqliteQueue(':memory:');
  const job = await enqueueWorkerJob(queue);
  const calls: string[] = [];
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-heartbeat-'));
  try {
    const worker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store: new MemoryStateStore(),
      github: publicationGithub(calls),
      outputRoot,
      workerId: 'worker-heartbeat',
      backendOverride: 'local',
      allowUnsafeLocal: true,
      executeScenario: async (input) => {
        assert.equal(await queue.cancel(input.job.id, 'superseded'), true);
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
    assert.equal(result.status, 'cancelled');
    assert.equal(result.error, 'Queue job was cancelled or superseded before publication');
    assert.equal(typeof result.bundlePath, 'string');
    assert.equal(await pathExists(join(outputRoot, job.id, 'sources')), false);
    assert.equal((await verifyEvidenceBundle(result.bundlePath as string)).valid, true);
    assert.deepEqual(calls, []);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    queue.close();
  }
});

test('terminal failure reclaims stale sources before acknowledgment', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const queue = new SqliteQueue(':memory:', () => new Date(now));
  const job = await enqueueWorkerJob(queue, 1);
  const calls: string[] = [];
  let failPublication = true;
  const github = {
    async createCheck() {
      calls.push('create-check');
      if (failPublication) throw new Error('GitHub unavailable');
      return { id: 21 };
    },
    async updateCheck() {
      calls.push('update-check');
    },
    async createComment() {
      calls.push('create-comment');
      return { id: 22, body: 'managed' };
    },
    async updateComment() {
      calls.push('update-comment');
    },
  };
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-terminal-cleanup-'));
  try {
    const firstWorker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store: new MemoryStateStore(),
      github,
      outputRoot,
      workerId: 'worker-terminal-first',
      leaseMs: 1_000,
      backendOverride: 'local',
      allowUnsafeLocal: true,
      executeScenario: async () => {
        throw new Error('terminal primary failure');
      },
    });
    const first = await firstWorker.runOnce();
    assert.equal(first.status, 'failed');
    const firstAttempt = (await attemptRoots(outputRoot, job.id))[0];
    assert.equal(typeof firstAttempt, 'string');
    await mkdir(join(firstAttempt as string, 'sources', 'stale'), { recursive: true });
    await writeFile(join(firstAttempt as string, 'evidence', 'keep.txt'), 'evidence-1', 'utf8');
    const secondAttempt = join(outputRoot, job.id, 'attempts', `2-${randomUUID()}`);
    await mkdir(join(secondAttempt, 'evidence'), { recursive: true });
    await mkdir(join(secondAttempt, 'sources', 'stale'), { recursive: true });
    await writeFile(join(secondAttempt, 'evidence', 'keep.txt'), 'evidence-2', 'utf8');
    const failingCleanupWorker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store: new MemoryStateStore(),
      github,
      outputRoot,
      workerId: 'worker-terminal-cleanup-fail',
      leaseMs: 1_000,
      backendOverride: 'local',
      allowUnsafeLocal: true,
      removeSources: async () => {
        throw new Error('cleanup still pending');
      },
    });
    const pending = await failingCleanupWorker.runOnce();
    assert.equal(pending.status, 'failed');
    assert.equal(pending.error, 'Generated source cleanup failed');
    assert.equal((await queue.list())[0]?.failureNotified, false);
    assert.equal(calls.length, 1);
    now = new Date(now.getTime() + 2_000);
    failPublication = false;
    const finalWorker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store: new MemoryStateStore(),
      github,
      outputRoot,
      workerId: 'worker-terminal-final',
      leaseMs: 1_000,
      backendOverride: 'local',
      allowUnsafeLocal: true,
    });
    const final = await finalWorker.runOnce();
    assert.equal(final.status, 'failed');
    assert.equal(await pathExists(firstAttempt as string), true);
    assert.equal(await pathExists(secondAttempt), true);
    assert.equal(await pathExists(join(firstAttempt as string, 'sources')), false);
    assert.equal(await pathExists(join(secondAttempt, 'sources')), false);
    assert.equal(
      (await readdir(firstAttempt as string)).some((entry) => entry.startsWith('.sources-trash-')),
      false,
    );
    assert.equal(
      (await readdir(secondAttempt)).some((entry) => entry.startsWith('.sources-trash-')),
      false,
    );
    assert.equal(
      await readFile(join(firstAttempt as string, 'evidence', 'keep.txt'), 'utf8'),
      'evidence-1',
    );
    assert.equal(await readFile(join(secondAttempt, 'evidence', 'keep.txt'), 'utf8'), 'evidence-2');
    assert.equal((await queue.list())[0]?.failureNotified, true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    queue.close();
  }
});

test('sources symlink is unlinked without touching its external target', async () => {
  const queue = new SqliteQueue(':memory:');
  const job = await enqueueWorkerJob(queue);
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-source-link-'));
  const externalRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-source-target-'));
  const externalAttempt = await mkdtemp(join(process.cwd(), 'work', 'worker-attempt-target-'));
  try {
    const orphanAttempt = join(outputRoot, job.id, 'attempts', `1-${randomUUID()}`);
    await mkdir(join(orphanAttempt, 'evidence'), { recursive: true });
    await writeFile(join(externalRoot, 'sentinel.txt'), 'keep', 'utf8');
    await writeFile(join(externalAttempt, 'sentinel.txt'), 'keep-attempt', 'utf8');
    await symlink(
      externalAttempt,
      join(outputRoot, job.id, 'attempts', `2-${randomUUID()}`),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await symlink(
      externalRoot,
      join(orphanAttempt, 'sources'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const worker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store: new MemoryStateStore(),
      github: publicationGithub([]),
      outputRoot,
      workerId: 'worker-source-link',
      backendOverride: 'local',
      allowUnsafeLocal: true,
    });
    const result = await worker.runOnce();
    assert.equal(result.status, 'completed', result.error);
    await worker.runOnce();
    assert.equal(await pathExists(join(orphanAttempt, 'sources')), false);
    assert.equal(await readFile(join(externalRoot, 'sentinel.txt'), 'utf8'), 'keep');
    assert.equal(await readFile(join(externalAttempt, 'sentinel.txt'), 'utf8'), 'keep-attempt');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
    await rm(externalAttempt, { recursive: true, force: true });
    queue.close();
  }
});

test('job-root symlink is rejected without touching its external target', async () => {
  const queue = new SqliteQueue(':memory:');
  const job = await enqueueWorkerJob(queue, 1);
  const outputRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-root-link-'));
  const externalRoot = await mkdtemp(join(process.cwd(), 'work', 'worker-root-target-'));
  try {
    await writeFile(join(externalRoot, 'sentinel.txt'), 'keep', 'utf8');
    await symlink(
      externalRoot,
      join(outputRoot, job.id),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const worker = new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store: new MemoryStateStore(),
      github: publicationGithub([]),
      outputRoot,
      workerId: 'worker-root-link',
      backendOverride: 'local',
      allowUnsafeLocal: true,
    });
    const result = await worker.runOnce();
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /Generated source cleanup failed/u);
    assert.equal(await readFile(join(externalRoot, 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
    queue.close();
  }
});

test('lease reclaim isolates attempts and unique owners from stale workers', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const queue = new SqliteQueue(':memory:', () => new Date(now));
  const job = await enqueueWorkerJob(queue, 3);
  const calls: string[] = [];
  const startedA = new Deferred();
  const startedB = new Deferred();
  const releaseA = new Deferred();
  const releaseB = new Deferred();
  let aAttemptRoot = '';
  let bAttemptRoot = '';
  let bSentinel = '';
  const github = publicationGithub(calls);
  const workerFor = (
    label: string,
    started: Deferred,
    release: Deferred,
    setPaths: (attemptRoot: string, sentinel: string) => void,
  ) =>
    new PatchProofWorker({
      queue,
      source: new FixtureSourceAdapter(),
      store: new MemoryStateStore(),
      github,
      outputRoot: 'work/worker-reclaim-root',
      workerId: 'same-worker-label',
      leaseMs: 1_000,
      backendOverride: 'local',
      allowUnsafeLocal: true,
      executeScenario: async (input: WorkerRunInput) => {
        const sourceRoot = join(input.basePath, '..');
        const attemptRoot = join(sourceRoot, '..');
        const sentinel = join(input.headPath, 'worker-sentinel.txt');
        await writeFile(sentinel, label, 'utf8');
        setPaths(attemptRoot, sentinel);
        assert.equal(input.basePath.includes('same-worker-label'), false);
        started.resolve();
        await release.promise;
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
  const outputRoot = resolve('work/worker-reclaim-root');
  try {
    await rm(outputRoot, { recursive: true, force: true });
    const workerA = workerFor('A', startedA, releaseA, (attemptRoot, sentinel) => {
      aAttemptRoot = attemptRoot;
      void sentinel;
    });
    const workerB = workerFor('B', startedB, releaseB, (attemptRoot, sentinel) => {
      bAttemptRoot = attemptRoot;
      bSentinel = sentinel;
    });
    const aPromise = workerA.runOnce();
    await startedA.promise;
    const firstClaim = (await queue.list())[0];
    assert.equal(firstClaim?.attempts, 1);
    now = new Date(now.getTime() + 2_000);
    const bPromise = workerB.runOnce();
    await startedB.promise;
    const secondClaim = (await queue.list())[0];
    assert.equal(secondClaim?.attempts, 2);
    assert.notEqual(firstClaim?.leaseOwner, secondClaim?.leaseOwner);
    assert.equal(secondClaim?.leaseOwner?.startsWith('same-worker-label-'), true);
    releaseA.resolve();
    const aResult = await aPromise;
    assert.equal(aResult.status, 'cancelled');
    assert.deepEqual(calls, []);
    assert.equal(await readFile(bSentinel, 'utf8'), 'B');
    assert.equal(await pathExists(join(aAttemptRoot, 'sources')), false);
    assert.equal(await pathExists(join(bAttemptRoot, 'sources')), true);
    releaseB.resolve();
    const bResult = await bPromise;
    assert.equal(bResult.status, 'completed', bResult.error);
    assert.equal(typeof bResult.bundlePath, 'string');
    assert.equal((await queue.list())[0]?.evidencePath, bResult.bundlePath);
    assert.equal(await pathExists(join(bAttemptRoot, 'sources')), false);
    assert.equal((await attemptRoots(outputRoot, job.id)).length, 2);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    queue.close();
  }
});
