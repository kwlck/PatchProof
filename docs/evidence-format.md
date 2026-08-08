# Evidence format

The public file is `patchproof.evidence.json`, schema version `1`. Canonical JSON sorts object keys and preserves array order. `integrity.canonicalSha256` hashes the same object with `integrity.canonicalSha256` set to `null`; `signer` is currently `null`.

The bundle records:

- the outcome and deterministic verdict;
- the trusted scenario ID, argv, safe cwd, expected failure, and scenario hash;
- base and head source refs, source identity kind, SHA, and stable replay labels. Host paths are intentionally omitted;
- the backend, network policy, resource limits, fork flag, and trusted-config revision;
- scenario-visible environment values, plus omitted launcher-environment keys and a SHA-256 metadata hash;
- normalized toolchain identity, including the declared container image when Docker is selected and an explicit dependency-lock status with a SHA-256 and file name when a known lockfile is present;
- per-revision exit code, signal, timeout, duration, bounded previews, and artifact references;
- artifact paths, byte sizes, media types, and SHA-256 hashes;
- exact completeness checks, replay locations, and recorded runtime metadata;
- an explicit `policy.denialReason` and incomplete execution checks for a policy-denied run.

Version 1 uses strict recursive objects. Duplicate JSON object keys, unknown fields, unsafe numbers, invalid formats, duplicate artifact IDs or paths, duplicate log references, missing cross-references, and inconsistent completeness flags are rejected. The verifier also reads the referenced log artifacts and recomputes the outcome from the executions, expected failure, policy, and completeness state.

`patchproof verify` checks the schema before making any claim, recomputes the canonical digest, rejects traversal, absolute, and symlink artifact references, verifies every artifact size and hash, and never runs scenario commands or loads repository modules. Hash integrity does not prove who created a bundle.
