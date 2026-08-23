import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@patchproof/config';
import { verifyEvidenceBundle } from '@patchproof/core';
import { buildDemoFiles, collectSetupChecks, parseArgs, runSetup } from '@patchproof/cli';

test('demo fixture is a valid local-backend configuration with a fail-to-pass scenario', async () => {
  const files = buildDemoFiles();
  const base = files['base/scenario.mjs'];
  const head = files['head/scenario.mjs'];
  const config = files['.patchproof.yml'];
  assert.match(base, /EXPECTED_BUG/u);
  assert.match(base, /process\.exit\(1\)/u);
  assert.equal(base, head);
  assert.match(config, /allowUnsafeLocal: true/u);
  assert.match(config, /reasonPattern: EXPECTED_BUG/u);
});

test('setup --check reports a ready environment without running the demo', async () => {
  const checks = await collectSetupChecks();
  assert.equal(checks[0]!.key, 'node');
  assert.equal(
    checks[0]!.ok,
    true,
    `Node.js must be >=22 in the test environment: ${checks[0]!.detail}`,
  );
  const exitCode = await runSetup(parseArgs(['setup', '--check', '--json']));
  assert.equal(exitCode, 0);
});

test('setup --demo proves the full pipeline and writes verifiable evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-setup-demo-'));
  const demoDir = join(root, 'demo');
  const exitCode = await runSetup(parseArgs(['setup', '--demo', '--demo-dir', demoDir, '--json']));
  assert.equal(exitCode, 0);
  const config = await loadConfig(join(demoDir, '.patchproof.yml'));
  assert.equal(config.config.policy.backend, 'local');
  const evidencePath = join(demoDir, 'evidence', 'patchproof.evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.equal(evidence.outcome, 'PASS');
  assert.equal((await verifyEvidenceBundle(evidencePath)).valid, true);
});
