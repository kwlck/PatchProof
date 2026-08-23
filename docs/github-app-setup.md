# GitHub App setup

Create an internal or public GitHub App with the smallest permissions needed by the deployment:

- Pull requests: read (to read base/head metadata).
- Issues: read/write (to create/update the one managed summary comment).
- Checks: read/write (to create/update the PatchProof Check Run).
- Contents: read (to fetch the trusted base and head sources through a worker).
- Metadata: read.

Subscribe to `Pull request` and `Issue comment` events. Configure `PATCHPROOF_WEBHOOK_SECRET`, `PATCHPROOF_GITHUB_APP_ID`, and `PATCHPROOF_GITHUB_APP_PRIVATE_KEY`; both processes sign a short-lived JWT and mint their own installation tokens from the App credentials. The webhook and worker share `PATCHPROOF_SQLITE_PATH`. The worker writes evidence below `PATCHPROOF_EVIDENCE_ROOT`, fetches exact source SHAs, and loads configuration from base. Installation tokens remain in the worker's source adapter and are not passed to the execution container.

The production worker also requires `PATCHPROOF_APPROVED_DOCKER_IMAGES`, a comma-separated list of digest-pinned image references, at startup and accepts optional operator ceilings (`PATCHPROOF_MAX_TIMEOUT_MS`, `PATCHPROOF_MAX_OUTPUT_BYTES`, `PATCHPROOF_MAX_MEMORY_MB`, `PATCHPROOF_MAX_CPU_COUNT`, `PATCHPROOF_MAX_PIDS`, `PATCHPROOF_PROVISIONING_TIMEOUT_MS`) documented in [Deployment](deployment.md).

The webhook service listens on `POST /webhooks/github`. Verify the `X-Hub-Signature-256` header before parsing the body. `/patchproof run` accepts only OWNER, MEMBER, or COLLABORATOR comment associations. Start the webhook and worker separately with `pnpm --filter @patchproof/github-app start:webhook` and `pnpm --filter @patchproof/github-app start:worker`. Manual credential validation is deliberately not part of automated tests; use the protected same-repository procedure in [Manual GitHub App validation](github-app-validation.md), inspect the Check, managed markers, duplicate delivery behavior, queue state, and worker logs, and do not use a third-party fork.
