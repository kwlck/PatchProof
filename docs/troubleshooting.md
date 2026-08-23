# Troubleshooting

## `INFRA_ERROR` with Docker

Run `patchproof doctor --json`. Docker must be installed, the daemon must be reachable, and the configured image must be available. PatchProof will not silently fall back to the local backend. Use `--backend local --allow-unsafe-local` only for controlled development.

## `POLICY_DENIED`

Check `policy.allowUnsafeLocal`, `--allow-unsafe-local`, `policy.allowFork`, and `--trusted-base`. A denied run is a reportable result, not a failed assertion.

## `INCONCLUSIVE`

The base may already pass, the configured reason may not match, a timeout may have occurred, or evidence may be incomplete. Inspect the redacted artifacts and verify result; do not interpret it as proof of a fix.

## Invalid evidence

Do not edit the JSON by hand. Re-run the producing command or restore the exact artifacts. `verify` reports digest, completeness, and artifact-specific failures without executing repository code.

## Webhook refuses to start with `PATCHPROOF_GITHUB_DEV_STATIC_TOKEN`

The production webhook entrypoint intentionally does not support a static token. Remove the variable and provide `PATCHPROOF_GITHUB_APP_ID` plus `PATCHPROOF_GITHUB_APP_PRIVATE_KEY`; offline tests use explicit fakes instead of this variable.
