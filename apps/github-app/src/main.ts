import { createWebhookServer } from './server.js';
import { SqliteStateStore } from './sqlite.js';
import { GitHubApiTransport } from './github-api.js';
import { SqliteQueue } from './queue.js';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  GitHubAppAuth,
  appCredentialsFromEnvironment,
  type GitHubAppCredentials,
} from './github-auth.js';

const port = Number(process.env.PORT ?? 3000);
const secret = process.env.PATCHPROOF_WEBHOOK_SECRET;
const apiBase = process.env.PATCHPROOF_GITHUB_API_BASE ?? 'https://api.github.com';
let credentials: GitHubAppCredentials | undefined;
try {
  credentials = appCredentialsFromEnvironment();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'GitHub App credentials are invalid');
}
if (credentials === undefined && process.env.PATCHPROOF_GITHUB_DEV_STATIC_TOKEN !== undefined) {
  console.error(
    'PATCHPROOF_GITHUB_DEV_STATIC_TOKEN is intentionally unsupported by the production webhook entrypoint; use an explicit test adapter',
  );
}
if (secret === undefined || secret.length < 16 || credentials === undefined) {
  console.error(
    'PATCHPROOF_WEBHOOK_SECRET, PATCHPROOF_GITHUB_APP_ID, and PATCHPROOF_GITHUB_APP_PRIVATE_KEY must be set before starting the app',
  );
  process.exitCode = 1;
} else {
  const sqlitePath = resolve(process.env.PATCHPROOF_SQLITE_PATH ?? 'work/github-app.sqlite');
  await mkdir(dirname(sqlitePath), { recursive: true, mode: 0o700 });
  const store = new SqliteStateStore(sqlitePath);
  const queue = new SqliteQueue(sqlitePath, () => new Date(), { requireInstallationId: true });
  const github = new GitHubApiTransport(new GitHubAppAuth(credentials, { apiBase }), apiBase);
  const server = createWebhookServer({
    webhookSecret: secret,
    store,
    github,
    async enqueue(request) {
      await queue.enqueue(request);
    },
    cancelPullRequest: async (repository, pullRequest, reason) =>
      queue.cancelPullRequest(repository, pullRequest, reason),
    requireInstallationId: true,
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
