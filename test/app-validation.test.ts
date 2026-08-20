import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AppValidationError,
  FixtureOverlaySourceAdapter,
  assertNoValidationArguments,
  assertSecretFreeText,
  buildValidationConfig,
  buildValidationContainerListCommand,
  buildValidationImageInventoryCommand,
  buildValidationImageCommand,
  buildValidationImageInspectCommand,
  buildValidationImageRemoveCommand,
  buildWebhookRequest,
  canonicalRepository,
  canonicalSyntheticPullRequest,
  cleanupValidationContainers,
  cleanupValidationImage,
  collectBoundedPages,
  instrumentProductionTransport,
  parseValidationEnvironment,
  runValidation,
  assertSnapshotMatches,
  serializeValidationSummary,
  summaryPath,
  validateValidationSummary,
} from '../scripts/app-validation.mjs';
import { computeWebhookSignature, MemoryStateStore } from '../packages/github/dist/index.js';
import { handleWebhook } from '../apps/github-app/dist/webhook.js';

const root = resolve(process.cwd());
const privateKey = '-----BEGIN PRIVATE KEY-----\nvalidation\n-----END PRIVATE KEY-----';
const validEnvironment = {
  PATCHPROOF_VALIDATION_APP_PRIVATE_KEY: privateKey,
  PATCHPROOF_VALIDATION_WEBHOOK_SECRET: '0123456789012345',
  APP_ID: '42',
  INSTALLATION_ID: '1001',
  REPOSITORY: 'Octo/Example',
  PR_NUMBER: '7',
  BASE_REF: 'main',
  BASE_SHA: 'A'.repeat(40),
  HEAD_SHA: 'B'.repeat(40),
  PATCHPROOF_SHA: 'C'.repeat(40),
  RUNNER_TEMP: join(root, 'work', 'app-validation-test-temp'),
};

function validSummary() {
  return {
    schemaVersion: 1,
    patchproofSha: 'a'.repeat(40),
    runId: '123e4567-e89b-12d3-a456-426614174000',
    repository: 'octo/example',
    pullRequest: 7,
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    deliveryId: '123e4567-e89b-12d3-a456-426614174001',
    terminalState: 'completed',
    attemptState: 'succeeded',
    check: { id: 101, appId: 42, ownership: 'app', headSha: 'c'.repeat(40) },
    comment: { id: 202, appId: 42, ownership: 'app' },
    evidence: { sha256: 'd'.repeat(64), result: 'PASS' },
    duplicate: { status: 'ignored', queuedJobs: 1, workerAttempts: 1, mutations: 0 },
    docker: {
      image: 'patchproof-app-validation-probe-0123456789abcdef0123456789abcdef',
      imageId: `sha256:${'e'.repeat(64)}`,
      network: 'none',
      user: '65532:65532',
      readOnlyRoot: true,
      capDrop: 'ALL',
      noNewPrivileges: true,
      resourceBounds: { memoryMb: 64, cpuCount: 1, pids: 32 },
      residualContainers: 0,
    },
    timestamps: {
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    },
    cleanup: { ok: true, residualCount: 0 },
  };
}

test('validation preflight rejects missing and hostile fixed identities without writing a summary', async () => {
  const runnerTemp = join(root, 'work', 'app-validation-preflight-no-write');
  await rm(runnerTemp, { recursive: true, force: true });
  await assert.rejects(
    () => runValidation({ environment: {}, repositoryRoot: root, arguments_: [] }),
    (error: unknown) => error instanceof AppValidationError && error.code === 'preflight',
  );
  assert.equal(await readdir(runnerTemp).catch(() => undefined), undefined);
  await assert.rejects(
    () =>
      runValidation({
        environment: { ...validEnvironment, REPOSITORY: '../../hostile' },
        repositoryRoot: root,
        arguments_: [],
      }),
    /repository identity is invalid/u,
  );
  assert.equal(await readdir(runnerTemp).catch(() => undefined), undefined);
});

