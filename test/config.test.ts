import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  ConfigValidationError,
  assertPathInside,
  assertSafeRelativePath,
  loadConfig,
  parseConfigText,
} from '@patchproof/config';
import { fixturePath } from '@patchproof/testkit';

test('configuration requires version 1 and produces useful diagnostics', async () => {
  const parsed = parseConfigText('version: 2\nscenario:\n  command: node\n');
  assert.equal(parsed.config, undefined);
  assert.ok(parsed.diagnostics.some((item) => item.path === 'version'));
  await assert.rejects(
    loadConfig(join(fixturePath('malformed'), '.patchproof.yml')),
    ConfigValidationError,
  );
});

test('trusted config path rejects traversal', async () => {
  await assert.rejects(
    assertPathInside(fixturePath('pass'), '../malformed/.patchproof.yml', 'config'),
    /escapes trusted root/,
  );
  assert.throws(() => assertSafeRelativePath('C:\\outside\\scenario.mjs', 'scenario.file'));
});

test('configuration bounds policy, path, environment, regex, and Docker inputs', () => {
  const parsed = parseConfigText(`
version: 1
name: unsafe input test
scenario:
  id: test
  name: test
  command: [node, scenario.mjs]
  cwd: ../outside
  expectedFailure:
    exitCode: 999999999
    reasonPattern: "["
  environment:
    BAD-NAME: value
policy:
  backend: docker
  allowedHosts: [example.test, example.test]
  timeoutMs: 999999999999999999999
  dockerImage: --privileged
redaction:
  secrets: []
`);
  assert.equal(parsed.config, undefined);
  assert.ok(parsed.diagnostics.some((item) => item.path === 'scenario.cwd'));
  assert.ok(parsed.diagnostics.some((item) => item.path === 'scenario.expectedFailure.exitCode'));
  assert.ok(
    parsed.diagnostics.some((item) => item.path === 'scenario.expectedFailure.reasonPattern'),
  );
  assert.ok(parsed.diagnostics.some((item) => item.path === 'scenario.environment.BAD-NAME'));
  assert.ok(parsed.diagnostics.some((item) => item.path === 'policy.timeoutMs'));
  assert.ok(parsed.diagnostics.some((item) => item.path === 'policy.dockerImage'));
  assert.ok(parsed.diagnostics.some((item) => item.path === 'policy.allowedHosts'));

  const reserved = parseConfigText(`
version: 1
name: reserved key test
scenario:
  id: test
  name: test
  command: [node]
  environment:
    __proto__: unsafe
policy:
  backend: docker
`);
  assert.equal(reserved.config, undefined);
  assert.ok(reserved.diagnostics.some((item) => item.path === 'scenario.environment.__proto__'));
});
