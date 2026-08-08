# Security policy

PatchProof executes code from pull-request repositories. Treat it as a security boundary, not as a test runner that inherits the host environment.

## Reporting

Do not open a public issue for a suspected vulnerability. Use a private security channel configured by the deploying organization and include a minimal reproduction, affected version, impact, and whether a secret or token may have been exposed. Do not include real credentials in a report.

## Secret scanning guidance

Enable GitHub secret scanning and push protection on the published repository. Keep webhook secrets, installation tokens, private keys, and evidence containing sensitive paths out of commits and fixtures. Run the organization's approved secret scanner before releases; the local CI workflow does not receive production credentials.

## Supported security guarantees

- Webhook HMAC uses SHA-256 and constant-time comparison.
- Fork configuration and executable scenarios come from the trusted base checkout by default; fork execution requires explicit trusted-base inputs.
- The webhook process only validates, persists minimal state, and enqueues work. It does not execute repository code.
- Docker defaults to no network, non-root, read-only root where compatible, dropped capabilities, no-new-privileges, bounded resources, and scratch-only writes.
- Commands are argv arrays with `shell: false`; path and symlink checks reject traversal/escape.
- Logs and persisted previews are bounded and redact configured secrets plus common credential formats, including split stream boundaries.
- Evidence verification checks schema support, canonical digest, completeness, artifact sizes, hashes, safe relative paths, and symlink rejection without executing repository code.

## Residual risks

Host kernel/container runtime compromise, a malicious or misconfigured Docker image, operator-provided network adapters, secrets deliberately placed in trusted base content, and GitHub token compromise remain outside the evidence hash. A local-process run is not isolated and must be visibly marked unsafe. Hash integrity is not signer identity or remote attestation. See [docs/threat-model.md](docs/threat-model.md).
