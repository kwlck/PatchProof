import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleWebhook, type WebhookDependencies } from './webhook.js';

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.byteLength;
      if (size > MAX_WEBHOOK_BYTES) {
        rejected = true;
        request.destroy();
        reject(new Error(`Webhook body exceeds ${MAX_WEBHOOK_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createWebhookServer(dependencies: WebhookDependencies) {
  const startedAt = Date.now();
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    // Liveness probe for orchestrators: no internals, no store access.
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({ ok: true, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }),
      );
      return;
    }
    if (request.method !== 'POST' || request.url !== '/webhooks/github') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    try {
      const rawBody = await readBody(request);
      const result = await handleWebhook(
        {
          rawBody,
          signature: firstHeader(request.headers['x-hub-signature-256']),
          deliveryId: firstHeader(request.headers['x-github-delivery']),
          event: firstHeader(request.headers['x-github-event']),
        },
        dependencies,
      );
      response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ message: result.body, enqueued: result.enqueued }));
    } catch (error) {
      // Keep stack traces and credential-bearing provider errors on the
      // operator side only. The HTTP client receives a bounded generic error.
      console.error(
        'PatchProof webhook handling failed',
        error instanceof Error
          ? error.message.replaceAll(/[\r\n]+/gu, ' ').slice(0, 512)
          : 'unknown error',
      );
      // The request may already be destroyed (oversize body, client abort);
      // writing to that socket throws asynchronously, so absorb response
      // errors instead of letting them escape as unhandled events.
      response.on('error', () => undefined);
      if (!response.destroyed) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ message: 'webhook handling failed' }));
      }
    }
  };
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response);
  });
}
