import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RunOutcome } from '@patchproof/core';

export function fixturePath(name: string): string {
  if (!/^[a-z0-9-]+$/u.test(name))
    throw new Error('Fixture names must be simple lowercase identifiers');
  return resolve(process.cwd(), 'fixtures', name);
}

export async function fixtureExists(name: string): Promise<boolean> {
  try {
    await access(fixturePath(name));
    return true;
  } catch {
    return false;
  }
}

export function assertOutcome(actual: RunOutcome, expected: RunOutcome): void {
  if (actual !== expected)
    throw new Error(`Expected PatchProof outcome ${expected}, received ${actual}`);
}

export const REQUIRED_FIXTURE_OUTCOMES: Record<string, RunOutcome> = {
  pass: 'PASS',
  'base-pass': 'INCONCLUSIVE',
  'head-fails': 'FAIL',
  timeout: 'INCONCLUSIVE',
  'policy-denied': 'POLICY_DENIED',
  redaction: 'PASS',
};
