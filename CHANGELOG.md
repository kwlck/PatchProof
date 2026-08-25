# Changelog

## 0.3.0 - 2026-08-25

- Added the interactive GitHub App wizard: `patchproof setup --app` drives the official App Manifest flow, exchanges the one-time callback code for App credentials, writes a 0600 env file, and detects the installation automatically, turning a fifteen minute documented procedure into two clicks.

## 0.2.0 - 2026-08-25

- Added the optional `patchproof draft` command: given a fix diff and a bug report, an OpenAI model drafts a `.patchproof.yml` and scenario file, which are validated before use. Strictly bring your own key through `OPENAI_API_KEY`; without it the command only explains the manual path and nothing is sent anywhere.
- Hardened reliability from a full code review: the worker daemon survives queue faults instead of crash-looping, hourly retention pruning bounds SQLite growth, a pull request closed after its fork was deleted now fences workers and finalizes the stored Check, evidence bundles are written atomically, and the CLI rejects unknown flags instead of ignoring typos.
- Bounded GitHub transport replay to true secondary rate limits, scrubbed the basic header form of source credentials, neutralized managed markers in success comments, and added operator policy hard maxima plus bounded shutdown deadlines.

## 0.1.0 - 2026-08-24

- Initial public implementation of deterministic base/head evidence bundles.
- Added versioned `.patchproof.yml`, Docker/local runner backends, CLI, GitHub webhook/check/comment surfaces, SQLite state adapter, fixtures, and security documentation.
- Added the `setup` command with an environment check and a self-contained fail-to-pass demo, plus checksum verified one-command installers for POSIX shells and Windows PowerShell.
- Hardened scenario secrets through a private env file, bounded git identity probing, worker thread regex evaluation with a deadline, and bounded GitHub API failure diagnostics with secondary rate limit replay.
- Proved the full credentialed GitHub App path live: webhook delivery, durable queue, isolated Docker execution, evidence verification, Check and managed comment publication, and duplicate replay immutability.
- Docker host allowlists remain intentionally refused until an enforcing operator adapter exists.
