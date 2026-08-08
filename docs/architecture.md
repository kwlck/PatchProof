# Architecture

PatchProof has four boundaries:

1. GitHub and pull request content are untrusted input. The webhook process authenticates deliveries, authorizes commands, creates the managed Check and comment, and writes a durable queue job.
2. SQLite stores delivery IDs, managed surface IDs, and job state. Queue leases make retries and stale-worker recovery explicit.
3. A separate worker fetches exact source SHAs and loads `.patchproof.yml` from the base checkout. The webhook process has no runner import and never executes repository code.
4. The runner materializes clean workspaces and executes the same trusted argv for base and head. Docker is the default boundary. The local process backend is an explicit unsafe adapter for development and tests.

```mermaid
sequenceDiagram
  participant G as GitHub
  participant A as Webhook app
  participant S as SQLite
  participant W as Worker
  participant F as Source adapter
  participant R as Runner
  participant V as Verifier
  G->>A: signed pull_request or issue_comment
  A->>S: delivery, Check/comment IDs, queued job
  W->>S: claim job lease
  W->>F: fetch exact base/head SHAs
  F-->>W: clean source directories
  W->>W: load config from trusted base
  W->>R: run identical scenario twice
  R-->>W: executions and bounded redacted logs
  W->>S: evidence path, outcome, job state
  W->>G: update Check and managed comment
  V->>V: schema, digest, artifact, and semantic checks
```

The evidence bundle is the handoff between the worker and verifier. Its SHA-256 digest covers canonical version-1 fields and is not a signer identity. `patchproof replay --yes --base <dir> --head <dir>` requires confirmation because it executes code again and reports environmental differences.