test('fixed environment values are canonicalized and arguments are fail-closed', () => {
  const parsed = parseValidationEnvironment(validEnvironment);
  assert.equal(parsed.repository, 'Octo/Example');
  assert.equal(parsed.baseSha, 'a'.repeat(40));
  assert.equal(parsed.headSha, 'b'.repeat(40));
  assert.equal(parsed.appId, 42);
  assert.throws(
    () => parseValidationEnvironment({ ...validEnvironment, APP_ID: '042' }),
    /canonical|invalid/u,
  );
  assert.throws(
    () => parseValidationEnvironment({ ...validEnvironment, BASE_SHA: '0'.repeat(39) }),
    /SHA/u,
  );
  assert.throws(
    () => parseValidationEnvironment({ ...validEnvironment, BASE_REF: 'main..evil' }),
    /base ref/u,
  );
  assert.throws(
    () => parseValidationEnvironment({ ...validEnvironment, RUNNER_TEMP: 'relative/temp' }),
    /temporary/u,
  );
  assert.throws(() => assertNoValidationArguments(['--repository', 'octo/example']), /arguments/u);
  assert.equal(canonicalRepository('OCTO/Example'), 'OCTO/Example');
  assert.throws(() => canonicalRepository('octo/example/extra'), /repository identity/u);
});

test('live snapshot repository identity is compared case-insensitively without widening repo scope', () => {
  const environment = {
    repository: 'kwlck/PatchProof',
    pullRequest: 7,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  };
  const snapshot = {
    number: 7,
    state: 'open',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    headRepository: 'kwlck/PatchProof',
    repository: 'kwlck/PatchProof',
    fork: false,
  };
  assert.doesNotThrow(() => assertSnapshotMatches(snapshot, environment));
  assert.throws(
    () => assertSnapshotMatches({ ...snapshot, headRepository: 'kwlck/Other' }, environment),
    /snapshot/u,
  );
});

test('synthetic webhook bytes and signatures are deterministic and tightly allowlisted', () => {
  const metadata = {
    number: 7,
    repository: 'octo/example',
    installationId: 1001,
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headRef: 'validation',
    headSha: 'b'.repeat(40),
    headRepository: 'octo/example',
  };
  const body = canonicalSyntheticPullRequest(metadata);
  assert.equal(body, canonicalSyntheticPullRequest(metadata));
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.deepEqual(parsed.repository, { full_name: 'octo/example' });
  assert.deepEqual(parsed.installation, { id: 1001 });
  const request = buildWebhookRequest(
    body,
    validEnvironment.PATCHPROOF_VALIDATION_WEBHOOK_SECRET,
    '123e4567-e89b-12d3-a456-426614174000',
  );
  assert.equal(
    request.signature,
    computeWebhookSignature(body, validEnvironment.PATCHPROOF_VALIDATION_WEBHOOK_SECRET),
  );
  assert.equal(request.event, 'pull_request');
  assert.throws(() => buildWebhookRequest(body, 'short', request.deliveryId), /secret/u);
  assert.throws(
    () => canonicalSyntheticPullRequest({ ...metadata, repository: 'evil/../../repo' }),
    /repository/u,
  );
});

test('summary serializer rejects unexpected fields and credential-shaped values', () => {
  const summary = validSummary();
  assert.equal(JSON.parse(serializeValidationSummary(summary)).schemaVersion, 1);
  assert.throws(
    () => serializeValidationSummary({ ...summary, unexpected: true }),
    /unexpected field/u,
  );
  assert.throws(
    () => assertSecretFreeText('Authorization: Bearer ghp_123456789', ['webhook-secret']),
    /Secret-bearing/u,
  );
  assert.throws(() => assertSecretFreeText('-----BEGIN PRIVATE KEY-----', []), /Secret-bearing/u);
  assert.throws(
    () => assertSecretFreeText('header abcdefghijklmnop.qrstuvwxyz12345678.ABCDEFGHIJKLMNOP', []),
    /Secret-bearing/u,
  );
  assert.throws(
    () => validateValidationSummary({ ...summary, cleanup: { ok: true, residualCount: 1 } }),
    /cleanup/u,
  );
});

test('summary destination is the fixed bounded RUNNER_TEMP path', () => {
  const runnerTemp = resolve(root, 'work', 'summary-destination-test-temp');
  assert.equal(summaryPath(runnerTemp), join(runnerTemp, 'patchproof-app-validation-summary.json'));
  assert.throws(() => summaryPath('relative/temp'), /temporary/u);
});

