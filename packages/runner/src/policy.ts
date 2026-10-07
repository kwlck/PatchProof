import type { PatchProofConfig } from '@patchproof/config';

/**
 * Limits and floors owned by the process running PatchProof.
 *
 * Repository configuration is untrusted input. An operator can pass this
 * policy to keep repository-selected values below a ceiling, require reviewed
 * immutable images, and provide the immutable egress proxy used to enforce a
 * repository network allowlist.
 */
export interface OperatorPolicy {
  forceDocker: boolean;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  maxMemoryMb: number;
  maxCpuCount: number;
  maxPids: number;
  approvedDockerImages: readonly string[];
  requireDigestPinnedImages: boolean;
  requireReadOnlyRoot: boolean;
  provisioningTimeoutMs: number;
  egressProxyImage?: string;
}

export type OperatorPolicyInput = Partial<OperatorPolicy>;

export const DEFAULT_OPERATOR_POLICY: Readonly<OperatorPolicy> = Object.freeze({
  forceDocker: true,
  maxTimeoutMs: 86_400_000,
  maxOutputBytes: 1_073_741_824,
  maxMemoryMb: 1_048_576,
  maxCpuCount: 256,
  maxPids: 1_000_000,
  approvedDockerImages: Object.freeze([]),
  requireDigestPinnedImages: false,
  requireReadOnlyRoot: true,
  provisioningTimeoutMs: 120_000,
});

export interface OperatorPolicyApplication {
  allowed: boolean;
  policy: PatchProofConfig['policy'];
  operatorPolicy: OperatorPolicy;
  reason?: string;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`Operator policy ${name} must be a positive safe integer`);
  return value;
}

function booleanValue(value: boolean, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`Operator policy ${name} must be boolean`);
  return value;
}

function mergeOperatorPolicy(input: OperatorPolicyInput): OperatorPolicy {
  const egressProxyImage = input.egressProxyImage;
  if (egressProxyImage !== undefined && typeof egressProxyImage !== 'string')
    throw new TypeError('Operator policy egressProxyImage must be a string');
  return {
    forceDocker: booleanValue(
      input.forceDocker ?? DEFAULT_OPERATOR_POLICY.forceDocker,
      'forceDocker',
    ),
    maxTimeoutMs: positiveInteger(
      input.maxTimeoutMs ?? DEFAULT_OPERATOR_POLICY.maxTimeoutMs,
      'maxTimeoutMs',
    ),
    maxOutputBytes: positiveInteger(
      input.maxOutputBytes ?? DEFAULT_OPERATOR_POLICY.maxOutputBytes,
      'maxOutputBytes',
    ),
    maxMemoryMb: positiveInteger(
      input.maxMemoryMb ?? DEFAULT_OPERATOR_POLICY.maxMemoryMb,
      'maxMemoryMb',
    ),
    maxCpuCount: positiveInteger(
      input.maxCpuCount ?? DEFAULT_OPERATOR_POLICY.maxCpuCount,
      'maxCpuCount',
    ),
    maxPids: positiveInteger(input.maxPids ?? DEFAULT_OPERATOR_POLICY.maxPids, 'maxPids'),
    approvedDockerImages: [
      ...(input.approvedDockerImages ?? DEFAULT_OPERATOR_POLICY.approvedDockerImages),
    ],
    requireDigestPinnedImages: booleanValue(
      input.requireDigestPinnedImages ?? DEFAULT_OPERATOR_POLICY.requireDigestPinnedImages,
      'requireDigestPinnedImages',
    ),
    requireReadOnlyRoot: booleanValue(
      input.requireReadOnlyRoot ?? DEFAULT_OPERATOR_POLICY.requireReadOnlyRoot,
      'requireReadOnlyRoot',
    ),
    provisioningTimeoutMs: positiveInteger(
      input.provisioningTimeoutMs ?? DEFAULT_OPERATOR_POLICY.provisioningTimeoutMs,
      'provisioningTimeoutMs',
    ),
    ...(egressProxyImage === undefined ? {} : { egressProxyImage }),
  };
}

export function resolveOperatorPolicy(input?: OperatorPolicyInput): OperatorPolicy | undefined {
  return input === undefined ? undefined : mergeOperatorPolicy(input);
}

export function isDigestPinnedImage(image: string): boolean {
  return image.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._/@:-]*@sha256:[0-9a-f]{64}$/iu.test(image);
}

/** Exact public DNS host name accepted by the egress proxy; no wildcards or IP literals. */
export function isAllowedEgressHost(host: string): boolean {
  if (host.length < 4 || host.length > 253 || host !== host.toLowerCase()) return false;
  if (host.endsWith('.') || host.includes('*') || host.includes(':')) return false;
  if (/^\d+(?:\.\d+){3}$/u.test(host)) return false;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  )
    return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

