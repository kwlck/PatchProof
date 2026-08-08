# Release process

1. Review the changelog and changeset notes.
2. Run the full verification matrix, including `pnpm audit --prod`, on a clean checkout.
3. Build and inspect `dist/`, lockfile, SBOM/provenance output, and the package tree.
4. Tag a version only after two maintainers review security-sensitive changes.
5. Publish through the protected release workflow; this local project does not publish packages, images, or releases.

The release workflow generates a source archive and an SPDX-style dependency inventory as build artifacts. These artifacts describe build provenance; they do not claim remote attestation of a run bundle.
