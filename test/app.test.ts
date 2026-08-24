import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import https from 'node:https';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { handleWebhook } from '../apps/github-app/dist/webhook.js';
import { GitHubApiError, GitHubApiTransport } from '../apps/github-app/dist/github-api.js';
import { GitHubAppAuth, createGitHubAppJwt } from '../apps/github-app/dist/github-auth.js';
import { SqliteStateStore } from '../apps/github-app/dist/sqlite.js';
import { publishRunFailure, publishRunResult } from '../apps/github-app/dist/publisher.js';
import { computeWebhookSignature, MemoryStateStore } from '@patchproof/github';
import { createIntegrity, type EvidenceBundle } from '@patchproof/core';

interface MockHttpsResponse {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string | string[]>;
  readonly stalled?: boolean;
  readonly onDestroy?: () => void;
}

interface MockHttpsOptions {
  readonly protocol?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly servername?: string;
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

function installMockHttpsRequest(
  handler: (
    options: MockHttpsOptions,
    body: string,
  ) => MockHttpsResponse | Promise<MockHttpsResponse>,
): { requests: Array<{ options: MockHttpsOptions; body: string }>; restore: () => void } {
  const originalRequest = https.request;
  const requests: Array<{ options: MockHttpsOptions; body: string }> = [];
  https.request = ((options: unknown, callback?: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
      end: () => void;
    };
    let body = '';
    let requestSettled = false;
    let response: Readable | undefined;
    const signal = (options as MockHttpsOptions).signal;
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort);
    };
    const abort = (): void => {
      if (response !== undefined) {
        response.emit('aborted');
        response.destroy(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      if (requestSettled) return;
      requestSettled = true;
      request.emit('error', new DOMException('The operation was aborted', 'AbortError'));
    };
    request.write = (chunk: string): boolean => {
      body += chunk;
      return true;
    };
    request.end = (): void => {
      const recorded = { options: options as MockHttpsOptions, body };
      requests.push(recorded);
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      void Promise.resolve(handler(recorded.options, recorded.body)).then(
        (responseSpec) => {
          if (requestSettled) return;
          requestSettled = true;
          response = responseSpec.stalled
            ? new Readable({ read: () => {} })
            : Readable.from(
                responseSpec.body === undefined ? [] : [Buffer.from(responseSpec.body)],
              );
          const originalDestroy = response.destroy.bind(response);
          response.destroy = ((error?: Error | null) => {
            responseSpec.onDestroy?.();
            return originalDestroy(error);
          }) as typeof response.destroy;
          Object.assign(response, {
            statusCode: responseSpec.status,
            headers: responseSpec.headers ?? {},
          });
          response.once('end', cleanup);
          response.once('close', cleanup);
          callback?.(response);
        },
        (error: unknown) => {
          if (requestSettled) return;
          requestSettled = true;
          cleanup();
          request.emit('error', error);
        },
      );
    };
    return request as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;
  return { requests, restore: () => (https.request = originalRequest) };
}

const testPublicationFence = {
  signal: new AbortController().signal,
  async assertOwned(): Promise<void> {},
};

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

test('synchronize and close finalize the exact old-head Check as cancelled', async () => {
  const oldHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  const store = new MemoryStateStore();
  await store.putRun('octo/example', 7, { checkId: 77 }, oldHead);
  const updates: Array<{ id: number; payload: Record<string, unknown> }> = [];
  const createdChecks: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  let cancelled = 0;
  const github = {
    async updateCheck(_repository: string, id: number, payload: Record<string, unknown>) {
      events.push(`update:${id}`);
      updates.push({ id, payload });
    },
    async createCheck(_repository: string, _headSha: string, payload: Record<string, unknown>) {
      events.push('create-check');
      createdChecks.push(payload);
      return { id: 88 };
    },
    async createComment() {
      events.push('create-comment');
      return { id: 99, body: 'managed' };
    },
  };
  const makePullRequest = (action: 'synchronize' | 'closed', deliveryId: string) => {
    const body = JSON.stringify({
      action,
      number: 7,
      before: oldHead,
      installation: { id: 123 },
      repository: { full_name: 'octo/example' },
      pull_request: {
        base: { sha: 'c'.repeat(40) },
        head: { sha: action === 'closed' ? oldHead : newHead, repo: { full_name: 'octo/example' } },
      },
    });
    return {
      request: {
        rawBody: body,
        signature: computeWebhookSignature(body, 'close-secret'),
        deliveryId,
        event: 'pull_request',
      },
      body,
    };
  };
  const dependencies = {
    webhookSecret: 'close-secret',
    store,
    github,
    requireInstallationId: true,
    cancelPullRequest: async () => {
      events.push('cancel');
      cancelled += 1;
      return 1;
    },
    enqueue: async () => {},
  };
  const synchronized = makePullRequest('synchronize', 'sync-old-head');
  assert.equal((await handleWebhook(synchronized.request, dependencies)).enqueued, true);
  assert.equal(updates[0]?.id, 77);
  assert.equal(updates[0]?.payload.conclusion, 'cancelled');
  assert.equal(updates[0]?.payload.externalName, `patchproof:octo/example#7:${oldHead}`);
  assert.equal(createdChecks[0]?.externalName, `patchproof:octo/example#7:${newHead}`);
  assert.equal(events[0], 'cancel');
  assert.equal(events[1], `update:77`);
  const closed = makePullRequest('closed', 'close-current-head');
  assert.equal((await handleWebhook(closed.request, dependencies)).enqueued, false);
  assert.equal(cancelled, 2);
  assert.equal(updates.at(-1)?.id, 77);
  assert.equal(updates.at(-1)?.payload.conclusion, 'cancelled');
  assert.equal(events.at(-2), 'cancel');
  assert.equal(events.at(-1), 'update:77');
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
  const requestedPaths: string[] = [];
  const mock = installMockHttpsRequest((options) => {
    requestedPaths.push(options.path ?? '');
    assert.equal(options.protocol, 'https:');
    assert.equal(options.hostname, 'api.github.com');
    assert.equal(options.port, 443);
    assert.equal(options.servername, 'api.github.com');
    assert.equal(options.path, '/repos/octo/example/pulls/7');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers?.Authorization, 'Bearer test-token');
    return {
      status: 200,
      body: JSON.stringify({
        number: 7,
        state: 'open',
        base: { sha: invalid ? 'short' : 'a'.repeat(40) },
        head: {
          sha: invalid ? 'short' : 'b'.repeat(40),
          repo: headRepository === null ? null : { full_name: headRepository },
        },
      }),
      headers: { 'content-type': 'application/json' },
    };
  });
  const transport = new GitHubApiTransport('test-token');
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
    assert.deepEqual(requestedPaths, [
      '/repos/octo/example/pulls/7',
      '/repos/octo/example/pulls/7',
      '/repos/octo/example/pulls/7',
      '/repos/octo/example/pulls/7',
    ]);
  } finally {
    mock.restore();
  }
});

