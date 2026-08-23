import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sh = readFileSync(resolve(process.cwd(), 'install/install.sh'), 'utf8');
const ps1 = readFileSync(resolve(process.cwd(), 'install/install.ps1'), 'utf8');

test('install scripts pin the repository and verify every download by checksum', () => {
  for (const [name, script] of [
    ['install.sh', sh],
    ['install.ps1', ps1],
  ] as const) {
    assert.ok(script.includes('kwlck/PatchProof'), `${name} must reference the release repository`);
    assert.ok(script.includes('SHA256SUMS'), `${name} must download release checksums`);
    assert.ok(
      script.includes('Get-FileHash') || script.includes('sha256sum -c'),
      `${name} must verify checksums before use`,
    );
    assert.ok(script.includes('22.14.0'), `${name} must pin a standalone Node.js version`);
    assert.ok(
      script.includes('patchproof setup --check'),
      `${name} must end with an environment verification`,
    );
  }
});

test('install scripts avoid piping remote code into an interpreter', () => {
  assert.doesNotMatch(sh, /curl[^|]*\|\s*(ba)?sh\b/u);
  assert.doesNotMatch(sh, /wget[^|]*\|\s*(ba)?sh\b/u);
  assert.ok(
    !ps1.includes('Invoke-Expression'),
    'PowerShell installer must not execute downloaded text',
  );
});

test('shell installer fails closed on unset variables and pipeline errors', () => {
  assert.ok(sh.includes('set -euo pipefail'));
  assert.ok(sh.includes('verify_line "$line" "$RUNTIME_DIR" || fail'));
  assert.ok(sh.includes('verify_line "$line" "$LIB_DIR" || fail'));
});
