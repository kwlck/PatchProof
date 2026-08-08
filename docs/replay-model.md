# Replay model

Replay has two phases. Without `--yes`, PatchProof verifies the bundle and prints a plan containing stable base/head source labels, the original outcome, recorded and current Node, platform, and architecture values, the selected backend, and any deviations. With `--yes`, it reconstructs the config from the verified scenario and policy fields and runs the supported backend against directories supplied with `--base` and `--head`.

Replay requires explicit confirmation because it executes code again. The evidence bundle deliberately stores stable labels instead of host paths, so `--yes` requires both source directories. A deleted or moved source directory is an infrastructure error; a standalone JSON bundle does not contain a full source snapshot. Replay does not convert a new result into a new signed identity, and it reports current environment differences instead of hiding them.