test('Docker build/config specs cannot pull, publish, or carry credentials', async () => {
  const tag = 'patchproof-app-validation-probe-0123456789abcdef0123456789abcdef';
  const validationContext = resolve(root, 'test', 'fixtures', 'app-validation');
  const command = buildValidationImageCommand(
    validationContext,
    join(validationContext, 'Dockerfile'),
    tag,
  );
  assert.equal(command[0], 'docker');
  assert.ok(command.includes('--pull=false'));
  assert.equal(
    command.some((value) => value === 'pull' || value === 'push' || value === 'login'),
    false,
  );
  assert.equal(command.includes('--build-arg'), false);
  assert.equal(command.includes('--secret'), false);
  assert.deepEqual(buildValidationImageInspectCommand(tag).slice(0, 3), [
    'docker',
    'image',
    'inspect',
  ]);
  assert.deepEqual(buildValidationImageRemoveCommand(tag).slice(0, 4), [
    'docker',
    'image',
    'rm',
    '--force',
  ]);
  assert.deepEqual(buildValidationContainerListCommand(), [
    'docker',
    'container',
    'ls',
    '--all',
    '--format',
    '{{.Names}}',
  ]);
  assert.deepEqual(buildValidationImageInventoryCommand(), [
    'docker',
    'image',
    'ls',
    '--all',
    '--no-trunc',
    '--format',
    '{{.Repository}}:{{.Tag}}\\t{{.ID}}',
  ]);
  const config = buildValidationConfig(tag);
  assert.match(config, /backend: docker/u);
  assert.match(config, /network: none/u);
  assert.match(config, /readOnlyRoot: true/u);
  assert.doesNotMatch(config, /(?:TOKEN=|SECRET=|PRIVATE_KEY=|GITHUB_TOKEN=)/iu);
  assert.match(buildValidationConfig(`sha256:${'a'.repeat(64)}`), /dockerImage: sha256:/u);
  const dockerfile = await readFile(
    join(root, 'test', 'fixtures', 'app-validation', 'Dockerfile'),
    'utf8',
  );
  assert.match(dockerfile, /^FROM scratch/mu);
  assert.doesNotMatch(dockerfile, /^FROM\s+(?!scratch)/imu);
});

