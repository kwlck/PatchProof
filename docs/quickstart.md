# Quickstart

PatchProof compares two clean directories with one scenario loaded from the trusted configuration. The `fixtures/pass` repository is deterministic and requires no GitHub credentials.

```text
pnpm install --frozen-lockfile
pnpm build
pnpm patchproof validate fixtures/pass/.patchproof.yml
pnpm patchproof run fixtures/pass/.patchproof.yml --base fixtures/pass/base --head fixtures/pass/head --backend local --allow-unsafe-local --output work/quickstart
pnpm patchproof verify work/quickstart/patchproof.evidence.json
pnpm patchproof replay work/quickstart/patchproof.evidence.json
```

Use Docker for a real run by removing the backend override and ensuring the configured image is available. If Docker is unavailable, the default run produces `INFRA_ERROR`; it does not silently fall back to the local process.
