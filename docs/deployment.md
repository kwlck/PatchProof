# Deployment

Run the webhook app and worker as separate processes with the same durable SQLite path. Put the HTTP process behind TLS termination with a private webhook secret.

```text
PATCHPROOF_WEBHOOK_SECRET=<random value at least 16 characters>
PATCHPROOF_GITHUB_APP_ID=<numeric GitHub App ID>
# The PEM body itself, with newlines encoded as \n escapes.
PATCHPROOF_GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----
PATCHPROOF_SQLITE_PATH=/var/lib/patchproof/patchproof.sqlite
PATCHPROOF_EVIDENCE_ROOT=/var/lib/patchproof/evidence
PATCHPROOF_APPROVED_DOCKER_IMAGES=<image>@sha256:<64 hexadecimal characters>
```

Both processes require `PATCHPROOF_GITHUB_APP_ID` and `PATCHPROOF_GITHUB_APP_PRIVATE_KEY`. No static installation token is read from the environment: each process signs a short-lived JWT with that key and mints its own installation tokens.

The worker also requires `PATCHPROOF_APPROVED_DOCKER_IMAGES` before startup: a comma-separated list of image references pinned by sha256 digest. The worker exits when the variable is absent or any entry lacks a digest pin, so an unpinned image such as `node:24-bookworm-slim` cannot run under it. Repository configurations must select a digest-pinned image from this list.

The worker accepts optional positive-integer ceilings: `PATCHPROOF_MAX_TIMEOUT_MS` (default 120000), `PATCHPROOF_MAX_OUTPUT_BYTES` (16777216), `PATCHPROOF_MAX_MEMORY_MB` (2048), `PATCHPROOF_MAX_CPU_COUNT` (4), `PATCHPROOF_MAX_PIDS` (512), and `PATCHPROOF_PROVISIONING_TIMEOUT_MS` (120000). A repository value above a ceiling is denied at run time, and a malformed value stops the worker at startup. `PATCHPROOF_WORKER_ID` labels lease ownership in SQLite and defaults to `worker-<process id>`.

Start the processes independently:

```text
pnpm --filter @patchproof/github-app start:webhook
pnpm --filter @patchproof/github-app start:worker
```

The webhook process has no Docker socket, source checkout, or repository secret mount. It verifies HMAC, checks slash-command authorization, persists delivery and managed-surface IDs, and inserts a job. The worker owns source fetching, trusted-base config loading, runner invocation, evidence persistence, and GitHub publication. Installation tokens remain in the worker's source adapter and are not passed to an execution container.

The worker uses leases and attempts in SQLite. A stale lease returns to the queue until `maxAttempts` is reached; after the final lease, a replacement worker owns a leased terminal notification and publishes the same INFRA_ERROR surfaces. A newer synchronize job cancels queued or running work for an older head SHA. SIGINT and SIGTERM stop the worker loop; an active job is left to lease recovery if it cannot finish before shutdown.

Operational guidance:

- run the app as a non-root service account;
- keep SQLite on durable local storage or replace `ManagedStateStore` and `RunQueue` with transactional adapters;
- run workers on hosts with a Docker CLI and daemon, with quotas outside the executed container;
- pin the runner image by digest in production and review image updates;
- retain evidence bundles according to repository policy and verify them before external storage;
- publish Check and managed-comment summaries, not unredacted logs.

The built-in transport uses GitHub REST API version `2022-11-28`. Manual credential validation follows the protected same-repository procedure in [Manual GitHub App validation](github-app-validation.md); that document is authoritative for App permissions, environment secrets, and the validation pull request. This repository does not create remote infrastructure.
