# Threat model

## Assets

Repository secrets and write-capable tokens, the evidence claim, GitHub pull request state, queue and run state, source trees, logs, and the host/container boundary.

## Adversaries

- a fork author controlling source, configuration, titles, comments, logs, archives, and command arguments;
- a compromised dependency, source archive, or Docker image;
- a replay operator attempting to turn a bundle into a trusted execution;
- a network attacker targeting the webhook or GitHub API token;
- a malicious artifact path or symlink attempting to make verification read outside the bundle;
- a stale or duplicated worker attempting to publish an obsolete head result.

## Controls

Webhook HMAC is checked before JSON parsing and compared in constant time. Delivery IDs are persisted only after an actionable event is validated and enqueued, so a failed issue-comment ref lookup can be retried. Slash commands require OWNER, MEMBER, or COLLABORATOR association. Fork metadata is fail-closed when head repository metadata is absent. The worker loads executable configuration from the trusted base checkout. The webhook process does not import the runner or execute repository code.

The production runner uses Docker argv with no shell, network disabled by default, a non-root user, dropped capabilities, no-new-privileges, read-only root where configured, explicit mounts, and bounded resources. It has no Docker socket or host secret mount inside the executed container. The GitHub source adapter runs outside that container, fetches an exact SHA, and keeps the installation token in its own process environment.

Paths reject traversal and symlink escape. Logs use a streaming redactor that keeps unresolved candidates bounded and applies the byte limit after redaction. Evidence verification performs strict recursive schema validation, canonical SHA-256 verification, artifact size and hash checks, unique cross-reference checks, and deterministic outcome recomputation without executing repository code.

Evidence records scenario-visible environment values only. Host launcher values such as `PATH` and `SystemRoot` are omitted, with sorted key names and a metadata hash retained for provenance. Source and replay locations use stable labels rather than host paths. Docker evidence identifies the declared container image and marks platform fields as container-scoped.

SQLite queue leases, attempts, cancellation, and synchronize supersession prevent a stale worker from silently replacing newer work. Publication uses the persisted Check and managed-comment IDs.

## Residual risk and non-goals

The host kernel, Docker daemon, image supply chain, GitHub installation, and operator-provided network adapters remain trusted dependencies. A trusted base branch can still contain an unsafe scenario; PatchProof records what it ran rather than proving scenario quality. Hashes do not identify a signer. The local backend is not a security boundary. Network allowlists are refused until an enforcing adapter exists. Replay requires human confirmation, operator-supplied source directories, and reports environmental drift. A standalone bundle does not reconstruct a checkout.
