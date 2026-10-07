# Evidence format

The public file is `patchproof.evidence.json`. PatchProof now writes schema version `2` and continues to verify schema version `1` bundles for backward compatibility. Canonical JSON sorts object keys and preserves array order. `integrity.canonicalSha256` hashes the same object with `integrity.canonicalSha256` set to `null`; `signer` is currently `null`.

The bundle records:

- the outcome and deterministic verdict;
- the trusted scenario ID, argv, safe cwd, expected failure, and scenario hash;
- base and head source refs, source identity kind, and stable replay labels. Host paths are intentionally omitted;
- the backend, network policy, resource limits, fork flag, and trusted-config revision;
- scenario-visible environment values, plus omitted launcher-environment keys and a SHA-256 metadata hash;
- normalized toolchain identity, including the declared container image when Docker is selected and an explicit dependency-lock status with a SHA-256 and file name when a known lockfile is present;
- per-revision exit code, signal, timeout, duration, bounded previews, and artifact references;
- artifact paths, byte sizes, media types, and SHA-256 hashes;
- exact completeness checks, replay locations, and recorded runtime metadata;
- an explicit `policy.denialReason` and incomplete execution checks for a policy-denied run.

## Source identity in schema v2

Schema v1 used a field named `sha256` for both directory-tree SHA-256 digests and Git commit IDs. That name was misleading because the common Git object format is SHA-1. Schema v2 separates the two cases:

```json
{
  "kind": "git-commit",
  "commitOid": "<40- or 64-hex object id>",
  "objectFormat": "sha1",
  "ref": "<same object id>"
}
```

A Git SHA-256 repository uses `objectFormat: "sha256"` and a 64-hex `commitOid`. Directory snapshots continue to use a true `sha256` field. The verifier validates the OID length against `objectFormat`, requires `ref` to identify the same commit, and preserves the strict recursive validation used by v1.

Schema v1 remains readable. `patchproof verify`, replay, history, and AI explanation can consume previously generated v1 bundles. New evidence is written as v2.

Both supported schema versions reject duplicate JSON object keys, unknown fields, unsafe numbers, invalid formats, duplicate artifact IDs or paths, duplicate log references, missing cross-references, and inconsistent completeness flags. The verifier also reads referenced log artifacts and recomputes the outcome from the executions, expected failure, policy, and completeness state.

`patchproof verify` checks the schema before making any claim, recomputes the canonical digest, rejects traversal, absolute, and symlink artifact references, verifies every artifact size and hash, and never runs scenario commands or loads repository modules. Hash integrity does not prove who created a bundle.
