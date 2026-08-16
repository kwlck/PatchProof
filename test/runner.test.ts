import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDockerCommand,
  hashKnownLockfile,
  LocalProcessBackend,
  prepareDockerWorkspace,
} from '@patchproof/runner';

const policy = {
  backend: 'docker' as const,
  allowUnsafeLocal: false,
  allowFork: false,
  network: 'none' as const,
  allowedHosts: [],
  timeoutMs: 2000,
  outputBytes: 4096,
  memoryMb: 64,
  cpuCount: 1,
  pids: 16,
  dockerImage: 'node:24-bookworm-slim',
  readOnlyRoot: true,
};

test('dependency identity records a known lockfile or an explicit omission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-lockfile-'));
  try {
    assert.equal(await hashKnownLockfile(root), undefined);
    const content = 'lockfileVersion: 9.0\n';
    await writeFile(join(root, 'pnpm-lock.yaml'), content, 'utf8');
    assert.deepEqual(await hashKnownLockfile(root), {
      file: 'pnpm-lock.yaml',
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker workspace preparation opens only the generated workspace tree', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'patchproof-docker-parent-'));
  const root = join(parent, 'workspace');
  try {
    await mkdir(join(root, 'nested'), { recursive: true });
    const plainFile = join(root, 'plain.txt');
    const executableFile = join(root, 'run.sh');
    await writeFile(plainFile, 'plain\n', 'utf8');
    await writeFile(executableFile, '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(parent, 0o700);
      await chmod(root, 0o700);
      await chmod(join(root, 'nested'), 0o700);
      await chmod(plainFile, 0o600);
      await chmod(executableFile, 0o700);
    }
    await prepareDockerWorkspace(root);
    if (process.platform !== 'win32') {
      assert.equal((await stat(parent)).mode & 0o777, 0o700);
      assert.equal((await stat(root)).mode & 0o777, 0o755);
      assert.equal((await stat(join(root, 'nested'))).mode & 0o777, 0o755);
      assert.equal((await stat(plainFile)).mode & 0o777, 0o644);
      assert.equal((await stat(executableFile)).mode & 0o777, 0o755);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('Docker command encodes the isolation policy and scenario environment', () => {
  const command = buildDockerCommand({
    revision: 'head',
    workspace: 'C:/workspace',
    command: ['node', 'scenario.mjs'],
    cwd: '.',
    environment: { PATH: 'host-path', PATCHPROOF_REVISION: 'head' },
    timeoutMs: 2000,
    outputBytes: 4096,
    secrets: [],
    policy,
  });
  assert.equal(command[0], 'docker');
  assert.ok(command.includes('--network'));
  assert.ok(command.includes('none'));
  assert.ok(command.includes('--user'));
  assert.ok(command.includes('65532:65532'));
  assert.ok(command.includes('--cap-drop'));
  assert.ok(command.includes('ALL'));
  assert.ok(command.includes('no-new-privileges:true'));
  assert.ok(command.includes('PATCHPROOF_REVISION=head'));
  assert.equal(
    command.some((item) => item.includes('docker.sock')),
    false,
  );
  assert.throws(
    () =>
      buildDockerCommand({
        revision: 'head',
        workspace: 'C:/workspace',
        command: ['node'],
        cwd: '.',
        environment: {},
        timeoutMs: 2000,
        outputBytes: 4096,
        secrets: [],
        policy: { ...policy, network: 'allowlist', allowedHosts: ['registry.npmjs.org'] },
      }),
    /refusing unenforced egress/u,
  );
  assert.throws(
    () =>
      buildDockerCommand({
        revision: 'head',
        workspace: 'C:/unsafe,mount',
        command: ['node'],
        cwd: '.',
        environment: {},
        timeoutMs: 2000,
        outputBytes: 4096,
        secrets: [],
        policy,
      }),
    /unsafe mount delimiter/u,
  );
  assert.throws(
    () =>
      buildDockerCommand({
        revision: 'head',
        workspace: 'relative/workspace',
        command: ['node'],
        cwd: '.',
        environment: {},
        timeoutMs: 2000,
        outputBytes: 4096,
        secrets: [],
        policy,
      }),
    /absolute path/u,
  );
});

test('local backend executes argv without shell interpolation', async () => {
  const backend = new LocalProcessBackend();
  const result = await backend.run({
    revision: 'head',
    workspace: process.cwd(),
    command: ['node', '-e', 'console.log(process.argv[1])', 'literal;not-a-command'],
    cwd: '.',
    environment: { PATH: process.env.PATH ?? '' },
    timeoutMs: 2000,
    outputBytes: 4096,
    secrets: [],
    policy: {
      ...policy,
      backend: 'local',
      allowUnsafeLocal: true,
    },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /literal;not-a-command/u);
});

test('local backend reports timeouts and bounded output', async () => {
  const backend = new LocalProcessBackend();
  const result = await backend.run({
    revision: 'base',
    workspace: process.cwd(),
    command: ['node', '-e', 'setTimeout(() => {}, 5000)'],
    cwd: '.',
    environment: { PATH: process.env.PATH ?? '' },
    timeoutMs: 50,
    outputBytes: 1024,
    secrets: [],
    policy: {
      ...policy,
      backend: 'local',
      allowUnsafeLocal: true,
      timeoutMs: 50,
      outputBytes: 1024,
    },
  });
  assert.equal(result.timedOut, true);
});

test('local backend bounds only after streaming redaction', async () => {
  const backend = new LocalProcessBackend();
  const secret = 'split-secret-123';
  const result = await backend.run({
    revision: 'head',
    workspace: process.cwd(),
    command: [
      'node',
      '-e',
      `process.stdout.write('x'.repeat(10) + ${JSON.stringify(secret)} + 'y'.repeat(10000))`,
    ],
    cwd: '.',
    environment: { PATCHPROOF_REVISION: 'head' },
    launcherEnvironment: { PATH: process.env.PATH ?? '' },
    timeoutMs: 2000,
    outputBytes: 64,
    secrets: [secret],
    policy: {
      ...policy,
      backend: 'local',
      allowUnsafeLocal: true,
      outputBytes: 64,
    },
  });
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 64);
  assert.ok(result.stdoutSizeBytes >= Buffer.byteLength(result.stdout, 'utf8'));
});
