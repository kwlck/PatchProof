# Contributor guide

Keep packages small and dependency-light. Domain semantics belong in `packages/core`; transport belongs in `packages/github` or an app adapter; execution belongs in `packages/runner`; presentation belongs in `packages/report`.

When adding an exported type, document its security and determinism assumptions. When changing a schema, add a versioned fixture and a negative verification test. When touching subprocess or filesystem code, prove argv-only execution, traversal rejection, timeout behavior, cleanup, and bounded output.

The repository has no required GitHub credentials. Prefer offline fixtures and mocks. `pnpm test:docker` runs the CLI Docker path and the webhook-to-worker Docker path on Docker-capable CI; record availability rather than treating an unavailable daemon as a pass.
