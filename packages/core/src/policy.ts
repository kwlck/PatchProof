import type {
  ClassificationInput,
  ClassificationResult,
  ExpectedFailure,
  RunOutcome,
} from './types.js';
import { PATTERN_DEADLINE_MS, matchesWithinDeadline } from './regex-guard.js';

type ExpectedMatcher = (pattern: string, text: string) => boolean;

function defaultMatcher(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'm').test(text);
  } catch {
    return false;
  }
}

export interface GuardedClassificationOptions {
  /** Wall-clock budget for each pattern evaluation. */
  deadlineMs?: number;
}

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
  match: ExpectedMatcher,
): boolean {
  if (exitCode !== expected.exitCode) return false;
  if (expected.reasonPattern !== undefined && !match(expected.reasonPattern, output)) return false;
  if (expected.reasonClass !== undefined && !match(expected.reasonClass, output)) return false;
  return true;
}

function classifyOutcomeWith(
  input: ClassificationInput,
  match: ExpectedMatcher,
): ClassificationResult {
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
    match,
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

export function classifyOutcome(input: ClassificationInput): ClassificationResult {
  return classifyOutcomeWith(input, defaultMatcher);
}

/**
 * Deterministic classification when the pattern or the output may be hostile,
 * such as outcome recomputation during evidence verification. Every pattern
 * evaluation runs inside a worker thread that is terminated at the deadline.
 */
export async function classifyOutcomeGuarded(
  input: ClassificationInput,
  options: GuardedClassificationOptions = {},
): Promise<ClassificationResult> {
  const deadlineMs = options.deadlineMs ?? PATTERN_DEADLINE_MS;
  const decisions = new Map<string, boolean>();
  for (const pattern of [input.expectedFailure.reasonPattern, input.expectedFailure.reasonClass]) {
    if (pattern === undefined || decisions.has(pattern)) continue;
    decisions.set(
      pattern,
      await matchesWithinDeadline(pattern, 'm', input.base.output, deadlineMs),
    );
  }
  return classifyOutcomeWith(input, (candidate) => decisions.get(candidate) ?? false);
}
