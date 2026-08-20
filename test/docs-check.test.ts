import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(process.cwd());

test('docs check runs its unsafe-local fixture in a cleaned temporary workspace', () => {
  const work = resolve(root, 'work');
  const before = docsCheckWorkspaces(work);
  const output = execFileSync(process.execPath, [resolve(root, 'scripts/docs-check.mjs')], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 1_000_000,
  });
  assert.match(output, /docs:check passed/u);
  assert.deepEqual(docsCheckWorkspaces(work), before);
  assert.equal(
    /^  allowUnsafeLocal:\s*true\s*$/mu.test(
      readFileSync(resolve(root, 'fixtures/pass/.patchproof.yml'), 'utf8'),
    ),
    false,
  );
});

function docsCheckWorkspaces(work: string): string[] {
  return readdirSync(work)
    .filter((entry) => entry.startsWith('docs-check-'))
    .sort();
}
