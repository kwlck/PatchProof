import { get as httpGet, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookServer } from '../apps/github-app/dist/server.js';
import { MemoryStateStore } from '@patchproof/github';
import { GitHubApiTransport } from '../apps/github-app/dist/github-api.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return (server.address() as AddressInfo).port;
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveGet, rejectGet) => {
    const request = httpGet({ host: '127.0.0.1', port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolveGet({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.on('error', rejectGet);
  });
}

function startServer(): { server: Server; ready: Promise<number> } {
  const store = new MemoryStateStore();
  const transport = new GitHubApiTransport('test-token');
  const server = createWebhookServer({
    webhookSecret: 'x'.repeat(32),
    store,
    github: transport,
    enqueue: async () => undefined,
  });
  return { server, ready: listen(server) };
}

test('healthz reports liveness without internals', async () => {
  const { server, ready } = startServer();
  const port = await ready;
  try {
    const response = await get(port, '/healthz');
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body) as { ok: boolean; uptimeSeconds: number };
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.uptimeSeconds, 'number');
  } finally {
    server.close();
  }
});

test('unknown routes fail closed with 404', async () => {
  const { server, ready } = startServer();
  const port = await ready;
  try {
    assert.equal((await get(port, '/')).status, 404);
    assert.equal((await get(port, '/webhooks/github')).status, 404);
    assert.equal((await get(port, '/admin')).status, 404);
  } finally {
    server.close();
  }
});

test('oversize webhook bodies are rejected without a response hang', async () => {
  const { server, ready } = startServer();
  const port = await ready;
  try {
    const body = 'x'.repeat(3 * 1024 * 1024);
    const outcome = await new Promise<{ error?: string; status?: number }>((resolve) => {
      const request = httpGet(
        {
          host: '127.0.0.1',
          port,
          path: '/webhooks/github',
          method: 'POST',
          headers: { 'content-length': String(body.length) },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve({ status: response.statusCode ?? 0 }));
        },
      );
      request.on('error', (error: Error) => resolve({ error: error.name }));
      request.end(body);
    });
    assert.ok(
      outcome.error !== undefined || (outcome.status !== undefined && outcome.status >= 400),
      `expected rejection, got ${JSON.stringify(outcome)}`,
    );
  } finally {
    server.close();
  }
});
