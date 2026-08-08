# Deployment

Run the webhook app and worker as separate processes with the same durable SQLite path. Put the HTTP process behind TLS termination with a private webhook secret and an installation-scoped token.

```text
PATCHPROOF_WEBHOOK_SECRET=<random value at least 16 characters>
PATCHPROOF_GITHUB_TOKEN=<installation token>
PATCHPROOF_SQLITE_PATH=/var/lib/patchproof/patchproof.sqlite
PATCHPROOF_EVIDENCE_ROOT=/var/lib/patchproof/evidence
```

Start the processes independently:

```text
pnpm --filter @patchproof/github-app start:webhook
pnpm --filter @patchproof/github-app start:worker
```

The webhook process has no Docker socket, source checkout, or repository secret mount. It verifies HMAC, checks slash-command authorization, persists delivery and managed-surface IDs, and inserts a job. The worker owns source fetching, trusted-base config loading, runner invocation, evidence persistence, and GitHub publication. The GitHub token remains in the worker's source adapter and is not passed to an execution container.

The worker uses leases and attempts in SQLite. A stale lease returns to the queue until `maxAttempts` is reached; after the final lease, a replacement worker owns a leased terminal notification and publishes the same INFRA_ERROR surfaces. A newer synchronize job cancels queued or running work for an older head SHA. SIGINT and SIGTERM stop the worker loop; an active job is left to lease recovery if it cannot finish before shutdown.

Operational guidance:

- run the app as a non-root service account;
- keep SQLite on durable local storage or replace `ManagedStateStore` and `RunQueue` with transactional adapters;
- run workers on hosts with a Docker CLI and daemon, with quotas outside the executed container;
- pin the runner image by digest in production and review image updates;
- retain evidence bundles according to repository policy and verify them before external storage;
- publish Check and managed-comment summaries, not unredacted logs.

The built-in transport uses GitHub REST API version `2022-11-28`. Manual credential validation should use a private test repository and least-privilege installation. This repository does not create remote infrastructure.
