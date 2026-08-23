# Configuration reference

`.patchproof.yml` must contain `version: 1`.

```yaml
version: 1
name: Parser regression
scenario:
  id: parser-regression
  name: Reproduce the parser regression
  command: [node, scenario.mjs]
  cwd: .
  file: scenario.mjs
  expectedFailure:
    exitCode: 1
    reasonPattern: EXPECTED_BUG
    # Optional second regex for the expected failure class.
    # reasonClass: parser-regression
  environment: {}
policy:
  backend: docker
  network: none
  allowedHosts: []
  allowFork: false
  allowUnsafeLocal: false
  timeoutMs: 30000
  outputBytes: 65536
  memoryMb: 512
  cpuCount: 1
  pids: 128
  dockerImage: registry.example.com/patchproof-scenario@sha256:<64 hexadecimal characters>
  # The production worker refuses unpinned references such as node:24-bookworm-slim;
  # every image must be digest-pinned and listed in PATCHPROOF_APPROVED_DOCKER_IMAGES.
  readOnlyRoot: true
redaction:
  secrets: []
```

`scenario.command` is an argv array. It is never joined into a shell command. The `file` is copied from the trusted base workspace over the corresponding head path, ensuring the assertion is identical. `expectedFailure.exitCode` is required. `reasonPattern` and `reasonClass` are optional regular expressions over the combined base output; when present, both must match. Use them to avoid treating an unrelated failure as the claimed regression. During verification and replay, each pattern evaluation against recorded output runs under a one-second wall-clock deadline; a pattern that exceeds it fails the operation instead of backtracking indefinitely, so keep patterns linear where possible.

`policy.timeoutMs` bounds each revision's scenario run plus a short kill grace period. For Docker, image inspection, pull, and other provisioning work have their own budget (120 seconds by default), and container cleanup has a separate budget of about five seconds; neither consumes `timeoutMs`.

`policy.network` accepts `none` and `allowlist`. An allowlist configuration validates, but every current backend refuses it at run time until an enforcing adapter exists.

Defaults are conservative: Docker, no network, bounded resources, read-only root, no unsafe local execution, no fork execution, and empty redaction secrets. Policy limits are bounded to the supported runner ranges: timeout up to 24 hours, output up to 1 GiB, memory up to 1 TiB, 256 CPUs, and 1,000,000 PIDs. Unknown keys are warnings; malformed types, unsafe paths, invalid regular expressions, unsafe environment names, unsafe image references, and unsupported versions are errors.
