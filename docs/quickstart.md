# Quickstart

PatchProof compares two clean directories with one scenario loaded from the trusted configuration. The `fixtures/pass` repository is deterministic and requires no GitHub credentials.

```text
pnpm install --frozen-lockfile
pnpm build
pnpm patchproof validate fixtures/pass/.patchproof.yml
pnpm patchproof run fixtures/pass/local.patchproof.yml --base fixtures/pass/base --head fixtures/pass/head --backend local --allow-unsafe-local --output work/quickstart
pnpm patchproof verify work/quickstart/patchproof.evidence.json
pnpm patchproof replay work/quickstart/patchproof.evidence.json
```

The final `replay` step prints the replay plan and exits without executing; add `--yes --base <dir> --head <dir>` to actually re-run the scenario.

The pull-request fixture `.patchproof.yml` declares the production Docker backend. The checked-in `local.patchproof.yml` is a development copy that opts into the unsafe local process backend; it requires the matching CLI flags shown above.

Use Docker for a real run with the Docker fixture and an available configured image. If Docker is unavailable, that run produces `INFRA_ERROR`; it does not silently fall back to the local process.