function denied(
  policy: PatchProofConfig['policy'],
  operatorPolicy: OperatorPolicy,
  reason: string,
): OperatorPolicyApplication {
  return { allowed: false, policy, operatorPolicy, reason };
}

/** Apply operator-owned policy without silently widening repository requests. */
export function applyOperatorPolicy(
  repositoryPolicy: PatchProofConfig['policy'],
  input: OperatorPolicyInput,
): OperatorPolicyApplication {
  const operatorPolicy = mergeOperatorPolicy(input);
  if (operatorPolicy.approvedDockerImages.some((image) => !isDigestPinnedImage(image)))
    return denied(
      repositoryPolicy,
      operatorPolicy,
      'Operator-approved Docker images must all be pinned by sha256 digest',
    );
  if (
    operatorPolicy.egressProxyImage !== undefined &&
    !isDigestPinnedImage(operatorPolicy.egressProxyImage)
  )
    return denied(
      repositoryPolicy,
      operatorPolicy,
      'Operator egress proxy image must be pinned by sha256 digest',
    );
  if (operatorPolicy.forceDocker && repositoryPolicy.backend !== 'docker')
    return denied(
      repositoryPolicy,
      operatorPolicy,
      'Operator policy requires the Docker backend; local process execution is not permitted. Install Docker, or run a development check with --allow-unsafe-local and a config that sets policy.allowUnsafeLocal: true',
    );
  if (repositoryPolicy.network === 'allowlist') {
    if (repositoryPolicy.backend !== 'docker')
      return denied(
        repositoryPolicy,
        operatorPolicy,
        'Network allowlists require the Docker backend',
      );
    if (operatorPolicy.egressProxyImage === undefined)
      return denied(
        repositoryPolicy,
        operatorPolicy,
        'Network allowlists require PATCHPROOF_EGRESS_PROXY_IMAGE pinned by sha256 digest',
      );
    if (repositoryPolicy.allowedHosts.length === 0)
      return denied(
        repositoryPolicy,
        operatorPolicy,
        'Network allowlist must contain at least one host',
      );
    if (repositoryPolicy.allowedHosts.some((host) => !isAllowedEgressHost(host)))
      return denied(
        repositoryPolicy,
        operatorPolicy,
        'Network allowlist hosts must be exact lowercase public DNS names without wildcards or IP literals',
      );
  }
  if (repositoryPolicy.timeoutMs > operatorPolicy.maxTimeoutMs)
    return denied(
      repositoryPolicy,
      operatorPolicy,
      `Configured timeoutMs exceeds operator maximum ${operatorPolicy.maxTimeoutMs}`,
    );
  if (repositoryPolicy.outputBytes > operatorPolicy.maxOutputBytes)
    return denied(
      repositoryPolicy,
      operatorPolicy,
      `Configured outputBytes exceeds operator maximum ${operatorPolicy.maxOutputBytes}`,
    );
  if (repositoryPolicy.memoryMb > operatorPolicy.maxMemoryMb)
    return denied(
      repositoryPolicy,
      operatorPolicy,
      `Configured memoryMb exceeds operator maximum ${operatorPolicy.maxMemoryMb}`,
    );
  if (repositoryPolicy.cpuCount > operatorPolicy.maxCpuCount)
    return denied(
      repositoryPolicy,
      operatorPolicy,
      `Configured cpuCount exceeds operator maximum ${operatorPolicy.maxCpuCount}`,
    );
  if (repositoryPolicy.pids > operatorPolicy.maxPids)
    return denied(
      repositoryPolicy,
      operatorPolicy,
      `Configured pids exceeds operator maximum ${operatorPolicy.maxPids}`,
    );
  if (repositoryPolicy.backend === 'docker') {
    const allowlistConfigured = operatorPolicy.approvedDockerImages.length > 0;
    if (
      (operatorPolicy.requireDigestPinnedImages || allowlistConfigured) &&
      !isDigestPinnedImage(repositoryPolicy.dockerImage)
    )
      return denied(
        repositoryPolicy,
        operatorPolicy,
        'Docker image must be pinned by a sha256 digest under the operator policy',
      );
    if (
      allowlistConfigured &&
      !operatorPolicy.approvedDockerImages.includes(repositoryPolicy.dockerImage)
    )
      return denied(
        repositoryPolicy,
        operatorPolicy,
        'Docker image is not present in the operator-approved digest allowlist',
      );
  }
  if (operatorPolicy.requireReadOnlyRoot && !repositoryPolicy.readOnlyRoot)
    return denied(
      repositoryPolicy,
      operatorPolicy,
      'Operator policy requires a read-only container root filesystem',
    );
  return { allowed: true, policy: repositoryPolicy, operatorPolicy };
}
