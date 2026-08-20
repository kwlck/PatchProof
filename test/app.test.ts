import { createServer } from 'node:http';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { handleWebhook } from '../apps/github-app/dist/webhook.js';
import { GitHubApiTransport } from '../apps/github-app/dist/github-api.js';
import { GitHubAppAuth, createGitHubAppJwt } from '../apps/github-app/dist/github-auth.js';
import { SqliteStateStore } from '../apps/github-app/dist/sqlite.js';
import { publishRunFailure, publishRunResult } from '../apps/github-app/dist/publisher.js';
import { computeWebhookSignature, MemoryStateStore } from '@patchproof/github';
import { createIntegrity, type EvidenceBundle } from '@patchproof/core';

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

test('GitHub mutation transport forwards and honors AbortSignal', async () => {
  const originalFetch = globalThis.fetch;
  const observed: Array<AbortSignal | undefined> = [];
  globalThis.fetch = async (_input, init) => {
    observed.push(init?.signal);
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    return new Response(JSON.stringify({ id: 17, body: 'managed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const transport = new GitHubApiTransport('test-token', 'http://github.test');
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
    assert.equal(observed[0], controller.signal);
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
    assert.equal(observed[1], controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
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
  globalThis.fetch = async (input, init) => {
    calls += 1;
    requestedInstallations.push(Number(String(input).match(/installations\/(\d+)/u)?.[1]));
    assert.equal(init?.method, 'POST');
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
      { apiBase: 'http://github.test', safetyMarginMs: 60_000, clock: () => now },
    );
    assert.equal(await auth.getToken(10), 'installation-token-10');
    assert.equal(await auth.getToken(10), 'installation-token-10');
    assert.equal(await auth.getToken(11), 'installation-token-11');
    assert.equal(calls, 2);
    now.setTime(now.getTime() + 240_000);
    assert.equal(await auth.getToken(10), 'installation-token-10');
    assert.equal(calls, 3);
    assert.deepEqual(requestedInstallations, [10, 11, 10]);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => auth.getToken(12, { signal: controller.signal }), /aborted/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GitHub transport uses external_id and fails closed on spoofed managed comments', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const provider = {
    requiresInstallationId: false as const,
    appId: 123,
    getToken: async () => 'development-token',
  };
  let commentMode: 'spoofed' | 'owned' | 'invalid' = 'spoofed';
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    requests.push({
      path,
      ...(typeof init?.body === 'string'
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    });
    if (path.endsWith('/check-runs') && method === 'POST')
      return new Response(JSON.stringify({ id: 7 }), { status: 201 });
    if (path.endsWith('/check-runs') && method === 'GET') {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('check_name'), 'PatchProof');
      assert.equal(url.searchParams.get('filter'), 'all');
      assert.equal(url.searchParams.get('app_id'), '123');
      assert.equal(url.searchParams.get('per_page'), '100');
      assert.equal(url.searchParams.get('page'), '1');
      return new Response(
        JSON.stringify({
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
        { status: 200 },
      );
    }
    if (path.includes('/comments')) {
      if (commentMode === 'invalid')
        return new Response(JSON.stringify({ comments: true }), { status: 200 });
      return new Response(
        JSON.stringify([
          {
            id: commentMode === 'spoofed' ? 12 : 13,
            body: '<!-- patchproof:summary:start -->managed<!-- patchproof:summary:end -->',
            performed_via_github_app: { id: commentMode === 'spoofed' ? 999 : 123 },
          },
        ]),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ id: 1, body: 'ok' }), { status: 200 });
  };
  try {
    const transport = new GitHubApiTransport(provider, 'http://github.test');
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
    globalThis.fetch = originalFetch;
  }
});

test('GitHub Check reconciliation recovers an accepted create after an ambiguous timeout', async () => {
  const originalFetch = globalThis.fetch;
  const headSha = 'a'.repeat(40);
  const externalId = `patchproof:octo/example#7:${headSha}`;
  let createRequests = 0;
  let listRequests = 0;
  const provider = {
    requiresInstallationId: false as const,
    appId: 123,
    getToken: async () => 'development-token',
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'POST' && url.pathname.endsWith('/check-runs')) {
      createRequests += 1;
      // Model GitHub accepting the request while the client times out before
      // receiving the response. The next owner must reconcile, not create.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response(JSON.stringify({ id: 101 }), { status: 201 });
    }
    if (init?.method === 'GET' && url.pathname.endsWith('/check-runs')) {
      listRequests += 1;
      assert.equal(url.searchParams.get('check_name'), 'PatchProof');
      assert.equal(url.searchParams.get('filter'), 'all');
      assert.equal(url.searchParams.get('app_id'), '123');
      assert.equal(url.searchParams.get('per_page'), '100');
      assert.equal(url.searchParams.get('page'), '1');
      return new Response(
        JSON.stringify({
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
        { status: 200 },
      );
    }
    throw new Error(`unexpected GitHub request: ${init?.method ?? 'GET'} ${url.pathname}`);
  };
  try {
    const transport = new GitHubApiTransport(provider, 'http://github.test', 1);
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
    globalThis.fetch = originalFetch;
  }
});

test('managed comment reconciliation paginates to page two and stops at a hard bound', async () => {
  const originalFetch = globalThis.fetch;
  const pages: number[] = [];
  const provider = {
    requiresInstallationId: false as const,
    appId: 123,
    getToken: async () => 'development-token',
  };
  globalThis.fetch = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get('page'));
    pages.push(page);
    if (page === 1)
      return new Response(
        JSON.stringify(
          Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            body: 'unmanaged',
            performed_via_github_app: { id: 999 },
          })),
        ),
        { status: 200 },
      );
    if (page === 2)
      return new Response(
        JSON.stringify([
          {
            id: 202,
            body: '<!-- patchproof:summary:start -->managed<!-- patchproof:summary:end -->',
            performed_via_github_app: { id: 123 },
          },
        ]),
        { status: 200 },
      );
    return new Response(JSON.stringify([]), { status: 200 });
  };
  try {
    const transport = new GitHubApiTransport(provider, 'http://github.test');
    assert.equal((await transport.findManagedComment('octo/example', 7))?.id, 202);
    assert.deepEqual(pages, [1, 2]);

    pages.length = 0;
    globalThis.fetch = async () => {
      pages.push(1);
      return new Response(JSON.stringify(Array.from({ length: 100 }, () => ({}))), {
        status: 200,
      });
    };
    await assert.rejects(
      () => transport.findManagedComment('octo/example', 7),
      /comment reconciliation was incomplete/u,
    );
    assert.equal(pages.length, 20);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('managed Check reconciliation follows total_count beyond the first 100 runs', async () => {
  const originalFetch = globalThis.fetch;
  const pages: number[] = [];
  const provider = {
    requiresInstallationId: false as const,
    appId: 123,
    getToken: async () => 'development-token',
  };
  const headSha = 'a'.repeat(40);
  globalThis.fetch = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get('page'));
    pages.push(page);
    if (page === 1)
      return new Response(
        JSON.stringify({
          total_count: 101,
          check_runs: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            name: 'Other check',
            external_id: `other-${index}`,
            head_sha: headSha,
            app: { id: 456 },
          })),
        }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({
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
      { status: 200 },
    );
  };
  try {
    const transport = new GitHubApiTransport(provider, 'http://github.test');
    assert.equal((await transport.findManagedCheck('octo/example', 7, headSha))?.id, 202);
    assert.deepEqual(pages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
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