test('first-party probe accepts only EROFS as read-only proof', async () => {
  const probe = await readFile(join(root, 'test', 'fixtures', 'app-validation', 'probe.c'), 'utf8');
  assert.match(probe, /open\("\/patchproof-validation-root-write"/u);
  assert.doesNotMatch(probe, /\/etc\/patchproof-validation/u);
  assert.match(probe, /if\s*\(errno\s*!=\s*EROFS\)/u);
  assert.doesNotMatch(probe, /errno\s*(?:==|!=)\s*(?:ENOENT|EACCES|EPERM)/u);
  assert.match(probe, /root filesystem write check was inconclusive/u);
});

test('bounded reconciliation pagination enumerates beyond page one and fails closed when truncated', async () => {
  const seen: number[] = [];
  const items = await collectBoundedPages(
    async (page) => {
      seen.push(page);
      return page === 1
        ? { items: Array.from({ length: 100 }, (_, index) => index), total: 150, hasNext: false }
        : {
            items: Array.from({ length: 50 }, (_, index) => index + 100),
            total: 150,
            hasNext: false,
          };
    },
    { label: 'test surface' },
  );
  assert.deepEqual(seen, [1, 2]);
  assert.equal(items.length, 150);
  await assert.rejects(
    () =>
      collectBoundedPages(async () => ({ items: Array(100), total: 2_100, hasNext: false }), {
        label: 'test surface',
        maxPages: 2,
      }),
    /exceeded its bound/u,
  );
  await assert.rejects(
    () => collectBoundedPages(async () => ({ items: Array(10), total: 20, hasNext: false })),
    /incomplete/u,
  );
});

test('fixture overlay calls production source and executes only the checked-in fixture', async () => {
  const workspace = await mkdtemp(join(root, 'work', 'app-validation-overlay-'));
  const destination = join(workspace, 'destination');
  const calls: Array<{ repository: string; sha: string }> = [];
  try {
    const productionSource = {
      async materializeRevision(repository: string, sha: string, staging: string) {
        calls.push({ repository, sha });
        await writeFile(join(staging, 'untrusted-pr-code.txt'), 'must never be copied', 'utf8');
      },
    };
    const source = new FixtureOverlaySourceAdapter(
      productionSource,
      join(root, 'test', 'fixtures', 'app-validation'),
      workspace,
      'octo/example',
      'a'.repeat(40),
      'b'.repeat(40),
      buildValidationConfig('patchproof-app-validation-probe-0123456789abcdef0123456789abcdef'),
    );
    await source.materializeRevision('octo/example', 'a'.repeat(40), destination);
    assert.equal(calls.length, 1);
    assert.equal(
      await readFile(join(destination, 'untrusted-pr-code.txt'), 'utf8').catch(() => undefined),
      undefined,
    );
    assert.match(await readFile(join(destination, '.patchproof.yml'), 'utf8'), /backend: docker/u);
    assert.equal(
      (await readdir(workspace)).some((name) => name.startsWith('fetched-source-')),
      false,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('cleanup orchestration removes only newly-created validation containers and fails on residuals', async () => {
  const before = new Set(['patchproof-base-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  let current = new Set([...before, 'patchproof-head-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  const removed: string[] = [];
  const listContainers = async () => new Set(current);
  const command = async (_file: string, args: string[]) => {
    const name = args.at(-1);
    assert.equal(typeof name, 'string');
    removed.push(name as string);
    current.delete(name as string);
    return { stdout: '', stderr: '' };
  };
  assert.equal(await cleanupValidationContainers(before, { listContainers, command }), 0);
  assert.deepEqual(removed, ['patchproof-head-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  current = new Set([...before, 'patchproof-head-cccccccccccccccccccccccccccccccc']);
  await assert.rejects(
    () =>
      cleanupValidationContainers(before, {
        listContainers: async () => new Set(current),
        command: async () => {
          throw new Error('cleanup denied');
        },
      }),
    /cleanup failed/u,
  );
});

test('image cleanup confirms tag and image-id absence, while inventory failure is fatal', async () => {
  const tag = 'patchproof-app-validation-probe-0123456789abcdef0123456789abcdef';
  const imageId = `sha256:${'f'.repeat(64)}`;
  let current = [{ reference: `${tag}:latest`, id: imageId }];
  const removed: string[] = [];
  const listImages = async () => current.map((entry) => ({ ...entry }));
  const command = async (_file: string, args: string[]) => {
    const reference = args.at(-1);
    assert.equal(typeof reference, 'string');
    removed.push(reference as string);
    current = current.filter(
      (entry) =>
        entry.id !== reference &&
        entry.reference !== reference &&
        !entry.reference.startsWith(`${reference}:`) &&
        !entry.reference.startsWith(`${reference}@`),
    );
    return { stdout: '', stderr: '' };
  };
  assert.equal(await cleanupValidationImage({ tag, imageId }, { listImages, command }), 0);
  assert.deepEqual(removed, [tag]);
  await assert.rejects(
    () =>
      cleanupValidationImage(
        { tag, imageId },
        {
          listImages: async () => {
            throw new Error('daemon unavailable');
          },
        },
      ),
    /inventory failed/u,
  );
});

test('production webhook/store duplicate state prevents a second enqueue or mutation', async () => {
  const store = new MemoryStateStore();
  const deliveryId = '123e4567-e89b-12d3-a456-426614174002';
  const body = JSON.stringify({
    action: 'opened',
    number: 7,
    repository: { full_name: 'octo/example' },
    installation: { id: 1001 },
    pull_request: {
      base: { sha: 'a'.repeat(40), repo: { full_name: 'octo/example' } },
      head: { sha: 'b'.repeat(40), repo: { full_name: 'octo/example' } },
    },
  });
  let enqueued = 0;
  let checkCreates = 0;
  let checkUpdates = 0;
  let commentCreates = 0;
  let commentUpdates = 0;
  const github = {
    requiresInstallationId: true as const,
    appId: 42,
    async createCheck() {
      checkCreates += 1;
      return { id: 101 };
    },
    async updateCheck() {
      checkUpdates += 1;
    },
    async createComment() {
      commentCreates += 1;
      return { id: 202, body: 'managed' };
    },
    async updateComment() {
      commentUpdates += 1;
    },
  };
  const instrumented = instrumentProductionTransport(github);
  const dependencies = {
    webhookSecret: validEnvironment.PATCHPROOF_VALIDATION_WEBHOOK_SECRET,
    store,
    github: instrumented.transport,
    requireInstallationId: true,
    enqueue: async () => {
      enqueued += 1;
    },
  };
  const request = {
    rawBody: body,
    signature: computeWebhookSignature(body, dependencies.webhookSecret),
    deliveryId,
    event: 'pull_request',
  };
  const first = await handleWebhook(request, dependencies);
  const duplicate = await handleWebhook(request, dependencies);
  assert.equal(first.status, 202);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body, 'duplicate delivery ignored');
  assert.equal(enqueued, 1);
  assert.equal(checkCreates, 1);
  assert.equal(checkUpdates, 0);
  assert.equal(commentCreates, 1);
  assert.equal(commentUpdates, 0);
  assert.deepEqual(instrumented.counts, {
    createCheck: 1,
    updateCheck: 0,
    createComment: 1,
    updateComment: 0,
  });
  assert.equal(instrumented.mutationCount(), 2);
});
