import { isDigestPinnedImage, type OperatorPolicyInput } from '@patchproof/runner';

/**
 * The worker is a production entry point, so its runner policy is owned by
 * the operator rather than by repository configuration.  Keep these values
 * deliberately conservative; operators can raise them explicitly, subject
 * to the strict positive-integer parser below.
 */
export const DEFAULT_WORKER_OPERATOR_LIMITS = Object.freeze({
  maxTimeoutMs: 120_000,
  maxOutputBytes: 16 * 1024 * 1024,
  maxMemoryMb: 2_048,
  maxCpuCount: 4,
  maxPids: 512,
  provisioningTimeoutMs: 120_000,
});

export const WORKER_OPERATOR_ENV = Object.freeze({
  approvedDockerImages: 'PATCHPROOF_APPROVED_DOCKER_IMAGES',
  maxTimeoutMs: 'PATCHPROOF_MAX_TIMEOUT_MS',
  maxOutputBytes: 'PATCHPROOF_MAX_OUTPUT_BYTES',
  maxMemoryMb: 'PATCHPROOF_MAX_MEMORY_MB',
  maxCpuCount: 'PATCHPROOF_MAX_CPU_COUNT',
  maxPids: 'PATCHPROOF_MAX_PIDS',
  provisioningTimeoutMs: 'PATCHPROOF_PROVISIONING_TIMEOUT_MS',
});

export class WorkerPolicyConfigurationError extends Error {
  public constructor() {
    super('Worker operator policy configuration is invalid');
    this.name = 'WorkerPolicyConfigurationError';
  }
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  // Do not silently normalize signs, decimals, whitespace, or exponential
  // notation: malformed operator input must fail closed at startup.
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new WorkerPolicyConfigurationError();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new WorkerPolicyConfigurationError();
  return value;
}

function approvedImages(environment: NodeJS.ProcessEnv): readonly string[] {
  const raw = environment[WORKER_OPERATOR_ENV.approvedDockerImages];
  if (raw === undefined || raw.length === 0) throw new WorkerPolicyConfigurationError();
  const images = raw.split(',').map((image) => image.trim());
  if (
    images.length === 0 ||
    images.some((image) => image.length === 0 || !isDigestPinnedImage(image))
  )
    throw new WorkerPolicyConfigurationError();
  return Object.freeze([...new Set(images)]);
}

/**
 * Parse the production worker's immutable Docker policy.  The returned
 * values contain no credentials or user-controlled error text.
 */
export function parseWorkerOperatorPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): OperatorPolicyInput {
  const limits = DEFAULT_WORKER_OPERATOR_LIMITS;
  return {
    forceDocker: true,
    requireDigestPinnedImages: true,
    requireReadOnlyRoot: true,
    approvedDockerImages: approvedImages(environment),
    maxTimeoutMs: positiveInteger(
      environment,
      WORKER_OPERATOR_ENV.maxTimeoutMs,
      limits.maxTimeoutMs,
    ),
    maxOutputBytes: positiveInteger(
      environment,
      WORKER_OPERATOR_ENV.maxOutputBytes,
      limits.maxOutputBytes,
    ),
    maxMemoryMb: positiveInteger(environment, WORKER_OPERATOR_ENV.maxMemoryMb, limits.maxMemoryMb),
    maxCpuCount: positiveInteger(environment, WORKER_OPERATOR_ENV.maxCpuCount, limits.maxCpuCount),
    maxPids: positiveInteger(environment, WORKER_OPERATOR_ENV.maxPids, limits.maxPids),
    provisioningTimeoutMs: positiveInteger(
      environment,
      WORKER_OPERATOR_ENV.provisioningTimeoutMs,
      limits.provisioningTimeoutMs,
    ),
  };
}
