import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { GitHubApiTransport } from './github-api.js';
import { SqliteStateStore } from './sqlite.js';
import { SqliteQueue } from './queue.js';
import { GitHubSourceAdapter } from './source.js';
import { PatchProofWorker } from './worker.js';
import {
  GitHubAppAuth,
  appCredentialsFromEnvironment,
  type GitHubAppCredentials,
} from './github-auth.js';
import { parseWorkerOperatorPolicy } from './worker-policy.js';
import type { OperatorPolicyInput } from '@patchproof/runner';

let credentials: GitHubAppCredentials | undefined;
try {
  credentials = appCredentialsFromEnvironment();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'GitHub App credentials are invalid');
}
let operatorPolicy: OperatorPolicyInput | undefined;
try {
  operatorPolicy = parseWorkerOperatorPolicy();
} catch {
  // Keep startup diagnostics generic: no environment value or credential is
  // included in operator-facing output.
  console.error('Worker operator policy configuration is invalid');
}
if (credentials === undefined) {
  console.error(
    'PATCHPROOF_GITHUB_APP_ID and PATCHPROOF_GITHUB_APP_PRIVATE_KEY must be set before starting the worker',
  );
  process.exitCode = 1;
} else if (operatorPolicy === undefined) {
  process.exitCode = 1;
} else {
  const sqlitePath = resolve(process.env.PATCHPROOF_SQLITE_PATH ?? 'work/github-app.sqlite');
  const outputRoot = resolve(process.env.PATCHPROOF_EVIDENCE_ROOT ?? 'work/github-evidence');
  await mkdir(dirname(sqlitePath), { recursive: true, mode: 0o700 });
  const store = new SqliteStateStore(sqlitePath);
  const auth = new GitHubAppAuth(credentials);
  const queue = new SqliteQueue(sqlitePath, () => new Date(), {
    requireInstallationId: true,
  });
  const github = new GitHubApiTransport(auth);
  const worker = new PatchProofWorker({
    queue,
    source: new GitHubSourceAdapter(auth),
    store,
    github,
    outputRoot,
    workerId: process.env.PATCHPROOF_WORKER_ID ?? `worker-${process.pid}`,
    operatorPolicy,
    requireFreshSnapshot: true,
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
