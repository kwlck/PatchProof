# Changelog

## 0.1.0 - 2026-08-24

- Initial public implementation of deterministic base/head evidence bundles.
- Added versioned `.patchproof.yml`, Docker/local runner backends, CLI, GitHub webhook/check/comment surfaces, SQLite state adapter, fixtures, and security documentation.
- Added the `setup` command with an environment check and a self-contained fail-to-pass demo, plus checksum verified one-command installers for POSIX shells and Windows PowerShell.
- Hardened scenario secrets through a private env file, bounded git identity probing, worker thread regex evaluation with a deadline, and bounded GitHub API failure diagnostics with secondary rate limit replay.
- Proved the full credentialed GitHub App path live: webhook delivery, durable queue, isolated Docker execution, evidence verification, Check and managed comment publication, and duplicate replay immutability.
- Docker host allowlists remain intentionally refused until an enforcing operator adapter exists.
