import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDockerCommand,
  DockerBackend,
  applyOperatorPolicy,
  exportGitRevision,
  gitRefOf,
  hashKnownLockfile,
  isGitRef,
  isPolicyDeniedRun,
  LocalProcessBackend,
  prepareDockerWorkspace,
  runTwoRevisions,
} from '@patchproof/runner';
import type { PatchProofConfig } from '@patchproof/config';
import type { BackendExecution, ExecutionBackend, ExecutionSpec } from '@patchproof/runner';

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
  const command = buildDockerCommand(
    {
      revision: 'head',
      workspace: 'C:/workspace',
      command: ['node', 'scenario.mjs'],
      cwd: '.',
      environment: { PATH: 'host-path', PATCHPROOF_REVISION: 'head' },
      timeoutMs: 2000,
      outputBytes: 4096,
      secrets: [],
      policy,
    },
    { scenarioEnvFile: 'C:/tmp/scenario.env' },
  );
  assert.equal(command[0], 'docker');
  assert.ok(command.includes('--network'));
  assert.ok(command.includes('none'));
  assert.ok(command.includes('--user'));
  assert.ok(command.includes('65532:65532'));
  assert.ok(command.includes('--cap-drop'));
  assert.ok(command.includes('ALL'));
  assert.ok(command.includes('no-new-privileges:true'));
  // Scenario values travel through --env-file so they never appear in argv.
  assert.ok(command.includes('--memory-swap'));
  assert.ok(command.includes('--env-file'));
  assert.equal(
    command.some((item) => item.includes('PATCHPROOF_REVISION=')),
    false,
  );
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
        environment: { SCENARIO_ONLY: 'inside' },
        timeoutMs: 2000,
        outputBytes: 4096,
        secrets: [],
        policy,
      }),
    /scenarioEnvFile/u,
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
        policy: { ...policy, dockerImage: '--privileged' },
      }),
    /image/u,
  );
  const nested = buildDockerCommand(
    {
      revision: 'head',
      workspace: 'C:/workspace',
      command: ['node', 'scenario.mjs'],
      cwd: 'nested/project',
      environment: { SCENARIO_ONLY: 'inside' },
      timeoutMs: 2000,
      outputBytes: 4096,
      secrets: [],
      policy,
    },
    {
      containerName: 'patchproof-test-container',
      cidFile: 'C:/tmp/patchproof.cid',
      scenarioEnvFile: 'C:/tmp/scenario.env',
    },
  );
  assert.ok(nested.includes('--pull'));
  assert.ok(nested.includes('never'));
  assert.ok(nested.includes('--name'));
  assert.ok(nested.includes('patchproof-test-container'));
  assert.ok(nested.includes('--cidfile'));
  assert.ok(nested.includes('C:/tmp/patchproof.cid'));
  assert.ok(nested.includes('/workspace/nested/project'));
  assert.equal(nested.includes('--rm'), false);
});

test('operator policy constrains limits and requires approved immutable images', () => {
  const bounded = applyOperatorPolicy(policy, {
    forceDocker: true,
    maxTimeoutMs: 1000,
  });
  assert.equal(bounded.allowed, false);
  assert.match(bounded.reason ?? '', /timeoutMs/u);
  const digest = `node@sha256:${'a'.repeat(64)}`;
  const approved = applyOperatorPolicy(
    { ...policy, dockerImage: digest },
    {
      forceDocker: true,
      approvedDockerImages: [digest],
      requireDigestPinnedImages: true,
    },
  );
  assert.equal(approved.allowed, true);
  const unauthorized = applyOperatorPolicy(
    { ...policy, dockerImage: `node@sha256:${'b'.repeat(64)}` },
    {
      forceDocker: true,
      approvedDockerImages: [digest],
      requireDigestPinnedImages: true,
    },
  );
  assert.equal(unauthorized.allowed, false);
  assert.match(unauthorized.reason ?? '', /approved/u);
});

test('operator constraints inspect the effective Docker override', async () => {
  const config: PatchProofConfig = {
    version: 1,
    name: 'effective backend policy test',
    scenario: {
      id: 'effective-backend-policy',
      name: 'effective backend policy',
      command: ['node'],
      cwd: '.',
      expectedFailure: { exitCode: 1 },
      environment: {},
    },
    policy: { ...policy, backend: 'local', dockerImage: 'node:latest' },
    redaction: { secrets: [] },
  };
  const result = await runTwoRevisions({
    config,
    basePath: process.cwd(),
    headPath: process.cwd(),
    backendOverride: 'docker',
    trustedConfig: true,
    operatorPolicy: { forceDocker: true, requireDigestPinnedImages: true },
  });
  assert.equal(isPolicyDeniedRun(result), true);
  if (isPolicyDeniedRun(result)) assert.match(result.reason, /sha256/u);
});

