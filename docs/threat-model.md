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

The production runner uses Docker argv with no shell, network disabled by default, a non-root user, dropped capabilities, no-new-privileges, read-only root where configured, explicit mounts, bounded resources, and swap disabled at the memory ceiling. Scenario environment values are written to a private 0600 env file under a generated state directory and passed through `--env-file`, so they never appear in host process argv; the file is removed in the cleanup path. It has no Docker socket or host secret mount inside the executed container. The GitHub source adapter runs outside that container, fetches an exact SHA, and keeps the installation token in its own process environment.

On POSIX hosts, the generated temporary parent remains private at 0700. Only the directly mounted base and head workspace trees are normalized for UID 65532, with directories set to 0755 and regular files set to 0644 or 0755 when they were already executable. Docker mounts those trees read-only, and the runner removes the generated parent in a finally cleanup path. This leaves a short-lived host-side read surface for a caller that already knows a mounted workspace path; the Docker daemon and host remain trusted dependencies.

Paths reject traversal and symlink escape, and artifact verification accepts only regular files, rejecting symbolic links and special files. Logs use a streaming redactor that keeps unresolved candidates bounded and applies the byte limit after redaction. Evidence verification performs strict recursive schema validation, canonical SHA-256 verification, artifact size and hash checks, unique cross-reference checks, and deterministic outcome recomputation without executing repository code. Outcome recomputation evaluates untrusted configured patterns against recorded output inside a worker thread terminated at a fixed wall-clock deadline, so catastrophic backtracking fails verification instead of blocking it; classification during replay and evidence writing uses the same guard, and outcomes that cannot depend on the patterns skip pattern evaluation entirely.

Evidence records scenario-visible environment values only. Host launcher values such as `PATH` and `SystemRoot` are omitted, with sorted key names and a metadata hash retained for provenance. Source and replay locations use stable labels rather than host paths. Docker evidence identifies the declared container image and marks platform fields as container-scoped.

The manual App validation workflow is isolated in a separate `app-validation` environment restricted to `main`. During the solo-maintainer phase, `kwlck` is the required reviewer, the wait timer is zero, and self-review prevention is intentionally disabled. This approval is a deliberate checkpoint against accidental execution, not independent review or account-compromise protection. A fresh human review of the exact harness SHA is mandatory before execution. When a trusted second maintainer exists, or before production use, require that maintainer as the reviewer and enable self-review prevention. Its permissions are limited to contents read and Actions read at the workflow level. App credentials are environment secrets exposed only to the no-argument harness process, never as command arguments, workflow outputs, or `GITHUB_ENV` values. The workflow rejects missing or inconsistent repository, ref, pull-request, and SHA variables before credentialed execution.

The credential-free validation bundle is produced only after protected CI checks pass for the same commit. Its manifest records the repository, `refs/heads/main`, exact source SHA, a sorted file inventory, and SHA-256 digests. The manual workflow looks up a completed successful `CI` run through the read-only Actions API, requires the exact workflow identity, branch, event, conclusion, head SHA, and numeric artifact identity, rejects unsafe archive paths, verifies every listed digest and the complete inventory, and only then runs the harness. It does not install dependencies while credentials are present and uploads only a fixed short-lived summary after a secret scan.

The validation harness delivers events to localhost and does not establish a public endpoint. Public TLS delivery and any external webhook exposure require a separate operator authorization and deployment review. Validation uses a same-repository branch; third-party forks are outside the App credential boundary.

SQLite queue leases, attempts, cancellation, and synchronize supersession prevent a stale worker from silently replacing newer work. Publication uses the persisted Check and managed-comment IDs.

## Residual risk and non-goals

The host kernel, Docker daemon, image supply chain, GitHub installation, and operator-provided network adapters remain trusted dependencies. A trusted base branch can still contain an unsafe scenario; PatchProof records what it ran rather than proving scenario quality. Hashes do not identify a signer. The local backend is not a security boundary. Network allowlists are refused until an enforcing adapter exists. Replay requires human confirmation, operator-supplied source directories, and reports environmental drift. A standalone bundle does not reconstruct a checkout.
