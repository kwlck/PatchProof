import { resolve } from 'node:path';
import { GitHubApiTransport } from './github-api.js';
import { SqliteStateStore } from './sqlite.js';
import { SqliteQueue } from './queue.js';
import { GitHubSourceAdapter } from './source.js';
import { PatchProofWorker } from './worker.js';

const token = process.env.PATCHPROOF_GITHUB_TOKEN;
if (token === undefined || token.length < 16) {
  console.error('PATCHPROOF_GITHUB_TOKEN must be set before starting the worker');
  process.exitCode = 1;
} else {
  const sqlitePath = resolve(process.env.PATCHPROOF_SQLITE_PATH ?? 'work/github-app.sqlite');
  const outputRoot = resolve(process.env.PATCHPROOF_EVIDENCE_ROOT ?? 'work/github-evidence');
  const store = new SqliteStateStore(sqlitePath);
  const queue = new SqliteQueue(sqlitePath);
  const github = new GitHubApiTransport(
    token,
    process.env.PATCHPROOF_GITHUB_API_BASE ?? 'https://api.github.com',
  );
  const worker = new PatchProofWorker({
    queue,
    source: new GitHubSourceAdapter(token),
    store,
    github,
    outputRoot,
    workerId: process.env.PATCHPROOF_WORKER_ID ?? `worker-${process.pid}`,
    ...(process.env.PATCHPROOF_RUNNER_BACKEND === 'local'
      ? { backendOverride: 'local' as const }
      : {}),
    allowUnsafeLocal: process.env.PATCHPROOF_ALLOW_UNSAFE_LOCAL === 'true',
  });
  const shutdown = (): void => worker.stop();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await worker.runForever();
  } finally {
    queue.close();
    store.close();
  }
}
