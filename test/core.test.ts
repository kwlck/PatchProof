import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  classifyOutcome,
  classifyOutcomeGuarded,
  createIntegrity,
  evidenceDigest,
  matchesWithinDeadline,
  PatternDeadlineExceededError,
  redactAndBound,
  sha256,
  StreamingRedactor,
  verifyEvidenceBundle,
  type EvidenceBundle,
} from '@patchproof/core';

const CHECKS = {
  schema: true,
  trustedScenario: true,
  baseSource: true,
  headSource: true,
  baseExecution: true,
  headExecution: true,
  logsPersisted: true,
  artifactHashes: true,
  cleanup: true,
};

function unsignedBundle(): Omit<EvidenceBundle, 'integrity'> {
  const execution = (revision: 'base' | 'head'): EvidenceBundle['executions']['base'] => ({
    revision,
    command: ['node', 'scenario.mjs'],
    cwd: '.',
    environment: { CI: '1', PATCHPROOF_REVISION: revision },
    launcherEnvironment: { omitted: true, keys: ['PATH'], sha256: '0'.repeat(64) },
    toolchain: {
      node: 'v24.8.0',
      platform: 'win32',
      arch: 'x64',
      runner: '@patchproof/runner/test',
      dependencyLock: { status: 'not-detected' },
    },
    exitCode: revision === 'base' ? 1 : 0,
    timedOut: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
    stdout: {
      artifactId: `${revision}-stdout`,
      preview: revision === 'head' ? 'fixed' : '',
      truncated: false,
      sizeBytes: revision === 'head' ? 5 : 0,
    },
    stderr: {
      artifactId: `${revision}-stderr`,
      preview: revision === 'base' ? 'EXPECTED_BUG parser-regression\n' : '',
      truncated: false,
      sizeBytes: revision === 'base' ? 31 : 0,
    },
  });
  return {
    schemaVersion: 1,
    product: { name: 'PatchProof', version: '0.1.0' },
    bundleId: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-01-01T00:00:00.000Z',
    outcome: 'PASS',
    verdict: 'The trusted scenario failed on base and passed on head.',
    scenario: {
      id: 'test',
      name: 'Test scenario',
      command: ['node', 'scenario.mjs'],
      cwd: '.',
      trustedSource: 'base',
      file: 'scenario.mjs',
      expectedFailure: {
        exitCode: 1,
        reasonPattern: 'EXPECTED_BUG',
        reasonClass: 'parser-regression',
      },
      sha256: '1'.repeat(64),
    },
    sources: {
      base: {
        revision: 'base',
        ref: 'base',
        sha256: '2'.repeat(64),
        kind: 'directory-tree',
        location: 'fixtures/base',
      },
      head: {
        revision: 'head',
        ref: 'head',
        sha256: '3'.repeat(64),
        kind: 'directory-tree',
        location: 'fixtures/head',
      },
    },
    policy: {
      backend: 'local',
      network: 'none',
      allowedHosts: [],
      unsafeLocalProcess: true,
      fork: false,
      trustedConfigRevision: 'base',
      limits: { timeoutMs: 1_000, outputBytes: 4_096, memoryMb: 64, cpuCount: 1, pids: 16 },
    },
    executions: { base: execution('base'), head: execution('head') },
    artifacts: [],
    completeness: { complete: true, checks: CHECKS, missing: [] },
    replay: {
      supported: true,
      baseLocation: 'fixtures/base',
      headLocation: 'fixtures/head',
      requiresExplicitConfirmation: true,
      recordedEnvironment: { node: 'v24.8.0', platform: 'win32', arch: 'x64' },
    },
  };
}

async function createValidBundle(root: string): Promise<EvidenceBundle> {
  const files = [
    ['base-stdout', 'artifacts/base.stdout.log', ''],
    ['base-stderr', 'artifacts/base.stderr.log', 'EXPECTED_BUG parser-regression\n'],
    ['head-stdout', 'artifacts/head.stdout.log', 'fixed'],
    ['head-stderr', 'artifacts/head.stderr.log', ''],
  ] as const;
  const artifacts: EvidenceBundle['artifacts'] = [];
  await mkdir(join(root, 'artifacts'), { recursive: true });
  for (const [id, relativePath, content] of files) {
    await writeFile(join(root, relativePath), content, 'utf8');
    const bytes = Buffer.from(content, 'utf8');
    artifacts.push({
      id,
      relativePath,
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      mediaType: 'text/plain',
    });
  }
  const base = unsignedBundle();
  base.artifacts = artifacts;
  base.executions.base.stdout.artifactId = 'base-stdout';
  base.executions.base.stderr.artifactId = 'base-stderr';
  base.executions.head.stdout.artifactId = 'head-stdout';
  base.executions.head.stderr.artifactId = 'head-stderr';
  return { ...base, integrity: createIntegrity(base) };
}

