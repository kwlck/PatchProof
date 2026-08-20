# Release process

1. Review the changelog and changeset notes.
2. Run the full verification matrix, including `pnpm audit --prod`, on a clean checkout.
3. Build and inspect `dist/`, lockfile, SBOM/provenance output, and the package tree.
4. Tag a version only after two maintainers review security-sensitive changes.
5. Publish through the protected release workflow; this local project does not publish packages, images, or releases.

The release workflow generates a minimal deterministic source archive, SHA256SUMS, and an SPDX 2.3 JSON SBOM as build artifacts. The SBOM checker requires the matching release archive, safely extracts it, recomputes every listed file's SHA-1/SHA-256, verifies the archive SHA-256, and enforces the reproducible package verification code. The SPDX project's current `@spdx/tools` package is a document-construction library and does not parse or validate existing JSON documents; the official Python validator is not available as a locked Node/CI dependency here, so the release check uses these independent vectors rather than claiming external validation.

The package check builds the tarball twice, compares both bytes and SHA-256 digests, and asserts a normalized gzip header (zero MTIME and OS byte 255) so Linux and Windows builders produce the same asset. These artifacts describe build provenance; they do not claim remote attestation of a run bundle.
