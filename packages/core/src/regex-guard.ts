import { Worker } from 'node:worker_threads';

/** Default wall-clock budget for one untrusted regular expression evaluation. */
export const PATTERN_DEADLINE_MS = 1_000;

/**
 * Raised when an untrusted pattern did not finish within its deadline. Callers
 * must treat this as a verification failure instead of waiting on backtracking.
 */
export class PatternDeadlineExceededError extends Error {
  public constructor() {
    super('Regular expression evaluation exceeded its deadline');
    this.name = 'PatternDeadlineExceededError';
  }
}

// Eval workers default to CommonJS regardless of the package module type.
const MATCHER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (message) => {
  let matched = false;
  try {
    matched = new RegExp(message.pattern, message.flags).test(message.input);
  } catch {
    matched = false;
  }
  parentPort.postMessage(matched);
});
`;

/**
 * Evaluate a possibly hostile regular expression against possibly hostile
 * input inside a worker thread that is terminated at the deadline, so
 * catastrophic backtracking cannot block the calling process.
 */
export function matchesWithinDeadline(
  pattern: string,
  flags: string,
  input: string,
  deadlineMs: number = PATTERN_DEADLINE_MS,
): Promise<boolean> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
      rejectPromise(new TypeError('Pattern deadline must be a positive safe integer'));
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(MATCHER_SOURCE, { eval: true });
    } catch (error) {
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    const settle = (settlePromise: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The eval worker's MessagePort stays ref'd after replying, so an explicit
      // terminate is required or the calling process would never exit.
      void worker.terminate();
      settlePromise();
    };
    const timer = setTimeout(() => {
      settle(() => rejectPromise(new PatternDeadlineExceededError()));
    }, deadlineMs);
    worker.once('message', (matched: unknown) => {
      settle(() => resolvePromise(matched === true));
    });
    worker.once('error', (error: unknown) => {
      settle(() => rejectPromise(error instanceof Error ? error : new Error(String(error))));
    });
    worker.once('exit', () => {
      settle(() => rejectPromise(new PatternDeadlineExceededError()));
    });
    worker.postMessage({ pattern, flags, input });
  });
}
