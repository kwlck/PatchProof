import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const versionStep =
  /run: \|\r?\n\s+version="\$\(node -e 'const \{ version \} = require\("\.\/package\.json"\); if \(!version\) process\.exit\(1\); process\.stdout\.write\(version\)'\)"\r?\n\s+printf 'version=%s\\n' "\$version" >> "\$GITHUB_OUTPUT"/gu;

test('release workflow uses shell-safe deterministic and output commands', () => {
  assert.equal([...workflow.matchAll(/GITHUB_OUTPUT/gu)].length, 2);
  assert.equal([...workflow.matchAll(versionStep)].length, 2);
  assert.match(
    workflow,
    /git show -s --format='SOURCE_DATE_EPOCH=%ct' "\$GITHUB_SHA" >> "\$GITHUB_ENV"/u,
  );
  assert.doesNotMatch(workflow, /git show -s --format=%ct \\"\$GITHUB_SHA\\"/u);
  assert.doesNotMatch(workflow, /node -p \\"require\('\.\/package\.json'\)\.version\\"/u);
});