test('GitHub mutation transport forwards and honors AbortSignal', async () => {
  const mock = installMockHttpsRequest((options) => {
    assert.equal(options.protocol, 'https:');
    assert.equal(options.hostname, 'api.github.com');
    assert.equal(options.port, 443);
    assert.equal(options.servername, 'api.github.com');
    return {
      status: 200,
      body: JSON.stringify({ id: 17, body: 'managed' }),
      headers: { 'content-type': 'application/json' },
    };
  });
  const transport = new GitHubApiTransport('test-token');
  const controller = new AbortController();
  const payload = {
    name: 'PatchProof' as const,
    status: 'completed' as const,
    conclusion: 'neutral' as const,
    output: { title: 'title', summary: 'summary', text: 'text' },
  };
  try {
    assert.deepEqual(
      await transport.createCheck('octo/example', 'a'.repeat(40), payload, {
        signal: controller.signal,
      }),
      { id: 17 },
    );
    assert.equal(mock.requests[0]?.options.signal, controller.signal);
    controller.abort();
    await assert.rejects(
      () =>
        transport.createComment(
          'octo/example',
          7,
          { body: 'managed' },
          { signal: controller.signal },
        ),
      /aborted/u,
    );
    assert.equal(mock.requests[1]?.options.signal, controller.signal);
    assert.deepEqual(
      mock.requests.map(({ options }) => options.path),
      ['/repos/octo/example/check-runs', '/repos/octo/example/issues/7/comments'],
    );
  } finally {
    mock.restore();
  }
});

test('GitHub transport ignores attacker API-base environment values and rejects redirects', async () => {
  const previousApiBase = process.env.PATCHPROOF_GITHUB_API_BASE;
  process.env.PATCHPROOF_GITHUB_API_BASE = 'https://attacker.test';
  const locations = [
    'https://api.github.com/repos/octo/example/issues/7/comments',
    'https://attacker.test/steal',
    '//attacker.test/steal',
    '../steal',
  ];
  const redirects = [301, 302, 303, 307, 308].flatMap((status) =>
    locations.map((location) => ({ status, location })),
  );
  let responseIndex = 0;
  const provider = {
    requiresInstallationId: false as const,
    appId: 123,
    getToken: async () => 'development-token',
  };
  const mock = installMockHttpsRequest((options) => {
    const redirect = redirects[responseIndex];
    assert.ok(redirect);
    assert.equal(options.protocol, 'https:');
    assert.equal(options.hostname, 'api.github.com');
    assert.equal(options.port, 443);
    assert.equal(options.servername, 'api.github.com');
    assert.equal(options.method, 'POST');
    assert.equal(options.path, '/repos/octo/example/issues/7/comments');
    return { status: redirect.status, headers: { location: redirect.location } };
  });
  try {
    const transport = new GitHubApiTransport(provider);
    for (const redirect of redirects) {
      await assert.rejects(
        () => transport.createComment('octo/example', 7, { body: 'managed' }),
        /request failed/u,
      );
      assert.equal(mock.requests.length, redirects.indexOf(redirect) + 1);
      responseIndex += 1;
    }
    assert.equal(mock.requests.length, redirects.length);
    assert.deepEqual(
      mock.requests.map(({ options }) => ({
        protocol: options.protocol,
        hostname: options.hostname,
        port: options.port,
        servername: options.servername,
        method: options.method,
        path: options.path,
      })),
      redirects.map(() => ({
        protocol: 'https:',
        hostname: 'api.github.com',
        port: 443,
        servername: 'api.github.com',
        method: 'POST',
        path: '/repos/octo/example/issues/7/comments',
      })),
    );
  } finally {
    mock.restore();
    if (previousApiBase === undefined) delete process.env.PATCHPROOF_GITHUB_API_BASE;
    else process.env.PATCHPROOF_GITHUB_API_BASE = previousApiBase;
  }
});

test('GitHub transport uses canonical finite routes for every endpoint family', async () => {
  const owner = 'A' + 'b'.repeat(37) + '9';
  const repository = 'r'.repeat(100);
  const identity = `${owner}/${repository}`;
  const headSha = 'a'.repeat(40);
  const expectedPaths = [
    `/repos/${owner}/${repository}/pulls/7`,
    `/repos/${owner}/${repository}/check-runs`,
    `/repos/${owner}/${repository}/check-runs/8`,
    `/repos/${owner}/${repository}/issues/9/comments`,
    `/repos/${owner}/${repository}/issues/comments/10`,
    `/repos/${owner}/${repository}/commits/${headSha}/check-runs?check_name=PatchProof&filter=all&app_id=123&per_page=100&page=1`,
    `/repos/${owner}/${repository}/issues/9/comments?per_page=100&page=1`,
  ];
  const mock = installMockHttpsRequest((options) => {
    assert.equal(options.protocol, 'https:');
    assert.equal(options.hostname, 'api.github.com');
    assert.equal(options.port, 443);
    assert.equal(options.servername, 'api.github.com');
    assert.equal(options.headers?.Authorization, 'Bearer test-token');
    assert.equal(options.headers?.['User-Agent'], 'PatchProof/0.1.0');
    assert.equal('agent' in options, false);
    assert.equal('lookup' in options, false);
    assert.equal('socketPath' in options, false);
    const path = options.path ?? '';
    const pathname = new URL(`https://api.github.com${path}`).pathname;
    if (pathname.endsWith('/pulls/7'))
      return {
        status: 200,
        body: JSON.stringify({
          number: 7,
          state: 'open',
          base: { sha: headSha, repo: { full_name: identity } },
          head: { sha: headSha, repo: { full_name: identity } },
        }),
      };
    if (pathname.endsWith('/check-runs') && options.method === 'GET')
      return { status: 200, body: JSON.stringify({ total_count: 0, check_runs: [] }) };
    if (pathname.includes('/comments') && options.method === 'GET')
      return { status: 200, body: JSON.stringify([]) };
    if (pathname.endsWith('/comments'))
      return { status: 201, body: JSON.stringify({ id: 11, body: 'managed' }) };
    return { status: options.method === 'POST' ? 201 : 200, body: JSON.stringify({ id: 12 }) };
  });
  const provider = {
    requiresInstallationId: false as const,
    appId: 123,
    getToken: async () => 'test-token',
  };
  try {
    const transport = new GitHubApiTransport(provider);
    assert.deepEqual(await transport.getPullRequest(identity, 7), {
      number: 7,
      state: 'open',
      baseSha: headSha,
      headSha,
      headRepository: identity,
      fork: false,
      repository: identity,
    });
    await transport.createCheck(identity, headSha, {
      name: 'PatchProof',
      status: 'completed',
      conclusion: 'success',
    });
    await transport.updateCheck(identity, 8, {
      name: 'PatchProof',
      status: 'completed',
      conclusion: 'success',
    });
    assert.deepEqual(await transport.createComment(identity, 9, { body: 'managed' }), {
      id: 11,
      body: 'managed',
    });
    await transport.updateComment(identity, 10, { body: 'managed' });
    assert.equal(await transport.findManagedCheck(identity, 9, headSha), undefined);
    assert.equal(await transport.findManagedComment(identity, 9), undefined);
    assert.deepEqual(
      mock.requests.map(({ options }) => ({ method: options.method, path: options.path })),
      [
        { method: 'GET', path: expectedPaths[0] },
        { method: 'POST', path: expectedPaths[1] },
        { method: 'PATCH', path: expectedPaths[2] },
        { method: 'POST', path: expectedPaths[3] },
        { method: 'PATCH', path: expectedPaths[4] },
        { method: 'GET', path: expectedPaths[5] },
        { method: 'GET', path: expectedPaths[6] },
      ],
    );
  } finally {
    mock.restore();
  }
});

