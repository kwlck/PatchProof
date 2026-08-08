# GitHub App setup

Create an internal or public GitHub App with the smallest permissions needed by the deployment:

- Pull requests: read (to read base/head metadata).
- Issues: read/write (to create/update the one managed summary comment).
- Checks: read/write (to create/update the PatchProof Check Run).
- Contents: read (to fetch the trusted base and head sources through a worker).
- Metadata: read.

Subscribe to `Pull request` and `Issue comment` events. Configure `PATCHPROOF_WEBHOOK_SECRET` and `PATCHPROOF_GITHUB_TOKEN` (or replace the built-in transport with an installation-token provider). The webhook and worker share `PATCHPROOF_SQLITE_PATH`. The worker writes evidence below `PATCHPROOF_EVIDENCE_ROOT`, fetches exact source SHAs, and loads configuration from base. The GitHub token is used by the source adapter and is not passed to the execution container.

The webhook service listens on `POST /webhooks/github`. Verify the `X-Hub-Signature-256` header before parsing the body. `/patchproof run` accepts only OWNER, MEMBER, or COLLABORATOR comment associations. Start the webhook and worker separately with `pnpm --filter @patchproof/github-app start:webhook` and `pnpm --filter @patchproof/github-app start:worker`. Manual credential validation is deliberately not part of automated tests; use a private test repository and inspect the Check, managed markers, duplicate delivery behavior, queue state, and worker logs.
