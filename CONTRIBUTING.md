# Contributing to PatchProof

PatchProof is a security-sensitive evidence system. Start with a small issue or discussion, explain the trust boundary affected by a change, and include tests for every changed claim.

Before opening a change:

```text
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm docs:check
pnpm editorial:check
```

Use argv arrays and explicit interfaces. Do not add shell interpolation, secrets, remote services, model dependencies, or claims of signing/attestation without a design record. Changes to Docker policy, redaction, webhook verification, evidence verification, or fork trust must include a regression test and an update to [the threat model](docs/threat-model.md).

The project uses conventional commits for changelog readability. Release versions are tracked through the changeset-style notes in `.changeset/` and `CHANGELOG.md`; no publish or remote release is performed by local development commands.
