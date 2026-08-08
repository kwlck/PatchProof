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
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
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
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({
          message: 'webhook handling failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response);
  });
}