test('GitHub transport rejects hostile route identities, SHAs, and IDs before dispatch', async () => {
  const mock = installMockHttpsRequest(() => ({
    status: 200,
    body: JSON.stringify({ id: 1, body: 'unexpected' }),
  }));
  const transport = new GitHubApiTransport('test-token');
  const hostileRepositories = [
    '',
    '/repo',
    'owner/',
    'owner/repo/extra',
    'owner\\repo',
    'owner?repo',
    'owner#repo',
    'owner%2Frepo',
    'owner repo',
    'owner/репо',
    '-owner/repo',
    'owner-/repo',
    '_owner/repo',
    'owner/.',
    'owner/..',
    'a'.repeat(40) + '/repo',
    'owner/' + 'r'.repeat(101),
    'owner/repo\n',
    'owner/repo\r\n',
  ];
  try {
    for (const repository of hostileRepositories)
      await assert.rejects(
        () => transport.createComment(repository, 7, { body: 'managed' }),
        /Repository/u,
      );
    for (const sha of [
      'A'.repeat(40),
      'a'.repeat(39),
      'g'.repeat(40),
      'a'.repeat(40) + '/',
      'a'.repeat(40) + '?x',
    ])
      await assert.rejects(
        () =>
          transport.createCheck('owner/repo', sha, {
            name: 'PatchProof',
            status: 'in_progress',
          }),
        /SHA/u,
      );
    for (const id of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await assert.rejects(
        () => transport.createComment('owner/repo', id, { body: 'managed' }),
        /invalid/u,
      );
      await assert.rejects(
        () =>
          transport.updateCheck('owner/repo', id, {
            name: 'PatchProof',
            status: 'in_progress',
          }),
        /invalid/u,
      );
    }
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test('GitHub App JWTs are signed with bounded claims and installation tokens are isolated and refreshed', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const jwt = createGitHubAppJwt({ appId: 123, privateKey: privatePem }, now);
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
  assert.ok(encodedHeader && encodedPayload && encodedSignature);
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString()), {
    alg: 'RS256',
    typ: 'JWT',
  });
  assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()), {
    iat: Math.floor(now.getTime() / 1_000) - 60,
    exp: Math.floor(now.getTime() / 1_000) + 540,
    iss: 123,
  });
  assert.equal(
    verifySignature(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      Buffer.from(encodedSignature, 'base64url'),
    ),
    true,
  );

  const originalFetch = globalThis.fetch;
  let calls = 0;
  const requestedInstallations: number[] = [];
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls += 1;
    requestedUrls.push(String(input));
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    requestedInstallations.push(Number(String(input).match(/installations\/(\d+)/u)?.[1]));
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return new Response(
      JSON.stringify({
        token: `installation-token-${requestedInstallations.at(-1)}`,
        expires_at: new Date(now.getTime() + 300_000).toISOString(),
      }),
      { status: 201 },
    );
  };
  try {
    const auth = new GitHubAppAuth(
      { appId: 123, privateKey: privatePem },
      { safetyMarginMs: 60_000, clock: () => now },
    );
    assert.equal(await auth.getToken(10), 'installation-token-10');
    assert.equal(await auth.getToken(10), 'installation-token-10');
    assert.equal(await auth.getToken(11), 'installation-token-11');
    assert.equal(calls, 2);
    now.setTime(now.getTime() + 240_000);
    assert.equal(await auth.getToken(10), 'installation-token-10');
    assert.equal(calls, 3);
    assert.deepEqual(requestedInstallations, [10, 11, 10]);
    assert.equal(
      await auth.getToken(Number.MAX_SAFE_INTEGER),
      'installation-token-9007199254740991',
    );
    assert.equal(
      requestedUrls.at(-1),
      'https://api.github.com/app/installations/9007199254740991/access_tokens',
    );
    assert.equal(calls, 4);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => auth.getToken(12, { signal: controller.signal }), /aborted/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GitHub App authentication rejects hostile identities and token responses', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const now = new Date('2026-01-01T00:00:00.000Z');
  const auth = new GitHubAppAuth(
    { appId: 123, privateKey: privatePem },
    { safetyMarginMs: 60_000, clock: () => now },
  );
  assert.throws(
    () =>
      new GitHubAppAuth({ appId: 123, privateKey: privatePem }, {
        apiBase: 'https://attacker.test',
      } as never),
    /API origin is fixed/u,
  );
  for (const value of [
    '10',
    new Number(10),
    { valueOf: () => 10 },
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => auth.getToken(value as unknown as number),
      /installation identity is invalid/u,
    );
  }

  const originalFetch = globalThis.fetch;
  const responses: Response[] = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    assert.equal(init?.redirect, 'error');
    const response = responses.shift();
    if (response === undefined) throw new Error('unexpected authentication request');
    return response;
  };
  const responseBody = (body: unknown, status = 201): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const validExpiry = new Date(now.getTime() + 300_000).toISOString();
  const assertInvalidResponse = async (body: unknown, status = 201): Promise<void> => {
    responses.push(responseBody(body, status));
    await assert.rejects(() => auth.getToken(1), /GitHub .*authentication/u);
  };
  try {
    await assertInvalidResponse('{');
    await assertInvalidResponse(null);
    await assertInvalidResponse([]);
    await assertInvalidResponse({ expires_at: validExpiry });
    await assertInvalidResponse({ token: '', expires_at: validExpiry });
    await assertInvalidResponse({ token: '   ', expires_at: validExpiry });
    await assertInvalidResponse({ token: 'x'.repeat(16_385), expires_at: validExpiry });
    await assertInvalidResponse({ token: 'safe-token', expires_at: 123 });
    await assertInvalidResponse({ token: 'safe-token', expires_at: '2026-01-01' });
    await assertInvalidResponse({ token: 'safe-token', expires_at: '2026-02-30T00:00:00Z' });
    await assertInvalidResponse({ token: 'safe-token', expires_at: now.toISOString() });
    await assertInvalidResponse({
      token: 'safe-token',
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
    });
    for (const status of [301, 302, 307, 308, 400, 500])
      await assertInvalidResponse({ token: 'safe-token', expires_at: validExpiry }, status);
    assert.equal(calls, 18);
    responses.push(responseBody({ token: 'safe-token', expires_at: validExpiry }));
    assert.equal(await auth.getToken(1), 'safe-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GitHub transport keeps endpoint dispatch runtime-private', async () => {
  const mock = installMockHttpsRequest(() => ({
    status: 200,
    body: JSON.stringify({ id: 1, body: 'unexpected' }),
  }));
  const transport = new GitHubApiTransport('test-token');
  const runtime = transport as unknown as Record<string, unknown>;
  const prototypeNames = Object.getOwnPropertyNames(Object.getPrototypeOf(transport));
  try {
    assert.equal(runtime.request, undefined);
    assert.equal(runtime.requestWithMetadata, undefined);
    assert.equal(Reflect.get(transport, '#request'), undefined);
    assert.equal(
      prototypeNames.some((name) => name.includes('request')),
      false,
    );
    const forged = { method: 'GET', path: 'https://attacker.test/steal' };
    assert.throws(() => (runtime.request as (...args: unknown[]) => unknown)(forged), TypeError);
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test('GitHub transport destroys rejected bodies and aborts accepted stalled bodies', async () => {
  const rejectedStatuses = [301, 302, 303, 307, 308, 500];
  let requestIndex = 0;
  let destroyed = 0;
  const mock = installMockHttpsRequest(() => ({
    status: rejectedStatuses[requestIndex++] ?? 500,
    stalled: true,
    onDestroy: () => {
      destroyed += 1;
    },
  }));
  const transport = new GitHubApiTransport('test-token');
  try {
    for (const status of rejectedStatuses)
      await assert.rejects(
        () => transport.createComment('owner/repo', 7, { body: 'managed' }),
        new RegExp(String(status), 'u'),
      );
    assert.equal(mock.requests.length, rejectedStatuses.length);
    assert.equal(destroyed, rejectedStatuses.length);
  } finally {
    mock.restore();
  }

  let acceptedDestroyed = 0;
  const acceptedMock = installMockHttpsRequest(() => ({
    status: 200,
    stalled: true,
    onDestroy: () => {
      acceptedDestroyed += 1;
    },
  }));
  const controller = new AbortController();
  const acceptedTransport = new GitHubApiTransport('test-token', 1_000);
  try {
    const pending = acceptedTransport.createComment(
      'owner/repo',
      7,
      { body: 'managed' },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, /aborted/u);
    assert.equal(acceptedMock.requests.length, 1);
    assert.equal(acceptedDestroyed, 1);
  } finally {
    acceptedMock.restore();
  }
});

test('GitHub transport replays content creation after a bounded secondary rate limit', async () => {
  const mock = installMockHttpsRequest((options) => {
    if (options.method === 'POST' && mock.requests.length === 1)
      return {
        status: 403,
        headers: { 'retry-after': '1', 'x-ratelimit-remaining': '4990' },
        body: '{"message":"Forbidden"}',
      };
    return { status: 201, body: '{"id":77,"body":"managed"}' };
  });
  const transport = new GitHubApiTransport('test-token');
  try {
    const comment = await transport.createComment('owner/repo', 22, { body: 'managed' });
    assert.equal(comment.id, 77);
    assert.equal(mock.requests.length, 2);
  } finally {
    mock.restore();
  }
});

test('GitHub transport surfaces rate-limit diagnostics without replay on primary exhaustion', async () => {
  const mock = installMockHttpsRequest(() => ({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
    body: '{"message":"Forbidden"}',
  }));
  const transport = new GitHubApiTransport('test-token');
  try {
    const pending = transport.createComment('owner/repo', 22, { body: 'managed' });
    await assert.rejects(
      () => pending,
      /GitHub API request failed \(403\) for POST \/repos\/owner\/repo\/issues\/22\/comments \[ratelimit-remaining=0\]/u,
    );
    const error = (await pending.catch((caught: unknown) => caught)) as GitHubApiError;
    assert.equal(error.status, 403);
    assert.equal(mock.requests.length, 1);
  } finally {
    mock.restore();
  }
});

test('GitHub transport fails closed when the advised secondary wait exceeds the bound', async () => {
  const mock = installMockHttpsRequest(() => ({
    status: 403,
    headers: { 'retry-after': '60', 'x-ratelimit-remaining': '4990' },
    body: '{"message":"Forbidden"}',
  }));
  const transport = new GitHubApiTransport('test-token');
  try {
    const pending = transport.createComment('owner/repo', 22, { body: 'managed' });
    await assert.rejects(
      () => pending,
      /GitHub API request failed \(403\).*retry-after=60s.*advised wait exceeds the replay bound/u,
    );
    const error = (await pending.catch((caught: unknown) => caught)) as GitHubApiError;
    assert.equal(error.status, 403);
    assert.equal(mock.requests.length, 1);
  } finally {
    mock.restore();
  }
});

test('GitHub transport does not replay rejected reads', async () => {
  const mock = installMockHttpsRequest(() => ({
    status: 403,
    headers: { 'retry-after': '1' },
    body: '[]',
  }));
  const transport = new GitHubApiTransport({
    requiresInstallationId: false as const,
    appId: 4660890,
    getToken: async () => 'test-token',
  });
  try {
    await assert.rejects(
      () => transport.findManagedComment('owner/repo', 22),
      /GitHub API request failed \(403\) for GET \/repos\/owner\/repo\/issues\/22\/comments\?per_page=100&page=1 \[retry-after=1s\]/u,
    );
    assert.equal(mock.requests.length, 1);
  } finally {
    mock.restore();
  }
});

test('GitHub transport uses external_id and fails closed on spoofed managed comments', async () => {
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const provider = {
    requiresInstallationId: false as const,
    appId: 123,
    getToken: async () => 'development-token',
  };
  let commentMode: 'spoofed' | 'owned' | 'invalid' = 'spoofed';
  const mock = installMockHttpsRequest((options, requestBody) => {
    const path = options.path ?? '';
    const pathname = new URL(`https://api.github.com${path}`).pathname;
    const method = options.method ?? 'GET';
    requests.push({
      path,
      ...(requestBody !== '' ? { body: JSON.parse(requestBody) as Record<string, unknown> } : {}),
    });
    if (pathname.endsWith('/check-runs') && method === 'POST')
      return { status: 201, body: JSON.stringify({ id: 7 }) };
    if (pathname.endsWith('/check-runs') && method === 'GET') {
      const url = new URL(`https://api.github.com${path}`);
      assert.equal(url.searchParams.get('check_name'), 'PatchProof');
      assert.equal(url.searchParams.get('filter'), 'all');
      assert.equal(url.searchParams.get('app_id'), '123');
      assert.equal(url.searchParams.get('per_page'), '100');
      assert.equal(url.searchParams.get('page'), '1');
      return {
        status: 200,
        body: JSON.stringify({
          check_runs: [
            { id: 8, name: 'PatchProof', external_name: 'wrong-field' },
            {
              id: 9,
              name: 'PatchProof',
              external_id: 'patchproof:octo/example#7:' + 'a'.repeat(40),
              head_sha: 'a'.repeat(40),
              app: { id: 123 },
            },
          ],
        }),
      };
    }
    if (pathname.includes('/comments')) {
      if (commentMode === 'invalid')
        return { status: 200, body: JSON.stringify({ comments: true }) };
      return {
        status: 200,
        body: JSON.stringify([
          {
            id: commentMode === 'spoofed' ? 12 : 13,
            body: '<!-- patchproof:summary:start -->managed<!-- patchproof:summary:end -->',
            performed_via_github_app: { id: commentMode === 'spoofed' ? 999 : 123 },
          },
        ]),
      };
    }
    return { status: 200, body: JSON.stringify({ id: 1, body: 'ok' }) };
  });
  try {
    const transport = new GitHubApiTransport(provider);
    const payload = {
      name: 'PatchProof' as const,
      status: 'completed' as const,
      conclusion: 'success' as const,
      externalName: 'patchproof:octo/example#7:' + 'a'.repeat(40),
      output: { title: 'title', summary: 'summary', text: 'text' },
    };
    await transport.createCheck('octo/example', 'a'.repeat(40), payload);
    assert.equal(requests[0]?.body?.external_id, payload.externalName);
    assert.equal('external_name' in (requests[0]?.body ?? {}), false);
    assert.equal((await transport.findManagedCheck('octo/example', 7, 'a'.repeat(40)))?.id, 9);
    assert.equal((await transport.findManagedComment('octo/example', 7))?.id, undefined);
    commentMode = 'owned';
    assert.equal((await transport.findManagedComment('octo/example', 7))?.id, 13);
    commentMode = 'invalid';
    await assert.rejects(
      () => transport.findManagedComment('octo/example', 7),
      /invalid comment response/u,
    );
  } finally {
    mock.restore();
  }
});

test('GitHub Check reconciliation recovers an accepted create after an ambiguous timeout', async () => {
  const headSha = 'a'.repeat(40);
  const externalId = `patchproof:octo/example#7:${headSha}`;
  let createRequests = 0;
  let listRequests = 0;
  const provider = {
    requiresInstallationId: false as const,
    appId: 123,
    getToken: async () => 'development-token',
  };
  const mock = installMockHttpsRequest(async (options) => {
    const path = options.path ?? '';
    const method = options.method ?? 'GET';
    const url = new URL(`https://api.github.com${path}`);
    if (method === 'POST' && url.pathname.endsWith('/check-runs')) {
      createRequests += 1;
      // Model GitHub accepting the request while the client times out before
      // receiving the response. The next owner must reconcile, not create.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return { status: 201, body: JSON.stringify({ id: 101 }) };
    }
    if (method === 'GET' && url.pathname.endsWith('/check-runs')) {
      listRequests += 1;
      assert.equal(url.searchParams.get('check_name'), 'PatchProof');
      assert.equal(url.searchParams.get('filter'), 'all');
      assert.equal(url.searchParams.get('app_id'), '123');
      assert.equal(url.searchParams.get('per_page'), '100');
      assert.equal(url.searchParams.get('page'), '1');
      return {
        status: 200,
        body: JSON.stringify({
          total_count: 1,
          check_runs: [
            {
              id: 101,
              name: 'PatchProof',
              external_id: externalId,
              head_sha: headSha,
              app: { id: 123 },
            },
          ],
        }),
      };
    }
    throw new Error(`unexpected GitHub request: ${method} ${url.pathname}`);
  });
  try {
    const transport = new GitHubApiTransport(provider, 1);
    await assert.rejects(
      () =>
        transport.createCheck('octo/example', headSha, {
          name: 'PatchProof',
          status: 'in_progress',
          externalName: externalId,
        }),
      /aborted/u,
    );
    assert.equal(createRequests, 1);
    assert.deepEqual(await transport.findManagedCheck('octo/example', 7, headSha), {
      id: 101,
      headSha,
    });
    assert.equal(listRequests, 1);
    assert.equal(createRequests, 1, 'reconciliation must not blind-create a second Check');
  } finally {
    mock.restore();
  }
});

test('managed comment reconciliation paginates to page two and stops at a hard bound', async () => {
  const pages: number[] = [];
  const provider = {
    requiresInstallationId: false as const,
    appId: 123,
    getToken: async () => 'development-token',
  };
  let invalidPage = false;
  const mock = installMockHttpsRequest((options) => {
    const url = new URL(`https://api.github.com${options.path ?? ''}`);
    const page = Number(url.searchParams.get('page'));
    pages.push(page);
    if (invalidPage)
      return {
        status: 200,
        body: JSON.stringify(Array.from({ length: 100 }, () => ({}))),
      };
    if (page === 1)
      return {
        status: 200,
        body: JSON.stringify(
          Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            body: 'unmanaged',
            performed_via_github_app: { id: 999 },
          })),
        ),
      };
    if (page === 2)
      return {
        status: 200,
        body: JSON.stringify([
          {
            id: 202,
            body: '<!-- patchproof:summary:start -->managed<!-- patchproof:summary:end -->',
            performed_via_github_app: { id: 123 },
          },
        ]),
      };
    return { status: 200, body: JSON.stringify([]) };
  });
  try {
    const transport = new GitHubApiTransport(provider);
    assert.equal((await transport.findManagedComment('octo/example', 7))?.id, 202);
    assert.deepEqual(pages, [1, 2]);

    pages.length = 0;
    invalidPage = true;
    await assert.rejects(
      () => transport.findManagedComment('octo/example', 7),
      /comment reconciliation was incomplete/u,
    );
    assert.equal(pages.length, 20);
  } finally {
    mock.restore();
  }
});

test('managed Check reconciliation follows total_count beyond the first 100 runs', async () => {
  const pages: number[] = [];
  const provider = {
    requiresInstallationId: false as const,
    appId: 123,
    getToken: async () => 'development-token',
  };
  const headSha = 'a'.repeat(40);
  const mock = installMockHttpsRequest((options) => {
    const page = Number(
      new URL(`https://api.github.com${options.path ?? ''}`).searchParams.get('page'),
    );
    pages.push(page);
    if (page === 1)
      return {
        status: 200,
        body: JSON.stringify({
          total_count: 101,
          check_runs: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            name: 'Other check',
            external_id: `other-${index}`,
            head_sha: headSha,
            app: { id: 456 },
          })),
        }),
      };
    return {
      status: 200,
      body: JSON.stringify({
        total_count: 101,
        check_runs: [
          {
            id: 202,
            name: 'PatchProof',
            external_id: `patchproof:octo/example#7:${headSha}`,
            head_sha: headSha,
            app: { id: 123 },
          },
        ],
      }),
    };
  });
  try {
    const transport = new GitHubApiTransport(provider);
    assert.equal((await transport.findManagedCheck('octo/example', 7, headSha))?.id, 202);
    assert.deepEqual(pages, [1, 2]);
  } finally {
    mock.restore();
  }
});

