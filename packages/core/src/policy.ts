import type {
  ClassificationInput,
  ClassificationResult,
  ExpectedFailure,
  RunOutcome,
} from './types.js';

export interface PolicyInput {
  backend: 'docker' | 'local';
  allowUnsafeLocal: boolean;
  fork: boolean;
  allowFork: boolean;
  trustedConfig: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  outcome?: Extract<RunOutcome, 'POLICY_DENIED'>;
  reason?: string;
}

export function decidePolicy(input: PolicyInput): PolicyDecision {
  if (!input.trustedConfig)
    return {
      allowed: false,
      outcome: 'POLICY_DENIED',
      reason: 'Configuration is not from the trusted base revision',
    };
  if (input.fork && !input.allowFork)
    return {
      allowed: false,
      outcome: 'POLICY_DENIED',
      reason: 'Fork execution is disabled by policy',
    };
  if (input.backend === 'local' && !input.allowUnsafeLocal) {
    return {
      allowed: false,
      outcome: 'POLICY_DENIED',
      reason: 'The local-process backend requires explicit unsafe opt-in',
    };
  }
  return { allowed: true };
}

function matchesExpectedFailure(
  exitCode: number | null,
  output: string,
  expected: ExpectedFailure,
): boolean {
  if (exitCode !== expected.exitCode) return false;
  try {
    if (
      expected.reasonPattern !== undefined &&
      !new RegExp(expected.reasonPattern, 'm').test(output)
    )
      return false;
    if (expected.reasonClass !== undefined && !new RegExp(expected.reasonClass, 'm').test(output))
      return false;
    return true;
  } catch {
    return false;
  }
}

export function classifyOutcome(input: ClassificationInput): ClassificationResult {
  if (input.policyDenied !== undefined) {
    return {
      outcome: 'POLICY_DENIED',
      verdict: 'Execution was denied by policy.',
      baseExpectedFailure: false,
      headSuccess: false,
      reason: input.policyDenied,
    };
  }
  if (input.base.timedOut || input.head.timedOut) {
    return {
      outcome: 'INCONCLUSIVE',
      verdict: 'The scenario timed out before a trustworthy comparison completed.',
      baseExpectedFailure: false,
      headSuccess: false,
      reason: 'A revision exceeded the configured execution timeout',
    };
  }
  if (input.base.error !== undefined || input.head.error !== undefined) {
    return {
      outcome: 'INFRA_ERROR',
      verdict: 'The runner could not complete both revisions.',
      baseExpectedFailure: false,
      headSuccess: false,
      reason: input.base.error ?? input.head.error ?? 'Unknown runner error',
    };
  }
  if (!input.complete) {
    return {
      outcome: 'INCONCLUSIVE',
      verdict: 'Evidence is incomplete; no fix claim is made.',
      baseExpectedFailure: false,
      headSuccess: false,
      reason: 'Required evidence fields or artifacts are missing',
    };
  }
  const baseExpectedFailure = matchesExpectedFailure(
    input.base.exitCode,
    input.base.output,
    input.expectedFailure,
  );
  const headSuccess = input.head.exitCode === 0;
  if (!baseExpectedFailure) {
    return {
      outcome: 'INCONCLUSIVE',
      verdict: 'The trusted base did not reproduce the expected failure.',
      baseExpectedFailure: false,
      headSuccess,
      reason:
        input.base.exitCode === 0
          ? 'Base unexpectedly passed'
          : 'Base failure did not match the configured expectation',
    };
  }
  if (headSuccess) {
    return {
      outcome: 'PASS',
      verdict: 'The trusted scenario failed on base and passed on head.',
      baseExpectedFailure: true,
      headSuccess: true,
      reason: 'Expected fail to pass transition observed with complete evidence',
    };
  }
  return {
    outcome: 'FAIL',
    verdict: 'The trusted scenario still fails on head.',
    baseExpectedFailure: true,
    headSuccess: false,
    reason: 'Head did not satisfy the assertion',
  };
}