test('local execution requires both trusted config opt-in and explicit caller opt-in', async () => {
  const config: PatchProofConfig = {
    version: 1,
    name: 'local opt-in test',
    scenario: {
      id: 'local-opt-in',
      name: 'local opt-in',
      command: ['node'],
      cwd: '.',
      expectedFailure: { exitCode: 1 },
      environment: {},
    },
    policy: { ...policy, backend: 'local', allowUnsafeLocal: false },
    redaction: { secrets: [] },
  };
  const run = await runTwoRevisions({
    config,
    basePath: process.cwd(),
    headPath: process.cwd(),
    backendOverride: 'local',
    allowUnsafeLocal: true,
    trustedConfig: true,
  });
  assert.equal(isPolicyDeniedRun(run), true);
  if (isPolicyDeniedRun(run)) assert.match(run.reason, /explicit unsafe opt-in/u);
});

function fakeExecution(overrides: Partial<BackendExecution> = {}): BackendExecution {
  return {
    exitCode: 0,
    timedOut: false,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutSizeBytes: 0,
    stderrSizeBytes: 0,
    ...overrides,
  };
}

test('Docker backend keeps scenario env out of launcher env and always cleans a named container', async () => {
  const calls: ExecutionSpec[] = [];
  const processBackend: ExecutionBackend = {
    kind: 'local',
    async run(spec) {
      calls.push(spec);
      if (spec.command[1] === 'image') return fakeExecution();
      if (spec.command[1] === 'run') {
        const cidIndex = spec.command.indexOf('--cidfile');
        const cidFile = spec.command[cidIndex + 1];
        assert.ok(cidFile);
        await writeFile(cidFile, `${'a'.repeat(64)}\n`, 'utf8');
        const envIndex = spec.command.indexOf('--env-file');
        const envFile = spec.command[envIndex + 1];
        assert.ok(envFile);
        const envContents = await readFile(envFile, 'utf8');
        assert.match(envContents, /^SCENARIO_ONLY=inside$/mu);
        assert.equal(envContents.includes('host-path'), false);
        return fakeExecution({ exitCode: 42 });
      }
      return fakeExecution();
    },
  };
  const result = await new DockerBackend(processBackend).run({
    revision: 'head',
    workspace: process.cwd(),
    command: ['node', 'scenario.mjs'],
    cwd: 'nested/project',
    environment: { SCENARIO_ONLY: 'inside', PATH: 'host-path' },
    launcherEnvironment: { PATH: 'host-path', SystemRoot: 'system', HOST_SECRET: 'never' },
    timeoutMs: 2000,
    outputBytes: 4096,
    secrets: [],
    policy,
  });
  assert.equal(result.exitCode, 42);
  assert.equal(result.error, undefined);
  const runCall = calls.find((call) => call.command[1] === 'run');
  assert.ok(runCall);
  assert.deepEqual(runCall.environment, {});
  assert.deepEqual(runCall.launcherEnvironment, { PATH: 'host-path', SystemRoot: 'system' });
  assert.ok(runCall.command.includes('--env-file'));
  assert.equal(
    runCall.command.some((item) => item.includes('SCENARIO_ONLY=')),
    false,
  );
  assert.equal(
    runCall.command.some((item) => item.includes('host-secret')),
    false,
  );
  const runName = runCall.command[runCall.command.indexOf('--name') + 1];
  assert.match(runName ?? '', /^patchproof-head-[0-9a-f]{32}$/u);
  assert.equal(calls.filter((call) => call.command[2] === 'stop').length, 1);
  assert.equal(calls.filter((call) => call.command[2] === 'kill').length, 1);
  assert.equal(calls.filter((call) => call.command[2] === 'rm').length, 1);
  assert.equal(
    calls.some((call) => call.command.includes('{{.Names}}')),
    true,
  );
});