test('App-bound surface IDs reject legacy rows until remote reconciliation binds the current App', async () => {
  const store = new SqliteStateStore(':memory:');
  const headSha = 'a'.repeat(40);
  try {
    await store.putRun('octo/example', 7, { checkId: 10, commentId: 11 }, headSha);
    assert.equal(await store.getRun('octo/example', 7, headSha, 123), undefined);
    await store.putRun('octo/example', 7, { checkId: 20, commentId: 21, appId: 123 }, headSha);
    assert.deepEqual(await store.getRun('octo/example', 7, headSha, 123), {
      checkId: 20,
      commentId: 21,
    });
    assert.equal(await store.getRun('octo/example', 7, headSha, 456), undefined);
  } finally {
    store.close();
  }
});

test('SQLite claim migration canonicalizes legacy UTC datetimes independent of host timezone', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'work', 'publication-claim-migration-'));
  const filename = join(directory, 'claims.sqlite');
  const headSha = 'a'.repeat(40);
  const newHeadSha = 'b'.repeat(40);
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Yekaterinburg';
  let store: SqliteStateStore | undefined;
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE publication_claims (
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        generation INTEGER NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (repository, pull_request)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO publication_claims(
           repository, pull_request, head_sha, claim_token, generation, claimed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('octo/example', 7, headSha, 'legacy-token', 1, '2026-01-01 00:00:00');
    legacy.close();

    let now = new Date('2026-01-01T00:01:00.000Z');
    store = new SqliteStateStore(filename, () => now);
    const migratedDatabase = new DatabaseSync(filename);
    const migrated = migratedDatabase
      .prepare(
        `SELECT claimed_at, renewed_at, expires_at
         FROM publication_claims WHERE repository = ? AND pull_request = ?`,
      )
      .get('octo/example', 7);
    migratedDatabase.close();
    assert.deepEqual(
      { ...migrated },
      {
        claimed_at: '2026-01-01T00:00:00.000Z',
        renewed_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T00:05:00.000Z',
      },
    );
    // A second open/migration must leave already-canonical values unchanged.
    const second = new SqliteStateStore(filename, () => now);
    second.close();

    assert.equal(
      await store.claimPublication?.('octo/example', 7, newHeadSha),
      undefined,
      'legacy 00:00Z claim remains blocking at 00:01Z',
    );
    const renewed = await store.renewPublicationClaim?.('octo/example', 7, {
      headSha,
      token: 'legacy-token',
      generation: 1,
      leaseVersion: 1,
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
    assert.ok(renewed);
    assert.equal(renewed.expiresAt, '2026-01-01T00:06:00.000Z');
    now = new Date('2026-01-01T00:05:00.000Z');
    assert.equal(
      await store.claimPublication?.('octo/example', 7, newHeadSha),
      undefined,
      'renewal keeps the owner beyond the original expiry',
    );
    now = new Date('2026-01-01T00:06:00.000Z');
    assert.ok(
      await store.claimPublication?.('octo/example', 7, newHeadSha),
      'takeover succeeds exactly at the renewed UTC expiry',
    );

    const fresh = new SqliteStateStore(':memory:', () => new Date('2026-01-01T00:00:00.000Z'));
    const freshClaim = await fresh.claimPublication?.('octo/example', 7, headSha);
    assert.ok(freshClaim);
    assert.equal(freshClaim.expiresAt, '2026-01-01T00:05:00.000Z');
    fresh.close();
  } finally {
    store?.close();
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite claim migration fails closed for malformed timestamps and preserves the row', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'work', 'publication-claim-invalid-'));
  const cases = [
    { field: 'expires_at', value: 'not-a-date', expected: /expires_at timestamp is invalid/u },
    {
      field: 'expires_at',
      value: '2026-02-30T00:00:00.000Z',
      expected: /expires_at timestamp is invalid/u,
    },
    {
      field: 'expires_at',
      value: '2026-01-01T00:00:00.000+00:00',
      expected: /expires_at timestamp is invalid/u,
    },
    {
      field: 'expires_at',
      value: '2026-01-01T00:00:00.000',
      expected: /expires_at timestamp is invalid/u,
    },
    {
      field: 'expires_at',
      value: 'January 1, 2026',
      expected: /expires_at timestamp is invalid/u,
    },
    {
      field: 'expires_at',
      value: '2026-01-01T24:00:00.000Z',
      expected: /expires_at timestamp is invalid/u,
    },
    {
      field: 'expires_at',
      value: '2026-01-01T00:00:00.000Z trailing',
      expected: /expires_at timestamp is invalid/u,
    },
    {
      field: 'claimed_at',
      value: '2026-02-29T00:00:00.000Z',
      expected: /claimed_at timestamp is invalid/u,
    },
    {
      field: 'claimed_at',
      value: '',
      expected: /claimed_at timestamp is invalid/u,
    },
    { field: 'renewed_at', value: 'not-a-date', expected: /renewed_at timestamp is invalid/u },
    {
      field: 'renewed_at',
      value: '2024-02-30 00:00:00',
      expected: /renewed_at timestamp is invalid/u,
    },
    {
      field: 'renewed_at',
      value: '',
      expected: /renewed_at timestamp is invalid/u,
    },
  ] as const;
  try {
    for (const [index, { field, value, expected }] of cases.entries()) {
      const filename = join(directory, `${index}-${field}.sqlite`);
      const legacy = new DatabaseSync(filename);
      legacy.exec(`
        CREATE TABLE publication_claims (
          repository TEXT NOT NULL,
          pull_request INTEGER NOT NULL,
          head_sha TEXT NOT NULL,
          claim_token TEXT NOT NULL,
          generation INTEGER NOT NULL,
          claimed_at TEXT NOT NULL,
          renewed_at TEXT,
          expires_at TEXT,
          lease_version INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (repository, pull_request)
        );
      `);
      legacy
        .prepare(
          `INSERT INTO publication_claims(
             repository, pull_request, head_sha, claim_token, generation,
             claimed_at, renewed_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'octo/example',
          7,
          'a'.repeat(40),
          'legacy-token',
          1,
          field === 'claimed_at' ? value : '2026-01-01 00:00:00',
          field === 'renewed_at' ? value : '2026-01-01 00:00:00',
          field === 'expires_at' ? value : null,
        );
      legacy.close();

      assert.throws(() => new SqliteStateStore(filename), expected);
      const check = new DatabaseSync(filename);
      const row = check
        .prepare(
          `SELECT claimed_at, renewed_at, expires_at, lease_version
           FROM publication_claims WHERE repository = ? AND pull_request = ?`,
        )
        .get('octo/example', 7);
      check.close();
      assert.deepEqual(
        { ...row },
        {
          claimed_at: field === 'claimed_at' ? value : '2026-01-01 00:00:00',
          renewed_at: field === 'renewed_at' ? value : '2026-01-01 00:00:00',
          expires_at: field === 'expires_at' ? value : null,
          lease_version: 1,
        },
        `${field}: failed migration must not rewrite the row`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite claim migration accepts canonical and legacy UTC leap-day timestamps only', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'work', 'publication-claim-valid-'));
  const cases = [
    {
      label: 'canonical leap day',
      claimedAt: '2024-02-29T23:59:58.123Z',
      renewedAt: '2024-02-29T23:59:59.999Z',
      expiresAt: '2024-03-01T00:04:59.999Z',
      expectedClaimedAt: '2024-02-29T23:59:58.123Z',
      expectedRenewedAt: '2024-02-29T23:59:59.999Z',
      expectedExpiresAt: '2024-03-01T00:04:59.999Z',
    },
    {
      label: 'legacy leap day',
      claimedAt: '2024-02-29 23:59:58',
      renewedAt: '2024-02-29 23:59:59',
      expiresAt: '2024-03-01 00:04:59',
      expectedClaimedAt: '2024-02-29T23:59:58.000Z',
      expectedRenewedAt: '2024-02-29T23:59:59.000Z',
      expectedExpiresAt: '2024-03-01T00:04:59.000Z',
    },
  ] as const;
  try {
    for (const [index, candidate] of cases.entries()) {
      const filename = join(directory, `${index}.sqlite`);
      const legacy = new DatabaseSync(filename);
      legacy.exec(`
        CREATE TABLE publication_claims (
          repository TEXT NOT NULL,
          pull_request INTEGER NOT NULL,
          head_sha TEXT NOT NULL,
          claim_token TEXT NOT NULL,
          generation INTEGER NOT NULL,
          claimed_at TEXT NOT NULL,
          renewed_at TEXT,
          expires_at TEXT,
          lease_version INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (repository, pull_request)
        );
      `);
      legacy
        .prepare(
          `INSERT INTO publication_claims(
             repository, pull_request, head_sha, claim_token, generation,
             claimed_at, renewed_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'octo/example',
          7,
          'a'.repeat(40),
          'legacy-token',
          1,
          candidate.claimedAt,
          candidate.renewedAt,
          candidate.expiresAt,
        );
      legacy.close();
      const store = new SqliteStateStore(filename);
      const check = new DatabaseSync(filename);
      const row = check
        .prepare(
          `SELECT claimed_at, renewed_at, expires_at
           FROM publication_claims WHERE repository = ? AND pull_request = ?`,
        )
        .get('octo/example', 7);
      check.close();
      assert.deepEqual(
        { ...row },
        {
          claimed_at: candidate.expectedClaimedAt,
          renewed_at: candidate.expectedRenewedAt,
          expires_at: candidate.expectedExpiresAt,
        },
        candidate.label,
      );
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite construction closes once on incompatible legacy-comment schema failure', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'work', 'publication-claim-close-'));
  const filename = join(directory, 'incompatible.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(
    'CREATE TABLE runs (repository TEXT NOT NULL, pull_request INTEGER NOT NULL PRIMARY KEY)',
  );
  legacy.close();
  const originalClose = DatabaseSync.prototype.close;
  let closeCalls = 0;
  DatabaseSync.prototype.close = function closeWithCount(this: DatabaseSync): void {
    closeCalls += 1;
    originalClose.call(this);
  };
  try {
    assert.throws(() => new SqliteStateStore(filename), /comment_id/u);
    assert.equal(closeCalls, 1, 'failed construction closes its connection exactly once');
    const check = new DatabaseSync(filename);
    assert.deepEqual(
      {
        ...check.prepare("SELECT type, name FROM sqlite_master WHERE name = 'runs'").get(),
      },
      { type: 'table', name: 'runs' },
    );
    check.close();
    assert.equal(closeCalls, 2, 'inspection connection closes once');

    const store = new SqliteStateStore(':memory:');
    assert.equal(closeCalls, 2, 'successful construction does not close early');
    store.close();
    assert.equal(closeCalls, 3, 'normal close closes exactly once');
  } finally {
    DatabaseSync.prototype.close = originalClose;
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite publication claims reject corrupted live timestamps instead of taking them over', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'work', 'publication-claim-corrupt-'));
  const cases = [
    { field: 'expires_at', value: 'not-a-date' },
    { field: 'expires_at', value: '2026-02-30T00:00:00.000Z' },
    { field: 'expires_at', value: '2026-01-01T00:00:00.000+00:00' },
    { field: 'expires_at', value: '2026-01-01T00:00:00.000' },
    { field: 'expires_at', value: 'January 1, 2026' },
    { field: 'claimed_at', value: '2026-01-01T00:00:60.000Z' },
    { field: 'renewed_at', value: '2026-01-01 25:00:00' },
  ] as const;
  try {
    for (const [index, { field, value }] of cases.entries()) {
      const filename = join(directory, `${index}.sqlite`);
      const now = new Date('2026-01-01T00:01:00.000Z');
      const oldHead = 'a'.repeat(40);
      const newHead = 'b'.repeat(40);
      const store = new SqliteStateStore(filename, () => now);
      try {
        const original = await store.claimPublication?.('octo/example', 7, oldHead);
        assert.ok(original);
        const corrupted = new DatabaseSync(filename);
        corrupted
          .prepare(
            `UPDATE publication_claims SET ${field} = ?
           WHERE repository = ? AND pull_request = ?`,
          )
          .run(value, 'octo/example', 7);
        corrupted.close();

        assert.throws(
          () => store.claimPublication?.('octo/example', 7, newHead),
          new RegExp(`${field} timestamp is invalid`, 'u'),
        );
        assert.throws(
          () => store.renewPublicationClaim?.('octo/example', 7, original),
          new RegExp(`${field} timestamp is invalid`, 'u'),
        );
        const check = new DatabaseSync(filename);
        const row = check
          .prepare(
            `SELECT head_sha, claim_token, generation, lease_version,
                    claimed_at, renewed_at, expires_at
             FROM publication_claims WHERE repository = ? AND pull_request = ?`,
          )
          .get('octo/example', 7);
        check.close();
        assert.equal((row as { head_sha: string }).head_sha, oldHead);
        assert.equal((row as { claim_token: string }).claim_token, original.token);
        assert.equal((row as { generation: number }).generation, 1);
        assert.equal((row as { lease_version: number }).lease_version, 1);
        assert.equal((row as Record<string, unknown>)[field], value);
      } finally {
        store.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite startup normalization waits for a concurrent renewal before reading rows', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'work', 'publication-claim-race-'));
  const filename = join(directory, 'claims.sqlite');
  let worker: Worker | undefined;
  let committed = false;
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE publication_claims (
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        app_id INTEGER,
        head_sha TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        generation INTEGER NOT NULL,
        claimed_at TEXT NOT NULL,
        renewed_at TEXT,
        expires_at TEXT,
        lease_version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (repository, pull_request)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO publication_claims(
           repository, pull_request, head_sha, claim_token, generation,
           claimed_at, renewed_at, expires_at, lease_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'octo/example',
        7,
        'a'.repeat(40),
        'legacy-token',
        1,
        '2026-01-01 00:00:00',
        '2026-01-01 00:00:00',
        '2026-01-01 00:05:00',
        1,
      );
    legacy.close();
    worker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        const database = new DatabaseSync(workerData.filename);
        database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        database.prepare(
          'UPDATE publication_claims SET renewed_at = ?, expires_at = ?, lease_version = ? WHERE repository = ? AND pull_request = ?',
        ).run('2026-01-01T00:01:00.000Z', '2026-01-01T00:06:00.000Z', 2, 'octo/example', 7);
        parentPort.postMessage('locked');
        setTimeout(() => {
          database.exec('COMMIT');
          database.close();
          parentPort.postMessage('committed');
        }, 500);
      `,
      { eval: true, workerData: { filename } },
    );
    const waitFor = (message: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const onMessage = (value: unknown) => {
          if (value === message) {
            if (message === 'committed') committed = true;
            worker?.off('error', onError);
            resolve();
          }
        };
        const onError = (error: Error) => {
          worker?.off('message', onMessage);
          reject(error);
        };
        worker?.on('message', onMessage);
        worker?.once('error', onError);
      });
    await waitFor('locked');

    const store = new SqliteStateStore(filename, () => new Date('2026-01-01T00:01:00.000Z'));
    try {
      await waitFor('committed');
      const check = new DatabaseSync(filename);
      const row = check
        .prepare(
          `SELECT claimed_at, renewed_at, expires_at, lease_version
           FROM publication_claims WHERE repository = ? AND pull_request = ?`,
        )
        .get('octo/example', 7);
      check.close();
      assert.deepEqual(
        { ...row },
        {
          claimed_at: '2026-01-01T00:00:00.000Z',
          renewed_at: '2026-01-01T00:01:00.000Z',
          expires_at: '2026-01-01T00:06:00.000Z',
          lease_version: 2,
        },
      );
    } finally {
      store.close();
    }
  } finally {
    if (worker !== undefined) {
      if (!committed) {
        await new Promise<void>((resolve) => {
          worker?.once('message', (value: unknown) => {
            if (value === 'committed') committed = true;
            resolve();
          });
          worker?.once('error', () => resolve());
        });
      }
      await worker.terminate();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Memory and SQLite publication claims renew atomically and fence every stale identity', async () => {
  const oldHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  for (const [name, createStore] of [
    [
      'memory',
      () => {
        let now = new Date('2026-01-01T00:00:00.000Z');
        return {
          store: new MemoryStateStore(() => now),
          advance: (milliseconds: number) => {
            now = new Date(now.getTime() + milliseconds);
          },
        };
      },
    ],
    [
      'sqlite',
      () => {
        let now = new Date('2026-01-01T00:00:00.000Z');
        return {
          store: new SqliteStateStore(':memory:', () => now),
          advance: (milliseconds: number) => {
            now = new Date(now.getTime() + milliseconds);
          },
        };
      },
    ],
  ] as const) {
    const fixture = createStore();
    const store = fixture.store;
    try {
      const first = await store.claimPublication?.('octo/example', 7, 123, oldHead);
      assert.ok(first, `${name}: initial claim`);
      assert.equal(first.appId, 123);
      assert.equal(first.generation, 1);
      assert.equal(first.leaseVersion, 1);

      // A different App and head cannot evict an unexpired PR-wide owner.
      assert.equal(
        await store.claimPublication?.('octo/example', 7, 456, newHead),
        undefined,
        `${name}: live contender blocked`,
      );

      // Renewal returns a replacement handle and extends the boundary.
      fixture.advance(1);
      const renewed = await store.renewPublicationClaim?.('octo/example', 7, first);
      assert.ok(renewed, `${name}: renewal`);
      assert.equal(renewed.leaseVersion, first.leaseVersion + 1);
      assert.notEqual(renewed.expiresAt, first.expiresAt);
      assert.equal(await store.renewPublicationClaim?.('octo/example', 7, first), undefined);

      // The original five-minute boundary is not enough to take over after a
      // renewal; the renewed boundary remains authoritative.
      fixture.advance(299_999);
      assert.equal(
        await store.claimPublication?.('octo/example', 7, 456, newHead),
        undefined,
        `${name}: contender blocked past original boundary`,
      );
      fixture.advance(1);
      assert.equal(await store.renewPublicationClaim?.('octo/example', 7, renewed), undefined);

      const takeover = await store.claimPublication?.('octo/example', 7, 456, newHead);
      assert.ok(takeover, `${name}: takeover at exact expiry`);
      assert.equal(takeover.generation, first.generation + 1);
      assert.equal(takeover.leaseVersion, 1);
      assert.notEqual(takeover.token, first.token);

      // App/head/token/generation/version mismatches cannot renew or release
      // the new owner, and an old exact handle cannot delete it.
      const mismatches = [
        { ...takeover, appId: 123 },
        { ...takeover, headSha: oldHead },
        { ...takeover, token: first.token },
        { ...takeover, generation: first.generation },
        { ...takeover, leaseVersion: takeover.leaseVersion + 1 },
      ];
      for (const mismatch of mismatches)
        assert.equal(
          await store.renewPublicationClaim?.('octo/example', 7, mismatch),
          undefined,
          `${name}: stale identity rejected`,
        );
      await store.releasePublication?.('octo/example', 7, renewed);
      const successor = await store.renewPublicationClaim?.('octo/example', 7, takeover);
      assert.ok(successor, `${name}: stale release preserved takeover`);
      await store.releasePublication?.('octo/example', 7, successor);
      const afterCleanRelease = await store.claimPublication?.('octo/example', 7, 789, oldHead);
      assert.ok(afterCleanRelease, `${name}: clean release allows reacquisition`);
      assert.equal(afterCleanRelease.generation, takeover.generation + 1);
    } finally {
      if ('close' in store && typeof store.close === 'function') store.close();
    }
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
    testPublicationFence,
  );
  await publishRunResult(
    { repository: 'o/r', pullRequest: 1, headSha: 'h', bundle },
    store,
    github,
    testPublicationFence,
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
        testPublicationFence,
      ),
    /temporary comment failure/u,
  );
  await publishRunResult(
    { repository: 'o/r', pullRequest: 2, headSha: 'h', bundle },
    partialStore,
    partialGithub,
    testPublicationFence,
  );
  assert.deepEqual(partialCalls, [
    'create-check',
    'create-comment',
    'update-check',
    'create-comment',
  ]);

  // A replacement worker must not infer completion from the IDs persisted by
  // webhook reconciliation while the original same-head publication claim is
  // still held. It waits, then acquires and performs the terminal mutations.
  const heldStore = new MemoryStateStore();
  const heldClaim = await heldStore.claimPublication?.('o/r', 3, 'h');
  assert.ok(heldClaim);
  const heldCalls: string[] = [];
  const heldGithub = {
    ...github,
    async createCheck() {
      heldCalls.push('create-check');
      return { id: 31 };
    },
    async createComment() {
      heldCalls.push('create-comment');
      return { id: 32, body: 'managed' };
    },
  };
  const replacement = publishRunFailure(
    { repository: 'o/r', pullRequest: 3, headSha: 'h', error: 'stale failure' },
    heldStore,
    heldGithub,
    testPublicationFence,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(heldCalls, []);
  await heldStore.releasePublication?.('o/r', 3, heldClaim);
  await replacement;
  assert.deepEqual(heldCalls, ['create-check', 'create-comment']);
});

test('publication fence blocks and fences completed publication mutations', async () => {
  const unsigned: Omit<EvidenceBundle, 'integrity'> = {
    schemaVersion: 1,
    product: { name: 'PatchProof', version: '0.1.0' },
    bundleId: 'fence-test',
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
    executions: {
      base: {
        revision: 'base',
        command: ['node'],
        cwd: '.',
        environment: {},
        launcherEnvironment: { omitted: true as const, keys: [], sha256: '0'.repeat(64) },
        exitCode: 1,
        timedOut: false,
        startedAt: '2026-01-01T00:00:00.000Z',
        durationMs: 1,
        stdout: { artifactId: 'out', preview: '', truncated: false, sizeBytes: 0 },
        stderr: { artifactId: 'err', preview: '', truncated: false, sizeBytes: 0 },
      },
      head: {
        revision: 'head',
        command: ['node'],
        cwd: '.',
        environment: {},
        launcherEnvironment: { omitted: true as const, keys: [], sha256: '0'.repeat(64) },
        exitCode: 0,
        timedOut: false,
        startedAt: '2026-01-01T00:00:00.000Z',
        durationMs: 1,
        stdout: { artifactId: 'out', preview: '', truncated: false, sizeBytes: 0 },
        stderr: { artifactId: 'err', preview: '', truncated: false, sizeBytes: 0 },
      },
    },
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
  const calls: string[] = [];
  const github = {
    async createCheck() {
      calls.push('check');
      return { id: 1 };
    },
    async updateCheck() {},
    async createComment() {
      calls.push('comment');
      return { id: 2, body: 'managed' };
    },
    async updateComment() {},
  };
  const rejectedFence = {
    signal: new AbortController().signal,
    async assertOwned(): Promise<void> {
      throw new Error('lease lost');
    },
  };
  const rejectedStore = new MemoryStateStore();
  await assert.rejects(
    () =>
      publishRunResult(
        { repository: 'o/r', pullRequest: 10, headSha: 'h', bundle },
        rejectedStore,
        github,
        rejectedFence,
      ),
    /lease lost/u,
  );
  assert.deepEqual(calls, []);
  assert.equal(await rejectedStore.getRun('o/r', 10), undefined);

  let checkAsserts = 0;
  let resolveCheck!: () => void;
  const checkSettled = new Promise<void>((resolve) => {
    resolveCheck = resolve;
  });
  const checkStore = new MemoryStateStore();
  const checkCalls: string[] = [];
  const checkFence = {
    signal: new AbortController().signal,
    async assertOwned(): Promise<void> {
      checkAsserts += 1;
      if (checkAsserts === 3) throw new Error('lease lost after check');
    },
  };
  const checkGithub = {
    ...github,
    async createCheck() {
      checkCalls.push('check');
      await checkSettled;
      return { id: 3 };
    },
    async createComment() {
      checkCalls.push('comment');
      return { id: 4, body: 'managed' };
    },
  };
  const checkPromise = publishRunResult(
    { repository: 'o/r', pullRequest: 11, headSha: 'h', bundle },
    checkStore,
    checkGithub,
    checkFence,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  resolveCheck();
  await assert.rejects(() => checkPromise, /lease lost after check/u);
  assert.deepEqual(checkCalls, ['check']);
  assert.equal(await checkStore.getRun('o/r', 11), undefined);

  let commentAsserts = 0;
  let resolveComment!: () => void;
  const commentSettled = new Promise<void>((resolve) => {
    resolveComment = resolve;
  });
  const commentStore = new MemoryStateStore();
  const commentCalls: string[] = [];
  const commentFence = {
    signal: new AbortController().signal,
    async assertOwned(): Promise<void> {
      commentAsserts += 1;
      if (commentAsserts === 5) throw new Error('lease lost after comment');
    },
  };
  const commentGithub = {
    ...github,
    async createCheck() {
      commentCalls.push('check');
      return { id: 5 };
    },
    async createComment() {
      commentCalls.push('comment');
      await commentSettled;
      return { id: 6, body: 'managed' };
    },
  };
  const commentPromise = publishRunResult(
    { repository: 'o/r', pullRequest: 12, headSha: 'h', bundle },
    commentStore,
    commentGithub,
    commentFence,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  resolveComment();
  await assert.rejects(() => commentPromise, /lease lost after comment/u);
  assert.deepEqual(commentCalls, ['check', 'comment']);
  assert.deepEqual(await commentStore.getRun('o/r', 12), { checkId: 5 });

  const failureCalls: string[] = [];
  const failureStore = new MemoryStateStore();
  const failureGithub = {
    ...github,
    async createCheck() {
      failureCalls.push('check');
      return { id: 7 };
    },
    async createComment() {
      failureCalls.push('comment');
      return { id: 8, body: 'managed' };
    },
  };
  await assert.rejects(
    () =>
      publishRunFailure(
        { repository: 'o/r', pullRequest: 13, headSha: 'h', error: 'failure' },
        failureStore,
        failureGithub,
        rejectedFence,
      ),
    /lease lost/u,
  );
  assert.deepEqual(failureCalls, []);
  assert.equal(await failureStore.getRun('o/r', 13), undefined);
});
