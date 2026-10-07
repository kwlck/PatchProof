import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  canonicalize,
  createIntegrity,
  verifyEvidenceBundle,
  type EvidenceBundle,
} from '@patchproof/core';
import { parseConfigText } from '@patchproof/config';
import { hashKnownLockfile, LocalProcessBackend, type ExecutionSpec } from '@patchproof/runner';
import { applySqliteColumnMigrations } from '../apps/github-app/dist/sqlite-migrations.js';

const execFileAsync = promisify(execFile);

function localSpec(outputBytes: number): ExecutionSpec {
  return {
    revision: 'base',
    workspace: process.cwd(),
    command: [
      process.execPath,
      '-e',
      "process.stdout.write('a'.repeat(700)); process.stderr.write('b'.repeat(700)); setTimeout(() => {}, 500)",
    ],
    cwd: '.',
    environment: {},
    launcherEnvironment: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    },
    timeoutMs: 2_000,
    outputBytes,
    secrets: [],
    policy: {
      backend: 'local',
      allowUnsafeLocal: true,
      allowFork: false,
      network: 'none',
      allowedHosts: [],
      timeoutMs: 2_000,
      outputBytes,
      memoryMb: 64,
      cpuCount: 1,
      pids: 16,
      dockerImage: 'node:24-bookworm-slim',
      readOnlyRoot: true,
    },
  };
}

test('v0.9.4 recognizes Python dependency lockfiles in runner and evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-v094-lock-'));
  const fixture = await mkdtemp(join(tmpdir(), 'patchproof-v094-evidence-'));
  try {
    await writeFile(join(root, 'uv.lock'), 'version = 1\n', 'utf8');
    const lock = await hashKnownLockfile(root);
    assert.equal(lock?.file, 'uv.lock');

    await cp(resolve('docs/examples/fixture-proof'), fixture, { recursive: true });
    const bundlePath = join(fixture, 'patchproof.evidence.json');
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as EvidenceBundle;
    bundle.executions.base.toolchain.dependencyLock = {
      status: 'present',
      file: 'uv.lock',
      sha256: '0'.repeat(64),
    };
    bundle.executions.head.toolchain.dependencyLock = {
      status: 'present',
      file: 'poetry.lock',
      sha256: '1'.repeat(64),
    };
    const { integrity: _integrity, ...withoutIntegrity } = bundle;
    bundle.integrity = createIntegrity(withoutIntegrity);
    await writeFile(bundlePath, `${canonicalize(bundle)}\n`, 'utf8');
    const verified = await verifyEvidenceBundle(bundlePath);
    assert.equal(verified.valid, true, verified.errors.join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test('v0.9.4 enforces outputBytes across stdout and stderr together', async () => {
  const backend = new LocalProcessBackend();
  const limit = 1_024;
  const result = await backend.run(localSpec(limit));
  assert.equal(result.outputLimitHit, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= limit);
});

test('v0.9.4 SQLite migrations skip existing columns but propagate real failures', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE sample (id INTEGER)');
    applySqliteColumnMigrations(database, [
      { table: 'sample', column: 'id', sql: 'ALTER TABLE sample ADD COLUMN id INTEGER' },
      { table: 'sample', column: 'note', sql: 'ALTER TABLE sample ADD COLUMN note TEXT' },
    ]);
    const columns = database.prepare('PRAGMA table_info(sample)').all() as Array<{ name: string }>;
    assert.deepEqual(
      columns.map((column) => column.name),
      ['id', 'note'],
    );
    assert.throws(
      () =>
        applySqliteColumnMigrations(database, [
          {
            table: 'missing_table',
            column: 'note',
            sql: 'ALTER TABLE missing_table ADD COLUMN note TEXT',
          },
        ]),
      /no such table/iu,
    );
  } finally {
    database.close();
  }
});

test('v0.9.4 local backend warning reflects the actual CLI policy', () => {
  const parsed = parseConfigText(`version: 1
name: local warning
scenario:
  id: warning
  name: warning
  command: [node, scenario.mjs]
  expectedFailure:
    exitCode: 1
policy:
  backend: local
  allowUnsafeLocal: false
`);
  const warning = parsed.diagnostics.find((diagnostic) => diagnostic.path === 'policy');
  assert.match(warning?.message ?? '', /allowUnsafeLocal is explicitly true/u);
  assert.match(warning?.message ?? '', /only required when overriding a Docker config/u);
});

test('v0.9.4 doctor only requires pnpm in developer mode', async () => {
  const cli = resolve('packages/cli/dist/main.js');
  const environment = { ...process.env, PATH: '' };
  const runtime = await execFileAsync(process.execPath, [cli, 'doctor', '--json'], {
    env: environment,
    windowsHide: true,
  });
  const runtimeJson = JSON.parse(runtime.stdout) as {
    ok: boolean;
    developer: boolean;
    checks: Record<string, unknown>;
  };
  assert.equal(runtimeJson.ok, true);
  assert.equal(runtimeJson.developer, false);
  assert.equal('pnpm' in runtimeJson.checks, false);

  await assert.rejects(
    execFileAsync(process.execPath, [cli, 'doctor', '--dev', '--json'], {
      env: environment,
      windowsHide: true,
    }),
    (error: unknown) => {
      const candidate = error as { code?: unknown; stdout?: unknown };
      assert.equal(candidate.code, 2);
      const output = JSON.parse(String(candidate.stdout ?? '')) as {
        developer: boolean;
        checks: Record<string, { ok?: boolean }>;
      };
      assert.equal(output.developer, true);
      assert.equal(output.checks.pnpm?.ok, false);
      return true;
    },
  );
});
