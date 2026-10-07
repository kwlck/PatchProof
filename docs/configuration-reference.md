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

`scenario.command` is an argv array. It is never joined into a shell command. The `file` is copied from the trusted base workspace over the corresponding head path, ensuring the assertion is identical. `expectedFailure.exitCode` is required. `reasonPattern` and `reasonClass` are optional regular expressions over the combined base output; when present, both must match. Use them to avoid treating an unrelated failure as the claimed regression. Every classification of scenario output against these patterns runs under a one-second wall-clock deadline during evidence writing, verification, and replay; a pattern that exceeds it degrades the run to INCONCLUSIVE or fails verification instead of backtracking indefinitely, and outcomes that cannot depend on the patterns (timeouts, errors, policy denials) skip evaluation entirely. Keep patterns linear where possible.

`policy.timeoutMs` bounds each revision's scenario run plus a short kill grace period. Docker image inspection, pull, egress-proxy provisioning, and cleanup use separate bounded control budgets.

`policy.network` accepts `none` and `allowlist`. `none` keeps the scenario on Docker's network-disabled path. `allowlist` requires the Docker backend, at least one exact lowercase public DNS name in `allowedHosts`, and an operator-owned `PATCHPROOF_EGRESS_PROXY_IMAGE` pinned by sha256 digest. The scenario is attached only to a fresh internal Docker network; a separately pinned Squid proxy is dual-homed to that network and the Docker bridge. Proxy ACLs enforce exact host names and reject private, loopback, link-local, documentation, multicast, and other non-public destination ranges after DNS resolution. Wildcards, IP literals, `.local`, `.internal`, and localhost-style names are rejected before execution. If the proxy image is missing or invalid, execution is denied rather than falling back to unrestricted egress.

Example:

```yaml
policy:
  backend: docker
  network: allowlist
  allowedHosts:
    - api.github.com
    - registry.npmjs.org
```

Defaults remain conservative: Docker, no network, bounded resources, read-only root, no unsafe local execution, no fork execution, and empty redaction secrets. Policy limits are bounded to the supported runner ranges: timeout up to 24 hours, output up to 1 GiB, memory up to 1 TiB, 256 CPUs, and 1,000,000 PIDs. Unknown keys are warnings; malformed types, unsafe paths, invalid regular expressions, unsafe environment names, unsafe image references, and unsupported versions are errors.