test('Docker backend preserves a timeout while a SIGTERM-ignoring launcher settles', async () => {
  const processBackend: ExecutionBackend = {
    kind: 'local',
    async run(spec) {
      if (spec.command[1] === 'image') return fakeExecution();
      if (spec.command[1] === 'run') {
        const cidIndex = spec.command.indexOf('--cidfile');
        const cidFile = spec.command[cidIndex + 1];
        assert.ok(cidFile);
        // Model Docker CLI waiting for a container that ignored SIGTERM. The
        // real LocalProcessBackend resolves after its bounded SIGKILL path.
        await new Promise((resolve) => setTimeout(resolve, 800));
        await writeFile(cidFile, `${'b'.repeat(64)}\n`, 'utf8');
        return fakeExecution({
          exitCode: null,
          signal: 'SIGKILL',
          timedOut: true,
          error: 'Execution exceeded 50 ms',
        });
      }
      return fakeExecution();
    },
  };
  const result = await new DockerBackend(processBackend, { cleanupTimeoutMs: 100 }).run({
    revision: 'head',
    workspace: process.cwd(),
    command: ['node', 'scenario.mjs'],
    cwd: '.',
    environment: {},
    timeoutMs: 50,
    outputBytes: 1024,
    secrets: [],
    policy,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.error, 'Execution exceeded 50 ms');
});

test('Docker backend hard-settles a never-resolving provisioning backend', async () => {
  const processBackend: ExecutionBackend = {
    kind: 'local',
    run: async () => new Promise<BackendExecution>(() => undefined),
  };
  const started = performance.now();
  const result = await new DockerBackend(processBackend, {
    provisioningTimeoutMs: 20,
    cleanupTimeoutMs: 20,
  }).run({
    revision: 'head',
    workspace: process.cwd(),
    command: ['node'],
    cwd: '.',
    environment: {},
    timeoutMs: 20,
    outputBytes: 1024,
    secrets: [],
    policy,
  });
  assert.ok(performance.now() - started < 1000);
  assert.equal(result.exitCode, null);
  assert.match(result.error ?? '', /hard deadline|inspect failed/u);
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

test('local backend cancels a running process without shell interpolation', async () => {
  const controller = new AbortController();
  const backend = new LocalProcessBackend();
  const running = backend.run({
    revision: 'head',
    workspace: process.cwd(),
    command: ['node', '-e', 'setTimeout(() => {}, 5000)'],
    cwd: '.',
    environment: { PATH: process.env.PATH ?? '' },
    timeoutMs: 5000,
    outputBytes: 1024,
    secrets: [],
    signal: controller.signal,
    policy: {
      ...policy,
      backend: 'local',
      allowUnsafeLocal: true,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.match(result.error ?? '', /cancelled/u);
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

test('git revisions materialize as worktrees and clean up after themselves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-git-'));
  const execGit = (args: string[], cwd = root) =>
    new Promise<void>((resolveGit, rejectGit) => {
      const { execFile } = require('node:child_process') as typeof import('node:child_process');
      execFile('git', args, { cwd, windowsHide: true }, (error) =>
        error ? rejectGit(error) : resolveGit(),
      );
    });
  try {
    await execGit(['init']);
    await execGit(['config', 'user.email', 't@t']);
    await execGit(['config', 'user.name', 't']);
    await writeFile(join(root, 'lib.cjs'), 'module.exports = () => 1;', 'utf8');
    await execGit(['add', '.']);
    await execGit(['commit', '-m', 'base']);
    await writeFile(join(root, 'lib.cjs'), 'module.exports = () => 42;', 'utf8');
    await execGit(['add', '.']);
    await execGit(['commit', '-m', 'fix']);

    const baseRev = await exportGitRevision(root, 'HEAD~1');
    const headRev = await exportGitRevision(root, 'HEAD');
    const baseOut = await readFile(join(baseRev.path, 'lib.cjs'), 'utf8');
    const headOut = await readFile(join(headRev.path, 'lib.cjs'), 'utf8');
    assert.match(baseOut, /=> 1;/u);
    assert.match(headOut, /=> 42;/u);
    await baseRev.cleanup();
    await headRev.cleanup();
    await assert.rejects(readFile(join(baseRev.path, 'lib.cjs'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('git ref parsing accepts only the git: prefix with a payload', () => {
  assert.equal(isGitRef('git:HEAD~1'), true);
  assert.equal(isGitRef('git:main'), true);
  assert.equal(isGitRef('git:'), false);
  assert.equal(isGitRef('base-dir'), false);
  assert.equal(gitRefOf('git:HEAD~2'), 'HEAD~2');
});

test('config opt-in alone permits local execution without a CLI flag', async () => {
  const config: PatchProofConfig = {
    version: 1,
    name: 'local scaffold test',
    scenario: {
      id: 'local-scaffold',
      name: 'local scaffold',
      command: ['node'],
      cwd: '.',
      expectedFailure: { exitCode: 1 },
      environment: {},
    },
    policy: { ...policy, backend: 'local', allowUnsafeLocal: true },
    redaction: { secrets: [] },
  };
  const run = await runTwoRevisions({
    config,
    basePath: process.cwd(),
    headPath: process.cwd(),
    allowUnsafeLocal: false,
    trustedConfig: true,
  });
  assert.equal(isPolicyDeniedRun(run), false);
});