async function writeBundle(root: string, bundle: EvidenceBundle): Promise<string> {
  const path = join(root, 'patchproof.evidence.json');
  await writeFile(path, `${canonicalize(bundle)}\n`, 'utf8');
  return path;
}

function cloneBundle(bundle: EvidenceBundle): EvidenceBundle {
  const unsigned = JSON.parse(JSON.stringify(bundle)) as Omit<EvidenceBundle, 'integrity'>;
  delete (unsigned as unknown as Record<string, unknown>).integrity;
  return { ...unsigned, integrity: createIntegrity(unsigned) };
}

test('classification only returns PASS for expected fail to head pass', () => {
  const base = { exitCode: 1, timedOut: false, output: 'EXPECTED_BUG parser-regression' };
  const head = { exitCode: 0, timedOut: false, output: 'fixed' };
  assert.equal(
    classifyOutcome({
      base,
      head,
      expectedFailure: {
        exitCode: 1,
        reasonPattern: 'EXPECTED_BUG',
        reasonClass: 'parser-regression',
      },
      complete: true,
    }).outcome,
    'PASS',
  );
  assert.equal(
    classifyOutcome({
      base: { ...base, exitCode: 0 },
      head,
      expectedFailure: { exitCode: 1 },
      complete: true,
    }).outcome,
    'INCONCLUSIVE',
  );
  assert.equal(
    classifyOutcome({
      base,
      head: { ...head, exitCode: 1 },
      expectedFailure: { exitCode: 1 },
      complete: true,
    }).outcome,
    'FAIL',
  );
  assert.equal(
    classifyOutcome({ base, head, expectedFailure: { exitCode: 1 }, complete: false }).outcome,
    'INCONCLUSIVE',
  );
  assert.equal(
    classifyOutcome({
      base,
      head,
      expectedFailure: { exitCode: 1 },
      policyDenied: 'no',
      complete: true,
    }).outcome,
    'POLICY_DENIED',
  );
  assert.equal(
    classifyOutcome({
      base: { ...base, timedOut: true, error: 'Execution exceeded the timeout' },
      head,
      expectedFailure: { exitCode: 1 },
      complete: true,
    }).outcome,
    'INCONCLUSIVE',
  );
});

