import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const script = resolve(process.cwd(), 'scripts/version-check.mjs');
const manifestVersion = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }
).version;
const escapedManifestVersion = manifestVersion.replaceAll('\\', '\\\\').replaceAll('.', '\\.');

function runVersionCheck(...arguments_: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, ...arguments_], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('version check matches exact changelog markers and rejects hostile versions', () => {
  assert.equal(runVersionCheck().status, 0);
  assert.equal(runVersionCheck('--version', manifestVersion).status, 0);
  assert.notEqual(runVersionCheck('--version', `${manifestVersion}-alpha`).status, 0);
  const validSemVers = [
    '0.0.0',
    '1.2.3',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-0A',
    '1.2.3+build.01',
    '1.2.3-beta+exp.sha.5114f85',
    '1.2.3-rc.1+build.01',
  ];
  for (const version of validSemVers) {
    const result = runVersionCheck('--version', version);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Invalid release version/u);
  }
  const invalidSemVers = [
    '01.2.3',
    '1.2.3-..',
    '1.2.3-alpha..1',
    '1.2.3-01',
    '1.2.3-',
    '1.2.3+',
    '1.2.3+build.',
    '1.2.3+build..x',
    '1.2.3-foo_1',
    '1.2.3-١',
    '1.2.3.4',
  ];
  for (const version of invalidSemVers) {
    const result = runVersionCheck('--version', version);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Invalid release version/u);
  }
  for (const hostileVersion of ['0.1.0$', '0.1.0.*', '0.1.0|.*', '1e3', '1E+3']) {
    const result = runVersionCheck('--version', hostileVersion);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Invalid release version/u);
  }
  const tagResult = runVersionCheck('--version', manifestVersion, '--tag', `v${manifestVersion}`);
  assert.equal(tagResult.status, 0);
  assert.match(tagResult.stdout, new RegExp(`tag: v${escapedManifestVersion}`, 'u'));
});

test('tagging rejects an unreleased changelog entry', () => {
  const changelogPath = resolve(process.cwd(), 'CHANGELOG.md');
  const original = readFileSync(changelogPath, 'utf8');
  const escapedVersion = escapedManifestVersion;
  const unreleased = original.replace(
    new RegExp(`##[ \\t]+${escapedVersion}[ \\t]+-[ \\t]+\\d{4}-\\d{2}-\\d{2}`, 'u'),
    `## ${manifestVersion} - unreleased`,
  );
  assert.notEqual(unreleased, original, 'released changelog marker not found');
  try {
    writeFileSync(changelogPath, unreleased);
    const tagResult = runVersionCheck('--version', manifestVersion, '--tag', `v${manifestVersion}`);
    assert.notEqual(tagResult.status, 0);
    assert.match(`${tagResult.stdout}${tagResult.stderr}`, /must be released before tagging/u);
  } finally {
    writeFileSync(changelogPath, original);
  }
});
