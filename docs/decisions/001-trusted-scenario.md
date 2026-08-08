# Decision 001: the base owns executable scenario content

Status: accepted.

A pull request controls its repository content, so loading `.patchproof.yml` or a scenario file from head would let the change redefine the assertion and manufacture a green result. PatchProof therefore loads executable configuration and the optional scenario file from the trusted base revision, copies that file over the corresponding head path, and records `trustedConfigRevision: base` in evidence. Fork runs require an explicit trusted-base checkout. Future versions may support signed scenario manifests, but they must preserve this default.
