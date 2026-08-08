import { createWebhookServer } from './server.js';
import { SqliteStateStore } from './sqlite.js';
import { GitHubApiTransport } from './github-api.js';
import { SqliteQueue } from './queue.js';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const port = Number(process.env.PORT ?? 3000);
const secret = process.env.PATCHPROOF_WEBHOOK_SECRET;
const token = process.env.PATCHPROOF_GITHUB_TOKEN;
if (secret === undefined || secret.length < 16 || token === undefined || token.length < 16) {
  console.error(
    'PATCHPROOF_WEBHOOK_SECRET and PATCHPROOF_GITHUB_TOKEN must be set before starting the app',
  );
  process.exitCode = 1;
} else {
  const sqlitePath = resolve(process.env.PATCHPROOF_SQLITE_PATH ?? 'work/github-app.sqlite');
  await mkdir(dirname(sqlitePath), { recursive: true });
  const store = new SqliteStateStore(sqlitePath);
  const queue = new SqliteQueue(sqlitePath);
  const github = new GitHubApiTransport(
    token,
    process.env.PATCHPROOF_GITHUB_API_BASE ?? 'https://api.github.com',
  );
  const server = createWebhookServer({
    webhookSecret: secret,
    store,
    github,
    async enqueue(request) {
      await queue.enqueue(request);
    },
  });
  server.listen(port, () => console.log(`PatchProof GitHub App listening on ${port}`));
  const shutdown = (): void => {
    server.close(() => {
      queue.close();
      store.close();
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