test('canonical serialization, artifact integrity, and strict semantic verification detect mutation', async () => {
  const first = canonicalize({ z: 1, a: { b: true, a: null }, list: [2, 1] });
  const second = canonicalize({ list: [2, 1], a: { a: null, b: true }, z: 1 });
  assert.equal(first, second);
  const root = await mkdtemp(join(tmpdir(), 'patchproof-core-'));
  const bundle = await createValidBundle(root);
  const path = await writeBundle(root, bundle);
  assert.equal((await verifyEvidenceBundle(path)).valid, true);
  const duplicateKeyDocument = canonicalize(bundle).replace(/^\{/u, '{"outcome":"PASS",');
  await writeFile(path, `${duplicateKeyDocument}\n`, 'utf8');
  const duplicateKeyResult = await verifyEvidenceBundle(path);
  assert.equal(duplicateKeyResult.valid, false);
  assert.ok(duplicateKeyResult.errors.some((error) => error.includes('duplicate object key')));
  await writeBundle(root, bundle);
  const dockerBundle = cloneBundle(bundle);
  dockerBundle.policy.backend = 'docker';
  dockerBundle.policy.unsafeLocalProcess = false;
  for (const revision of ['base', 'head'] as const) {
    dockerBundle.executions[revision].toolchain = {
      ...dockerBundle.executions[revision].toolchain,
      node: 'image:node:24-bookworm-slim',
      platform: 'container',
      arch: 'container',
      containerImage: 'node:24-bookworm-slim',
    };
  }
  await writeBundle(root, cloneBundle(dockerBundle));
  assert.equal((await verifyEvidenceBundle(path)).valid, true);
  const unsafeDockerBundle = cloneBundle(dockerBundle);
  unsafeDockerBundle.executions.base.toolchain.containerImage = '--privileged';
  await writeBundle(root, cloneBundle(unsafeDockerBundle));
  assert.equal((await verifyEvidenceBundle(path)).valid, false);
  await writeBundle(root, bundle);
  await writeFile(join(root, 'artifacts', 'base.stderr.log'), 'tampered', 'utf8');
  const artifactTamper = await verifyEvidenceBundle(path);
  assert.equal(artifactTamper.valid, false);
  assert.ok(artifactTamper.errors.some((error) => error.includes('Artifact')));
  await writeFile(
    join(root, 'artifacts', 'base.stderr.log'),
    'EXPECTED_BUG parser-regression\n',
    'utf8',
  );
  await writeBundle(root, { ...bundle, verdict: 'mutated' });
  assert.equal((await verifyEvidenceBundle(path)).valid, false);
  const unsafe = cloneBundle(bundle);
  unsafe.artifacts[0] = { ...unsafe.artifacts[0]!, relativePath: '../outside.txt' };
  await writeBundle(root, unsafe);
  const unsafeResult = await verifyEvidenceBundle(path);
  assert.equal(unsafeResult.valid, false);
  assert.ok(
    unsafeResult.errors.some(
      (error) => error.includes('safe relative path') || error.includes('Unsafe artifact path'),
    ),
  );
  assert.notEqual(evidenceDigest(bundle), '');
});

test('recomputed malformed and mutation-table bundles never verify', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-mutations-'));
  const bundle = await createValidBundle(root);
  const mutations: Array<[string, (value: Record<string, unknown>) => void]> = [
    [
      'missing head execution',
      (value) => delete (value.executions as Record<string, unknown>).head,
    ],
    ['empty artifacts', (value) => (value.artifacts = [])],
    ['unknown top-level field', (value) => (value.unexpected = true)],
    [
      'unknown nested field',
      (value) => ((value.policy as Record<string, unknown>).unexpected = true),
    ],
    [
      'missing dependency omission metadata',
      (value) => {
        const execution = (value.executions as Record<string, unknown>).base as Record<
          string,
          unknown
        >;
        const toolchain = execution.toolchain as Record<string, unknown>;
        delete toolchain.dependencyLock;
      },
    ],
    [
      'forged dependency omission metadata',
      (value) => {
        const execution = (value.executions as Record<string, unknown>).head as Record<
          string,
          unknown
        >;
        const toolchain = execution.toolchain as Record<string, unknown>;
        toolchain.dependencyLock = { status: 'not-detected', sha256: '0'.repeat(64) };
      },
    ],
    [
      'duplicate artifact id',
      (value) => {
        const artifacts = value.artifacts as Array<Record<string, unknown>>;
        artifacts[1]!.id = artifacts[0]!.id;
      },
    ],
    [
      'missing cross-reference',
      (value) => {
        ((value.executions as Record<string, unknown>).head as Record<string, unknown>).stdout = {
          ...(((value.executions as Record<string, unknown>).head as Record<string, unknown>)
            .stdout as Record<string, unknown>),
          artifactId: 'missing',
        };
      },
    ],
    ['wrong outcome', (value) => (value.outcome = 'FAIL')],
    [
      'base command differs from trusted scenario',
      (value) => {
        const execution = (value.executions as Record<string, unknown>).base as Record<
          string,
          unknown
        >;
        execution.command = ['node', 'attacker-controlled.mjs'];
      },
    ],
    [
      'head environment differs from base scenario',
      (value) => {
        const execution = (value.executions as Record<string, unknown>).head as Record<
          string,
          unknown
        >;
        execution.environment = {
          ...(execution.environment as Record<string, string>),
          PATCHPROOF_BYPASS: '1',
        };
      },
    ],
    [
      'reserved environment key',
      (value) => {
        const environment = (
          (value.executions as Record<string, unknown>).head as Record<string, unknown>
        ).environment as Record<string, unknown>;
        Object.defineProperty(environment, '__proto__', {
          value: 'unsafe',
          enumerable: true,
          configurable: true,
          writable: true,
        });
      },
    ],
    [
      'unsafe number',
      (value) =>
        ((
          (value.executions as Record<string, unknown>).base as Record<string, unknown>
        ).durationMs = Number.MAX_SAFE_INTEGER + 1),
    ],
    [
      'preview does not match artifact',
      (value) =>
        ((
          ((value.executions as Record<string, unknown>).base as Record<string, unknown>)
            .stderr as Record<string, unknown>
        ).preview = 'forged'),
    ],
    [
      'absolute source location',
      (value) =>
        (((value.sources as Record<string, unknown>).base as Record<string, unknown>).location =
          'C:\\Users\\operator\\source'),
    ],
    [
      'absolute directory source ref',
      (value) =>
        (((value.sources as Record<string, unknown>).base as Record<string, unknown>).ref =
          'C:\\Users\\operator\\source'),
    ],
    [
      'null exit without error',
      (value) =>
        (((value.executions as Record<string, unknown>).head as Record<string, unknown>).exitCode =
          null),
    ],
    [
      'unreferenced artifact',
      (value) => {
        const artifacts = value.artifacts as Array<Record<string, unknown>>;
        artifacts.push({
          id: 'unused',
          relativePath: 'artifacts/unused.log',
          sha256: '0'.repeat(64),
          sizeBytes: 0,
          mediaType: 'text/plain',
        });
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const value = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    mutate(value);
    const unsigned = value as unknown as Omit<EvidenceBundle, 'integrity'>;
    delete (unsigned as unknown as Record<string, unknown>).integrity;
    const mutated = { ...unsigned, integrity: createIntegrity(unsigned) };
    const path = await writeBundle(root, mutated);
    const result = await verifyEvidenceBundle(path);
    assert.equal(result.valid, false, name);
  }
  const incomplete = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
  incomplete.executions = { base: (incomplete.executions as Record<string, unknown>).base };
  incomplete.artifacts = [];
  incomplete.completeness = { complete: true, checks: { schema: true }, missing: [] };
  const malformedUnsigned = incomplete as unknown as Omit<EvidenceBundle, 'integrity'>;
  delete (malformedUnsigned as unknown as Record<string, unknown>).integrity;
  const malformed = { ...malformedUnsigned, integrity: createIntegrity(malformedUnsigned) };
  const malformedPath = await writeBundle(root, malformed);
  const malformedResult = await verifyEvidenceBundle(malformedPath);
  assert.equal(malformedResult.valid, false);
  assert.ok(
    malformedResult.errors.some((error) =>
      error.includes('executions is missing required field: head'),
    ),
  );
});

test('streaming redaction survives every adversarial split and keeps output bounding after redaction', () => {
  const cases = [
    ['configured', 'split-secret-123', 'x'.repeat(10) + 'split-secret-123' + 'y'.repeat(245)],
    ['unicode', 'unicode-🔐-secret', 'a'.repeat(7) + 'unicode-🔐-secret' + 'b'.repeat(17)],
    ['ghp', 'ghp_' + 'A'.repeat(24), 'prefix ghp_' + 'A'.repeat(24) + ' suffix'],
    ['xoxb', 'xoxb-' + 'a-b-'.repeat(7), 'prefix xoxb-' + 'a-b-'.repeat(7) + ' suffix'],
    ['akia', 'AKIA' + '0'.repeat(16), 'prefix AKIA' + '0'.repeat(16) + ' suffix'],
    ['bearer', 'bearer ' + 'a'.repeat(24), 'prefix bearer ' + 'a'.repeat(24) + ' suffix'],
    [
      'private',
      '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----',
      'prefix -----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY----- suffix',
    ],
  ] as const;
  for (const [name, secret, input] of cases) {
    for (let split = 0; split <= input.length; split += 1) {
      const redactor = new StreamingRedactor(
        name === 'configured' || name === 'unicode' ? [secret] : [],
      );
      const output =
        redactor.push(input.slice(0, split)) +
        redactor.push(input.slice(split)) +
        redactor.finish();
      assert.equal(output.includes(secret), false, `${name} leaked at split ${split}`);
      assert.equal(
        output.includes('[REDACTED]'),
        true,
        `${name} was not redacted at split ${split}`,
      );
    }
    for (const chunkSize of [1, 2, 5, 17, 4096]) {
      const redactor = new StreamingRedactor(
        name === 'configured' || name === 'unicode' ? [secret] : [],
      );
      let output = '';
      for (let offset = 0; offset < input.length; offset += chunkSize)
        output += redactor.push(input.slice(offset, offset + chunkSize));
      output += redactor.finish();
      assert.equal(output.includes(secret), false, `${name} leaked with chunk size ${chunkSize}`);
      assert.equal(
        output.includes('[REDACTED]'),
        true,
        `${name} was not redacted with chunk size ${chunkSize}`,
      );
    }
  }
  const overlap = new StreamingRedactor(['abcdef', 'abc']);
  const overlapOutput =
    [...'xxabcdefyy'].map((character) => overlap.push(character)).join('') + overlap.finish();
  assert.equal(overlapOutput.includes('abcdef'), false);
  const longSecret = 'L'.repeat(1_000);
  const long = new StreamingRedactor([longSecret]);
  const longOutput =
    long.push(`q${longSecret.slice(0, 500)}`) + long.push(longSecret.slice(500)) + long.finish();
  assert.equal(longOutput.includes(longSecret), false);
  const hugeSecret = 'Bearer ' + 'z'.repeat(100_000);
  const huge = new StreamingRedactor([hugeSecret]);
  const hugeOutput = huge.push('Bearer ' + 'z'.repeat(131_072)) + huge.finish();
  assert.equal(hugeOutput.includes(hugeSecret), false);
  const boundarySecret = 'split-secret-123';
  for (const prefixLength of [0, 1, 127, 255, 256, 257, 1023, 4095, 4096, 4097]) {
    const boundaryInput =
      'x'.repeat(prefixLength) + boundarySecret + 'y'.repeat(5_000) + boundarySecret;
    for (const chunkSize of [1, 17, 255, 256, 257, 1024, 4096]) {
      const boundary = new StreamingRedactor([boundarySecret]);
      let output = '';
      for (let offset = 0; offset < boundaryInput.length; offset += chunkSize)
        output += boundary.push(boundaryInput.slice(offset, offset + chunkSize));
      output += boundary.finish();
      assert.equal(
        output.includes(boundarySecret),
        false,
        `boundary leak ${prefixLength}/${chunkSize}`,
      );
      assert.equal(
        output.includes('[REDACTED]'),
        true,
        `boundary redaction ${prefixLength}/${chunkSize}`,
      );
    }
  }
  for (const secret of ['REDACTED', '[REDACTED]', '[', 'MASKED']) {
    const redactor = new StreamingRedactor([secret]);
    const output = redactor.push(`prefix ${secret} suffix`) + redactor.finish();
    assert.equal(output.includes(secret), false, `replacement marker leaked ${secret}`);
  }
  assert.equal(redactAndBound('AKIA' + '0'.repeat(16) + ' and unicode ✓', [], 10).truncated, true);
});

test('guarded pattern matching bounds hostile regular expressions without blocking the caller', async () => {
  assert.equal(await matchesWithinDeadline('a+b', '', 'aaaab', 1_000), true);
  assert.equal(await matchesWithinDeadline('a+c', '', 'aaab', 1_000), false);
  await assert.rejects(matchesWithinDeadline('a', '', 'a', 0), TypeError);
  await assert.rejects(matchesWithinDeadline('a', '', 'a', Number.NaN), TypeError);
  await assert.rejects(
    matchesWithinDeadline('(a+)+$', '', `${'a'.repeat(64)}b`, 25),
    PatternDeadlineExceededError,
  );
});

test('guarded classification mirrors synchronous classification decisions', async () => {
  const base = { exitCode: 1, timedOut: false, output: 'EXPECTED_BUG parser-regression' };
  const head = { exitCode: 0, timedOut: false, output: 'fixed' };
  const input = {
    base,
    head,
    expectedFailure: { exitCode: 1, reasonPattern: 'EXPECTED_BUG' },
    complete: true,
  } as const;
  const guarded = await classifyOutcomeGuarded(input);
  const synchronous = classifyOutcome(input);
  assert.equal(guarded.outcome, synchronous.outcome);
  assert.equal(guarded.verdict, synchronous.verdict);
  assert.equal(guarded.outcome, 'PASS');
  const duplicatePatterns = await classifyOutcomeGuarded({
    base,
    head,
    expectedFailure: { exitCode: 1, reasonPattern: 'EXPECTED_BUG', reasonClass: 'EXPECTED_BUG' },
    complete: true,
  });
  assert.equal(duplicatePatterns.outcome, 'PASS');
});

test('verification fails closed when outcome recomputation exceeds the pattern deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-core-redos-'));
  const bundle = await createValidBundle(root);
  await writeBundle(root, bundle);
  assert.equal((await verifyEvidenceBundle(join(root, 'patchproof.evidence.json'))).valid, true);
  const hostile = cloneBundle(bundle);
  hostile.scenario.expectedFailure.reasonPattern = '(?:a+)+$';
  const hostileBaseStderr = `${'a'.repeat(96)}EXPECTED_BUG parser-regression\n`;
  await writeFile(join(root, 'artifacts', 'base.stderr.log'), hostileBaseStderr, 'utf8');
  const baseStderrArtifact = hostile.artifacts.find((artifact) => artifact.id === 'base-stderr')!;
  baseStderrArtifact.sha256 = sha256(Buffer.from(hostileBaseStderr, 'utf8'));
  baseStderrArtifact.sizeBytes = Buffer.byteLength(hostileBaseStderr, 'utf8');
  const hostilePath = await writeBundle(root, hostile);
  const result = await verifyEvidenceBundle(hostilePath);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error) => error.includes('regular-expression evaluation deadline')),
  );
});
