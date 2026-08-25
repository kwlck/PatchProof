import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@patchproof/config';
import { verifyEvidenceBundle } from '@patchproof/core';
import {
  buildDemoFiles,
  collectSetupChecks,
  dockerInstallPlan,
  parseArgs,
  runSetup,
} from '@patchproof/cli';

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

test('docker install plans use the official package manager for the platform', () => {
  const winget = dockerInstallPlan('win32');
  assert.equal(winget?.steps[0]?.command, 'winget');
  assert.deepEqual(winget?.steps[0]?.args.slice(0, 3), ['install', '--id', 'Docker.DockerDesktop']);

  const brew = dockerInstallPlan('darwin');
  assert.equal(brew?.steps[0]?.command, 'brew');
  assert.deepEqual(brew?.steps[0]?.args, ['install', '--cask', 'docker']);
  assert.equal(brew?.steps[1]?.command, 'open');

  const apt = dockerInstallPlan('linux', (path) => path === '/usr/bin/apt-get');
  assert.equal(apt?.label, 'apt (Docker Engine)');
  assert.equal(apt?.steps[1]?.command, 'sudo');
  assert.deepEqual(apt?.steps[1]?.args, ['apt-get', 'install', '-y', 'docker.io']);

  const dnf = dockerInstallPlan('linux', (path) => path === '/usr/bin/dnf');
  assert.deepEqual(dnf?.steps[0]?.args, ['dnf', 'install', '-y', 'moby-engine']);

  const pacman = dockerInstallPlan('linux', (path) => path === '/usr/bin/pacman');
  assert.deepEqual(pacman?.steps[0]?.args, ['pacman', '-S', '--noconfirm', 'docker']);

  const unknown = dockerInstallPlan('linux', () => false);
  assert.equal(unknown, undefined);
});

test('every docker install step avoids shells and interpolated arguments', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const plan = dockerInstallPlan(platform, () => true);
    assert.ok(plan, `${platform} must have a plan`);
    for (const step of plan.steps) {
      assert.doesNotMatch(step.command, /[;&|`$<>\s]/u, 'command must be a bare executable name');
      for (const argument of step.args) {
        assert.doesNotMatch(
          argument,
          /[;&|`<>]/u,
          'arguments must not contain shell metacharacters',
        );
      }
    }
  }
});
