import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

async function transform(path, operation) {
  const source = await readFile(path, 'utf8');
  const next = operation(source);
  if (next === source) throw new Error(`No change produced for ${path}`);
  await writeFile(path, next, 'utf8');
}

function replaceOnce(source, before, after, path) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Expected text was not found in ${path}`);
  if (source.indexOf(before, first + before.length) >= 0)
    throw new Error(`Expected text is not unique in ${path}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceSection(source, startMarker, endMarker, replacement, path) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Start marker was not found in ${path}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`End marker was not found in ${path}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

await transform('packages/config/src/validate.ts', (source) =>
  replaceOnce(
    source,
    "        'Local backend is denied unless allowUnsafeLocal is explicitly true and the CLI receives --allow-unsafe-local',",
    "        'Local backend is denied unless allowUnsafeLocal is explicitly true; --allow-unsafe-local is only required when overriding a Docker config',",
    'packages/config/src/validate.ts',
  ),
);

for (const path of ['packages/runner/src/workspace.ts', 'packages/core/src/evidence.ts']) {
  await transform(path, (source) =>
    replaceOnce(
      source,
      "    'yarn.lock',\n    'npm-shrinkwrap.json',",
      "    'yarn.lock',\n    'npm-shrinkwrap.json',\n    'uv.lock',\n    'poetry.lock',\n    'Pipfile.lock',",
      path,
    ),
  );
}

await transform('packages/runner/src/process.ts', (source) => {
  let next = replaceOnce(
    source,
    "function newOutputState(): OutputState {\n  return { parts: [], storedBytes: 0, redactedBytes: 0, truncated: false };\n}\n",
    "function newOutputState(): OutputState {\n  return { parts: [], storedBytes: 0, redactedBytes: 0, truncated: false };\n}\n\nfunction sharedStreamLimit(\n  target: OutputState,\n  other: OutputState,\n  totalLimit: number,\n): number {\n  const remaining = Math.max(0, totalLimit - target.storedBytes - other.storedBytes);\n  return target.storedBytes + remaining;\n}\n",
    'packages/runner/src/process.ts',
  );
  const replacements = [
    [
      'appendChunk(stdout, stdoutDecoder.write(chunk), stdoutRedactor, spec.outputBytes)',
      'appendChunk(\n              stdout,\n              stdoutDecoder.write(chunk),\n              stdoutRedactor,\n              sharedStreamLimit(stdout, stderr, spec.outputBytes),\n            )',
    ],
    [
      'appendChunk(stderr, stderrDecoder.write(chunk), stderrRedactor, spec.outputBytes)',
      'appendChunk(\n              stderr,\n              stderrDecoder.write(chunk),\n              stderrRedactor,\n              sharedStreamLimit(stderr, stdout, spec.outputBytes),\n            )',
    ],
    [
      'appendChunk(stdout, stdoutDecoder.end(), stdoutRedactor, spec.outputBytes)',
      'appendChunk(\n        stdout,\n        stdoutDecoder.end(),\n        stdoutRedactor,\n        sharedStreamLimit(stdout, stderr, spec.outputBytes),\n      )',
    ],
    [
      'appendRedacted(stdout, stdoutTail, spec.outputBytes)',
      'appendRedacted(stdout, stdoutTail, sharedStreamLimit(stdout, stderr, spec.outputBytes))',
    ],
    [
      'appendChunk(stderr, stderrDecoder.end(), stderrRedactor, spec.outputBytes)',
      'appendChunk(\n        stderr,\n        stderrDecoder.end(),\n        stderrRedactor,\n        sharedStreamLimit(stderr, stdout, spec.outputBytes),\n      )',
    ],
    [
      'appendRedacted(stderr, stderrTail, spec.outputBytes)',
      'appendRedacted(stderr, stderrTail, sharedStreamLimit(stderr, stdout, spec.outputBytes))',
    ],
  ];
  for (const [before, after] of replacements)
    next = replaceOnce(next, before, after, 'packages/runner/src/process.ts');
  return next;
});

await transform('packages/runner/src/docker.ts', (source) =>
  replaceOnce(
    source,
    '// Scenario values are already explicit --env arguments in command. They\n    // never enter the host process environment used to launch Docker.',
    '// Scenario values are already isolated in the private --env-file argument. They\n    // never enter the host process environment used to launch Docker.',
    'packages/runner/src/docker.ts',
  ),
);

await transform('packages/cli/src/cli.ts', (source) => {
  let next = replaceOnce(
    source,
    '  patchproof doctor [--json]',
    '  patchproof doctor [--dev] [--json]',
    'packages/cli/src/cli.ts',
  );
  const doctor = `async function doctorCommand(args: ParsedArgs): Promise<number> {
  const packageManager = 'pnpm@11.16.0';
  const developer = hasOption(args, 'dev');
  const node = nodeMajorVersion();
  const checks: Record<string, DoctorCheck> = {
    node: doctorCheck(
      node >= 22,
      true,
      \`${process.version}; supported Node.js is >=22.0.0 (detected major \${node})\`,
    ),
    sqlite: probeSqlite(),
  };
  if (developer) checks.pnpm = await probePnpm();
  try {
    const docker = await execFileAsync(
      'docker',
      ['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'],
      {
        windowsHide: true,
        timeout: DOCTOR_TIMEOUT_MS,
        shell: false,
        maxBuffer: 64 * 1024,
      },
    );
    const versions = docker.stdout.trim();
    checks.docker = doctorCheck(
      versions.length > 0 && !versions.endsWith('/'),
      false,
      versions.length > 0
        ? \`Docker CLI/daemon reachable (\${versions})\`
        : 'Docker CLI returned no daemon version; production Docker runs cannot start here',
    );
  } catch (error) {
    checks.docker = doctorCheck(
      false,
      false,
      \`Docker CLI/daemon unavailable (warning for local development): \${error instanceof Error ? error.message : String(error)}\`,
    );
  }
  const requiredChecks = Object.values(checks).filter((item) => item.required);
  const requiredOk = requiredChecks.every((item) => item.ok);
  const output = {
    ok: requiredOk,
    requiredOk,
    packageManager,
    developer,
    checks,
    note: developer
      ? 'Developer checks require the repository pnpm version; Docker remains required only for production runs.'
      : 'Runtime checks do not require pnpm; use patchproof doctor --dev for contributor toolchain checks. Docker is required for production runs but remains optional for local development.',
  };
  if (hasOption(args, 'json')) jsonOutput(output);
  else
    console.log(
      Object.entries(output.checks)
        .map(
          ([key, value]) =>
            \`\${value.ok ? 'OK' : value.required ? 'FAIL' : 'WARN'} \${key}: \${value.detail}\`,
        )
        .join('\\n'),
    );
  return requiredOk ? 0 : 2;
}`;
  next = replaceSection(
    next,
    'async function doctorCommand(args: ParsedArgs): Promise<number> {',
    '\n\n/** Every option each command accepts;',
    `${doctor}\n\n/** Every option each command accepts;`,
    'packages/cli/src/cli.ts',
  );
  next = replaceOnce(
    next,
    "  doctor: ['json', 'help'],",
    "  doctor: ['dev', 'json', 'help'],",
    'packages/cli/src/cli.ts',
  );
  return next;
});

await transform('docs/cli-reference.md', (source) =>
  replaceOnce(
    source,
    '| `doctor`                               | Report Node, pnpm, Docker, and local SQLite capability.',
    '| `doctor [--dev]`                       | Report runtime Node, Docker, and local SQLite capability; `--dev` also requires the repository pnpm version.',
    'docs/cli-reference.md',
  ),
);

const migrationHelper = `import { DatabaseSync } from 'node:sqlite';

export interface SqliteColumnMigration {
  table: string;
  column: string;
  sql: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function existingColumns(database: DatabaseSync, table: string): Set<string> {
  if (!IDENTIFIER.test(table)) throw new Error('SQLite migration table name is invalid');
  const rows = database.prepare(\`PRAGMA table_info(\${table})\`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
}

/** Add only genuinely missing columns; all other SQLite failures propagate. */
export function applySqliteColumnMigrations(
  database: DatabaseSync,
  migrations: readonly SqliteColumnMigration[],
): void {
  const cache = new Map<string, Set<string>>();
  for (const migration of migrations) {
    if (!IDENTIFIER.test(migration.table) || !IDENTIFIER.test(migration.column))
      throw new Error('SQLite migration identifier is invalid');
    let columns = cache.get(migration.table);
    if (columns === undefined) {
      columns = existingColumns(database, migration.table);
      cache.set(migration.table, columns);
    }
    if (columns.has(migration.column)) continue;
    database.exec(migration.sql);
    columns.add(migration.column);
  }
}
`;
await writeFile('apps/github-app/src/sqlite-migrations.ts', migrationHelper, 'utf8');

await transform('apps/github-app/src/queue.ts', (source) => {
  let next = replaceOnce(
    source,
    "import { DatabaseSync } from 'node:sqlite';",
    "import { DatabaseSync } from 'node:sqlite';\nimport { applySqliteColumnMigrations } from './sqlite-migrations.js';",
    'apps/github-app/src/queue.ts',
  );
  const before = `    for (const column of [
      'ALTER TABLE patchproof_jobs ADD COLUMN installation_id INTEGER',
      'ALTER TABLE patchproof_jobs ADD COLUMN head_repository TEXT',
      'ALTER TABLE patchproof_jobs ADD COLUMN fork INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE patchproof_jobs ADD COLUMN evidence_path TEXT',
      'ALTER TABLE patchproof_jobs ADD COLUMN outcome TEXT',
      'ALTER TABLE patchproof_jobs ADD COLUMN failure_notified INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE patchproof_jobs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0',
    ]) {
      try {
        this.database.exec(column);
      } catch {
        // The column already exists in a previously initialized local database.
      }
    }`;
  const after = `    applySqliteColumnMigrations(this.database, [
      { table: 'patchproof_jobs', column: 'installation_id', sql: 'ALTER TABLE patchproof_jobs ADD COLUMN installation_id INTEGER' },
      { table: 'patchproof_jobs', column: 'head_repository', sql: 'ALTER TABLE patchproof_jobs ADD COLUMN head_repository TEXT' },
      { table: 'patchproof_jobs', column: 'fork', sql: 'ALTER TABLE patchproof_jobs ADD COLUMN fork INTEGER NOT NULL DEFAULT 0' },
      { table: 'patchproof_jobs', column: 'evidence_path', sql: 'ALTER TABLE patchproof_jobs ADD COLUMN evidence_path TEXT' },
      { table: 'patchproof_jobs', column: 'outcome', sql: 'ALTER TABLE patchproof_jobs ADD COLUMN outcome TEXT' },
      { table: 'patchproof_jobs', column: 'failure_notified', sql: 'ALTER TABLE patchproof_jobs ADD COLUMN failure_notified INTEGER NOT NULL DEFAULT 0' },
      { table: 'patchproof_jobs', column: 'lease_generation', sql: 'ALTER TABLE patchproof_jobs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0' },
    ]);`;
  return replaceOnce(next, before, after, 'apps/github-app/src/queue.ts');
});

await transform('apps/github-app/src/sqlite.ts', (source) => {
  let next = replaceOnce(
    source,
    "import { DatabaseSync } from 'node:sqlite';",
    "import { DatabaseSync } from 'node:sqlite';\nimport { applySqliteColumnMigrations } from './sqlite-migrations.js';",
    'apps/github-app/src/sqlite.ts',
  );
  const before = `      for (const column of [
        "ALTER TABLE deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'",
        'ALTER TABLE deliveries ADD COLUMN claimed_at TEXT',
        'ALTER TABLE deliveries ADD COLUMN completed_at TEXT',
        'ALTER TABLE deliveries ADD COLUMN last_error TEXT',
        'ALTER TABLE runs ADD COLUMN app_id INTEGER',
        'ALTER TABLE managed_checks ADD COLUMN app_id INTEGER',
        'ALTER TABLE managed_comments ADD COLUMN app_id INTEGER',
        'ALTER TABLE publication_claims ADD COLUMN app_id INTEGER',
        'ALTER TABLE publication_claims ADD COLUMN renewed_at TEXT',
        'ALTER TABLE publication_claims ADD COLUMN expires_at TEXT',
        'ALTER TABLE publication_claims ADD COLUMN lease_version INTEGER NOT NULL DEFAULT 1',
      ]) {
        try {
          this.database.exec(column);
        } catch {
          // Existing databases already have the migration column.
        }
      }`;
  const after = `      applySqliteColumnMigrations(this.database, [
        { table: 'deliveries', column: 'status', sql: "ALTER TABLE deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'" },
        { table: 'deliveries', column: 'claimed_at', sql: 'ALTER TABLE deliveries ADD COLUMN claimed_at TEXT' },
        { table: 'deliveries', column: 'completed_at', sql: 'ALTER TABLE deliveries ADD COLUMN completed_at TEXT' },
        { table: 'deliveries', column: 'last_error', sql: 'ALTER TABLE deliveries ADD COLUMN last_error TEXT' },
        { table: 'runs', column: 'app_id', sql: 'ALTER TABLE runs ADD COLUMN app_id INTEGER' },
        { table: 'managed_checks', column: 'app_id', sql: 'ALTER TABLE managed_checks ADD COLUMN app_id INTEGER' },
        { table: 'managed_comments', column: 'app_id', sql: 'ALTER TABLE managed_comments ADD COLUMN app_id INTEGER' },
        { table: 'publication_claims', column: 'app_id', sql: 'ALTER TABLE publication_claims ADD COLUMN app_id INTEGER' },
        { table: 'publication_claims', column: 'renewed_at', sql: 'ALTER TABLE publication_claims ADD COLUMN renewed_at TEXT' },
        { table: 'publication_claims', column: 'expires_at', sql: 'ALTER TABLE publication_claims ADD COLUMN expires_at TEXT' },
        { table: 'publication_claims', column: 'lease_version', sql: 'ALTER TABLE publication_claims ADD COLUMN lease_version INTEGER NOT NULL DEFAULT 1' },
      ]);`;
  return replaceOnce(next, before, after, 'apps/github-app/src/sqlite.ts');
});

const regressionTest = `import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { canonicalize, createIntegrity, verifyEvidenceBundle, type EvidenceBundle } from '@patchproof/core';
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
    await writeFile(join(root, 'uv.lock'), 'version = 1\\n', 'utf8');
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
    await writeFile(bundlePath, \`${canonicalize(bundle)}\\n\`, 'utf8');
    const verified = await verifyEvidenceBundle(bundlePath);
    assert.equal(verified.valid, true, verified.errors.join('\\n'));
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
  const parsed = parseConfigText(\`version: 1
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
\`);
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
`;
await writeFile('test/v094-regressions.test.ts', regressionTest, 'utf8');
await transform('test/index.test.ts', (source) => {
  if (source.includes("import './v094-regressions.test.ts';")) return source;
  return `${source.trimEnd()}\nimport './v094-regressions.test.ts';\n`;
});

const packages = [
  'package.json',
  'apps/github-app/package.json',
  'packages/cli/package.json',
  'packages/config/package.json',
  'packages/core/package.json',
  'packages/github/package.json',
  'packages/report/package.json',
  'packages/runner/package.json',
  'packages/testkit/package.json',
];
for (const path of packages) {
  await transform(path, (source) =>
    replaceOnce(source, '"version": "0.9.3"', '"version": "0.9.4"', path),
  );
}
await transform('packages/cli/src/bundle.ts', (source) =>
  replaceOnce(
    source,
    "product: { name: 'PatchProof', version: '0.9.3' },",
    "product: { name: 'PatchProof', version: '0.9.4' },",
    'packages/cli/src/bundle.ts',
  ),
);

await transform('CHANGELOG.md', (source) =>
  replaceOnce(
    source,
    '## Unreleased\n',
    `## Unreleased\n\n## 0.9.4 - 2026-10-07\n\n- Make SQLite schema upgrades inspect existing columns and propagate genuine migration failures instead of swallowing every ALTER TABLE error.\n- Isolate GitHub source fetches from host global Git configuration and keep credentials out of argv.\n- Align local-backend diagnostics with the post-0.9.2 policy behavior.\n- Record Python lockfiles (uv, Poetry, and Pipenv) in dependency evidence and accept them during verification.\n- Enforce outputBytes as one shared stdout/stderr budget.\n- Make patchproof doctor a runtime check by default; contributor pnpm validation moves behind --dev.\n- Refresh Docker launcher security commentary and add regression coverage for the hardening changes.\n`,
    'CHANGELOG.md',
  ),
);

console.log('Applied PatchProof v0.9.4 hardening changes.');
