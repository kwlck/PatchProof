# CLI reference

`patchproof` emits human output for terminals and stable JSON when `--json` is supplied. It honors `NO_COLOR` and never treats a non-TTY as interactive.

| Command                                | Purpose                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [dir] [--template node]`         | Scaffold a working Node example, or pass `--template python`; existing files are preserved.                                                                                     |
| `validate <file>`                      | Parse YAML, apply defaults, and validate semantics.                                                                                                                             |
| `preflight <file> --base --head`       | Check sources, trusted scenario, and backend readiness without running the scenario. Supports git refs and `--git-repo`.                                                        |
| `run <file> --base <dir> --head <dir>` | Run the trusted scenario against both revisions and write evidence.                                                                                                             |
| `runs list/show/compare`               | List verified local runs, show one bundle, or compare two; `--root <dir>` selects another history root.                                                                         |
| `verify <bundle>`                      | Verify schema, canonical digest, artifact integrity, and completeness without running code.                                                                                     |
| `replay <bundle>`                      | Show a replay plan; add `--yes --base <dir> --head <dir>` to execute it.                                                                                                        |
| `doctor`                               | Report Node, pnpm, Docker, and local SQLite capability.                                                                                                                         |
| `setup`                                | Report the environment, optionally set up Docker with confirmation, or run a fail-to-pass demo with `--demo`. `--app` registers GitHub App credentials. See `--help` for flags. |

Run exit codes are `0` PASS, `1` FAIL, `2` INCONCLUSIVE or invalid input, `3` POLICY_DENIED, and `4` INFRA_ERROR. `verify` returns `0` only for a valid bundle and `2` otherwise.

The local backend requires `policy.allowUnsafeLocal: true` in the trusted config. To override a Docker config, use `--backend local --allow-unsafe-local`; the flag alone does not change the backend. Git refs load the config from the base commit. Fork runs require `--trusted-base <dir>`. By default every run writes to a unique evidence directory, and an explicit `--output` refuses to replace existing evidence.
