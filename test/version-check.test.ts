import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const script = resolve(process.cwd(), 'scripts/version-check.mjs');

function runVersionCheck(...arguments_: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, ...arguments_], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('version check matches exact changelog markers and rejects hostile versions', () => {
  assert.equal(runVersionCheck().status, 0);
  assert.equal(runVersionCheck('--version', '0.1.0').status, 0);
  assert.notEqual(runVersionCheck('--version', '0.1.0-alpha').status, 0);
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
  const tagResult = runVersionCheck('--version', '0.1.0', '--tag', 'v0.1.0');
  assert.notEqual(tagResult.status, 0);
  assert.match(`${tagResult.stdout}${tagResult.stderr}`, /must be released before tagging/u);
});
