import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AppValidationError,
  FixtureOverlaySourceAdapter,
  MAX_VALIDATION_DIAGNOSTIC_BYTES,
  MAX_VALIDATION_DIAGNOSTIC_CAUSE_DEPTH,
  VALIDATION_CLEANUP_STAGES,
  VALIDATION_EXIT_CODES,
  VALIDATION_PRIMARY_STAGES,
  VALIDATION_REASON_CODES,
  assertNoValidationArguments,
  assertSecretFreeText,
  buildValidationConfig,
  buildValidationContainerListCommand,
  buildValidationImage,
  buildValidationImageInventoryCommand,
  buildValidationImageCommand,
  buildValidationImageInspectCommand,
  buildValidationImageRemoveCommand,
  buildWebhookRequest,
  canonicalRepository,
  canonicalSyntheticPullRequest,
  cleanupValidationContainers,
  cleanupValidationImage,
  listValidationImages,
  collectValidationDiagnostics,
  collectBoundedPages,
  formatValidationDiagnostics,
  instrumentProductionTransport,
  assertCompletedValidationJob,
  assertDuplicateValidationJob,
  parseValidationEnvironment,
  runValidation,
  runValidationCleanup,
  assertSnapshotMatches,
  serializeValidationSummary,
  summaryPath,
  validateValidationSummary,
  validationExitCodeFor,
  withValidationStage,
} from '../scripts/app-validation.mjs';
import { computeWebhookSignature, MemoryStateStore } from '../packages/github/dist/index.js';
import { handleWebhook } from '../apps/github-app/dist/webhook.js';

const root = resolve(process.cwd());
const privateKey = '-----BEGIN PRIVATE KEY-----\nvalidation\n-----END PRIVATE KEY-----';
const validEnvironment = {
  PATCHPROOF_VALIDATION_APP_PRIVATE_KEY: privateKey,
  PATCHPROOF_VALIDATION_WEBHOOK_SECRET: '0123456789012345',
  APP_ID: '42',
  INSTALLATION_ID: '1001',
  REPOSITORY: 'Octo/Example',
  PR_NUMBER: '7',
  BASE_REF: 'main',
  BASE_SHA: 'A'.repeat(40),
  HEAD_SHA: 'B'.repeat(40),
  PATCHPROOF_SHA: 'C'.repeat(40),
  RUNNER_TEMP: join(root, 'work', 'app-validation-test-temp'),
};
const diagnosticHostileText = [
  '-----BEGIN PRIVATE KEY-----private-----END PRIVATE KEY-----',
  'webhook-secret-0123456789',
  'Bearer ghp_private-token-123456789',
  'https://attacker.example/private',
  'C:\\private\\checkout\\command-output.txt',
  'command stdout\ncommand stderr',
  'untrusted repository text',
].join(' | ');

function validSummary() {
  return {
    schemaVersion: 1,
    patchproofSha: 'a'.repeat(40),
    runId: '123e4567-e89b-12d3-a456-426614174000',
    repository: 'octo/example',
    pullRequest: 7,
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    deliveryId: '123e4567-e89b-12d3-a456-426614174001',
    terminalState: 'completed',
    attemptState: 'succeeded',
    check: { id: 101, appId: 42, ownership: 'app', headSha: 'c'.repeat(40) },
    comment: { id: 202, appId: 42, ownership: 'app' },
    evidence: { sha256: 'd'.repeat(64), result: 'PASS' },
    duplicate: { status: 'ignored', queuedJobs: 1, workerAttempts: 1, mutations: 0 },
    docker: {
      image: 'patchproof-app-validation-probe-0123456789abcdef0123456789abcdef',
      imageId: `sha256:${'e'.repeat(64)}`,
      network: 'none',
      user: '65532:65532',
      readOnlyRoot: true,
      capDrop: 'ALL',
      noNewPrivileges: true,
      resourceBounds: { memoryMb: 64, cpuCount: 1, pids: 32 },
      residualContainers: 0,
    },
    timestamps: {
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    },
    cleanup: { ok: true, residualCount: 0 },
  };
}

test('validation preflight rejects missing and hostile fixed identities without writing a summary', async () => {
  const runnerTemp = join(root, 'work', 'app-validation-preflight-no-write');
  await rm(runnerTemp, { recursive: true, force: true });
  await assert.rejects(
    () => runValidation({ environment: {}, repositoryRoot: root, arguments_: [] }),
    (error: unknown) => {
      assert.ok(error instanceof AppValidationError && error.code === 'preflight');
      assert.equal(
        formatValidationDiagnostics(error),
        'APP_VALIDATION_FAILURE primary=preflight-environment/operation-failed>generic/invalid-input',
      );
      return true;
    },
  );
  assert.equal(await readdir(runnerTemp).catch(() => undefined), undefined);
  await assert.rejects(
    () =>
      runValidation({
        environment: { ...validEnvironment, REPOSITORY: '../../hostile' },
        repositoryRoot: root,
        arguments_: [],
      }),
    (error: unknown) => {
      assert.equal(
        formatValidationDiagnostics(error),
        'APP_VALIDATION_FAILURE primary=preflight-environment/operation-failed>generic/invalid-input',
      );
      return true;
    },
  );
  assert.equal(await readdir(runnerTemp).catch(() => undefined), undefined);
});

test('fixed environment values are canonicalized and arguments are fail-closed', () => {
  const parsed = parseValidationEnvironment(validEnvironment);
  assert.equal(parsed.repository, 'Octo/Example');
  assert.equal(parsed.baseSha, 'a'.repeat(40));
  assert.equal(parsed.headSha, 'b'.repeat(40));
  assert.equal(parsed.appId, 42);
  assert.throws(
    () => parseValidationEnvironment({ ...validEnvironment, APP_ID: '042' }),
    /canonical|invalid/u,
  );
  assert.throws(
    () => parseValidationEnvironment({ ...validEnvironment, BASE_SHA: '0'.repeat(39) }),
    /SHA/u,
  );
  assert.throws(
    () => parseValidationEnvironment({ ...validEnvironment, BASE_REF: 'main..evil' }),
    /base ref/u,
  );
  assert.throws(
    () => parseValidationEnvironment({ ...validEnvironment, RUNNER_TEMP: 'relative/temp' }),
    /temporary/u,
  );
  assert.throws(() => assertNoValidationArguments(['--repository', 'octo/example']), /arguments/u);
  assert.equal(canonicalRepository('OCTO/Example'), 'OCTO/Example');
  assert.throws(() => canonicalRepository('octo/example/extra'), /repository identity/u);
});

test('every fixed primary stage reports only its exact bounded stage', async () => {
  for (const stage of Object.values(VALIDATION_PRIMARY_STAGES)) {
    if (stage === VALIDATION_PRIMARY_STAGES.GENERIC) continue;
    await assert.rejects(
      () =>
        withValidationStage(stage, async () => Promise.reject(new Error(diagnosticHostileText))),
      (error: unknown) => {
        assert.equal(
          formatValidationDiagnostics(error),
          `APP_VALIDATION_FAILURE primary=${stage}/${VALIDATION_REASON_CODES.GENERIC}>generic/generic`,
        );
        assert.doesNotMatch(
          formatValidationDiagnostics(error),
          /BEGIN PRIVATE|attacker\.example|command-output|untrusted repository|ghp_/u,
        );
        return true;
      },
    );
  }
});

test('runValidation contains an explicit boundary for every modeled primary stage', async () => {
  const source = await readFile(join(root, 'scripts', 'app-validation.mjs'), 'utf8');
  const runBody = source.slice(source.indexOf('export async function runValidation'));
  for (const [name, stage] of Object.entries(VALIDATION_PRIMARY_STAGES)) {
    if (stage === VALIDATION_PRIMARY_STAGES.GENERIC) continue;
    assert.match(
      runBody,
      new RegExp(`VALIDATION_PRIMARY_STAGES\\.${name}\\b`, 'u'),
      `runValidation is missing stage ${stage}`,
    );
  }
});

test('completed queue arrays preserve the validated job object for duplicate replay', () => {
  const environment = {
    repository: 'octo/example',
    pullRequest: 7,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    installationId: 1001,
  };
  const completedJobs = [
    {
      ...environment,
      status: 'succeeded',
      attempts: 1,
      id: 'job-1',
      evidencePath: 'evidence/summary.json',
    },
  ];
  const completed = assertCompletedValidationJob(
    completedJobs,
    environment,
    'evidence/summary.json',
  );
  assert.equal(completed, completedJobs[0]);
  const replayed = assertDuplicateValidationJob([{ ...completed }], environment, completed);
  assert.equal(replayed.id, completed.id);
  assert.throws(
    () => assertDuplicateValidationJob([{ ...completed, id: 'job-2' }], environment, completed),
    /second queue attempt/u,
  );
});

test('primary and cleanup failures retain both fixed boundaries without foreign content', async () => {
  const primary = new AppValidationError('validation', diagnosticHostileText, undefined, {
    stage: VALIDATION_PRIMARY_STAGES.WORKER_EXECUTION,
    reason: VALIDATION_REASON_CODES.OPERATION_FAILED,
  });
  const cleanup = await runValidationCleanup({
    [VALIDATION_CLEANUP_STAGES.SERVER]: async () => {
      throw new Error(diagnosticHostileText);
    },
  });
  const text = formatValidationDiagnostics({
    primaryError: primary,
    cleanupFailures: cleanup.failures,
  });
  assert.match(text, /APP_VALIDATION_FAILURE primary=worker-execution\/operation-failed/u);
  assert.match(text, /APP_VALIDATION_CLEANUP_FAILURE cleanup=server\/generic/u);
  assert.doesNotMatch(text, /private|attacker|checkout|token|stdout|stderr|repository/u);
});

test('cleanup keeps attempting all remaining fixed stages and emits one bounded line per stage', async () => {
  const attempted: string[] = [];
  const operations = Object.fromEntries(
    Object.values(VALIDATION_CLEANUP_STAGES)
      .filter((stage) => stage !== VALIDATION_CLEANUP_STAGES.GENERIC)
      .map((stage) => [
        stage,
        async () => {
          attempted.push(stage);
          throw new Error(`failure from ${stage} with a private key`);
        },
      ]),
  );
  const result = await runValidationCleanup(operations);
  const expectedStages = Object.values(VALIDATION_CLEANUP_STAGES).filter(
    (stage) => stage !== VALIDATION_CLEANUP_STAGES.GENERIC,
  );
  assert.deepEqual(attempted, expectedStages);
  assert.deepEqual(result.attempted, expectedStages);
  const text = formatValidationDiagnostics({ cleanupFailures: result.failures });
  assert.equal(
    text.split('\n').filter((line) => line.startsWith('APP_VALIDATION_CLEANUP_FAILURE')).length,
    expectedStages.length,
  );
  for (const stage of expectedStages)
    assert.match(text, new RegExp(`cleanup=${stage}/generic`, 'u'));
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_VALIDATION_DIAGNOSTIC_BYTES);
});

test('cleanup lookup failures are fixed per stage and do not stop later stages', async () => {
  const stages = Object.values(VALIDATION_CLEANUP_STAGES).filter(
    (stage) => stage !== VALIDATION_CLEANUP_STAGES.GENERIC,
  );
  const attempted: string[] = [];
  const operations: Record<string, unknown> = {};
  Object.defineProperty(operations, VALIDATION_CLEANUP_STAGES.SERVER, {
    configurable: true,
    get() {
      throw new Error('server operation getter must stay outside diagnostics');
    },
  });
  for (const stage of stages.slice(1))
    operations[stage] = async () => {
      attempted.push(stage);
    };

  const result = await runValidationCleanup(operations);
  assert.deepEqual(attempted, stages.slice(1));
  assert.deepEqual(result.attempted, stages);
  assert.deepEqual(
    result.failures.map((failure) => failure.stage),
    [VALIDATION_CLEANUP_STAGES.SERVER],
  );
  assert.equal(
    formatValidationDiagnostics(undefined, result.failures),
    'APP_VALIDATION_CLEANUP_FAILURE cleanup=server/generic',
  );
});

test('revoked cleanup operation proxies fail closed for every bounded stage', async () => {
  const stages = Object.values(VALIDATION_CLEANUP_STAGES).filter(
    (stage) => stage !== VALIDATION_CLEANUP_STAGES.GENERIC,
  );
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const result = await runValidationCleanup(revocable.proxy);
  assert.deepEqual(result.attempted, stages);
  assert.deepEqual(
    result.failures.map((failure) => failure.stage),
    stages,
  );
  const text = formatValidationDiagnostics(undefined, result.failures);
  assert.equal(text.split('\n').length, stages.length);
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_VALIDATION_DIAGNOSTIC_BYTES);
});

test('hostile public cleanup arrays collapse without invoking iteration or escaping traps', () => {
  const hostile = new Proxy([], {
    get(_target, property) {
      if (property === 'length' || property === Symbol.iterator)
        throw new Error('cleanup array trap must be contained');
      throw new Error(`unexpected cleanup array property: ${String(property)}`);
    },
  });
  const expected = 'APP_VALIDATION_CLEANUP_FAILURE cleanup=generic/generic';
  assert.equal(formatValidationDiagnostics(undefined, hostile), expected);

  const revocable = Proxy.revocable([], {});
  revocable.revoke();
  assert.equal(formatValidationDiagnostics(undefined, revocable.proxy), expected);
});

test('branded internal cleanup arrays preserve stage order and fixed output', async () => {
  const cleanup = await runValidationCleanup({
    [VALIDATION_CLEANUP_STAGES.SERVER]: async () => {
      throw new Error('server cleanup failed');
    },
    [VALIDATION_CLEANUP_STAGES.IMAGE]: async () => {
      throw new Error('image cleanup failed');
    },
  });
  const diagnostics = collectValidationDiagnostics(undefined, cleanup.failures);
  assert.deepEqual(
    diagnostics.cleanup.map((failure) => failure.stage),
    [VALIDATION_CLEANUP_STAGES.SERVER, VALIDATION_CLEANUP_STAGES.IMAGE],
  );
  assert.equal(
    formatValidationDiagnostics(undefined, cleanup.failures),
    'APP_VALIDATION_CLEANUP_FAILURE cleanup=server/generic\nAPP_VALIDATION_CLEANUP_FAILURE cleanup=image/generic',
  );
});

test('foreign errors, nested causes, and unknown values stay within the diagnostic contract', () => {
  const foreign = new Error(diagnosticHostileText);
  const foreignText = formatValidationDiagnostics({
    primaryError: foreign,
    cleanupFailures: [{ stage: 'not-a-cleanup-stage', error: foreign }],
  });
  assert.equal(
    foreignText,
    'APP_VALIDATION_FAILURE primary=generic/generic\nAPP_VALIDATION_CLEANUP_FAILURE cleanup=generic/generic',
  );
  assert.doesNotMatch(foreignText, /private|attacker|path|output|repository|token/u);

  let nested: AppValidationError = new AppValidationError(
    'validation',
    diagnosticHostileText,
    undefined,
    {
      stage: VALIDATION_PRIMARY_STAGES.RECONCILIATION,
      reason: VALIDATION_REASON_CODES.TIMEOUT,
    },
  );
  for (let index = 0; index < 8; index += 1)
    nested = new AppValidationError('validation', diagnosticHostileText, nested, {
      stage: VALIDATION_PRIMARY_STAGES.RECONCILIATION,
      reason: VALIDATION_REASON_CODES.TIMEOUT,
    });
  const nestedDiagnostics = collectValidationDiagnostics(nested);
  assert.equal(nestedDiagnostics.primary?.length, MAX_VALIDATION_DIAGNOSTIC_CAUSE_DEPTH);
  assert.deepEqual(Object.keys(nested.cause as object), ['code', 'stage', 'reason']);
  const nestedText = formatValidationDiagnostics(nested);
  assert.ok(Buffer.byteLength(nestedText, 'utf8') <= MAX_VALIDATION_DIAGNOSTIC_BYTES);
  assert.doesNotMatch(nestedText, /private|attacker|path|output|repository|token/u);

  const unknown = new AppValidationError('not-a-code', diagnosticHostileText, undefined, {
    stage: 'not-a-primary-stage',
    reason: 'not-a-reason',
  });
  assert.equal(
    formatValidationDiagnostics(unknown),
    'APP_VALIDATION_FAILURE primary=generic/generic',
  );
  const foreignCause = new AppValidationError('validation', 'fixed outer message', foreign);
  assert.equal(
    formatValidationDiagnostics(foreignCause),
    'APP_VALIDATION_FAILURE primary=generic/generic>generic/generic',
  );
});

test('boundary wrappers own immutable root stage, reason, and exit code', async () => {
  const forged = new AppValidationError('preflight', 'forged', undefined, {
    stage: VALIDATION_PRIMARY_STAGES.SUMMARY_WRITING,
    reason: VALIDATION_REASON_CODES.TIMEOUT,
  });
  assert.throws(() => Object.defineProperty(forged, 'stage', { value: 'webhook-bind' }));
  assert.throws(() => Object.defineProperty(forged, 'reason', { value: 'generic' }));
  assert.throws(() => Object.defineProperty(forged, 'code', { value: 'validation' }));
  await assert.rejects(
    () =>
      withValidationStage(VALIDATION_PRIMARY_STAGES.WEBHOOK_BIND, async () => {
        throw forged;
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppValidationError);
      assert.equal(error.code, 'validation');
      assert.equal(error.stage, VALIDATION_PRIMARY_STAGES.WEBHOOK_BIND);
      assert.equal(error.reason, VALIDATION_REASON_CODES.OPERATION_FAILED);
      const diagnostics = collectValidationDiagnostics(error);
      assert.equal(diagnostics.primary?.[0]?.stage, VALIDATION_PRIMARY_STAGES.WEBHOOK_BIND);
      assert.equal(diagnostics.primary?.[0]?.code, 'validation');
      assert.equal(diagnostics.primary?.[1]?.stage, VALIDATION_PRIMARY_STAGES.SUMMARY_WRITING);
      return true;
    },
  );
});

test('forged public diagnostic metadata cannot suppress a boundary primary line', async () => {
  const forged = new AppValidationError('validation', 'forged', undefined, {
    stage: VALIDATION_PRIMARY_STAGES.STATE_INITIALIZATION,
    reason: VALIDATION_REASON_CODES.OPERATION_FAILED,
  });
  Object.defineProperties(forged, {
    primaryDiagnostic: { configurable: true, enumerable: false, value: false },
    cleanupDiagnostics: { configurable: true, enumerable: false, value: Object.freeze([]) },
  });

  let boundaryError: unknown;
  await assert.rejects(
    () =>
      withValidationStage(VALIDATION_PRIMARY_STAGES.WEBHOOK_BIND, async () => {
        throw forged;
      }),
    (error: unknown) => {
      boundaryError = error;
      return true;
    },
  );
  assert.ok(boundaryError instanceof AppValidationError);
  assert.equal(boundaryError.code, 'validation');
  assert.equal(boundaryError.stage, VALIDATION_PRIMARY_STAGES.WEBHOOK_BIND);
  assert.equal(
    formatValidationDiagnostics(boundaryError),
    'APP_VALIDATION_FAILURE primary=webhook-bind/operation-failed>state-initialization/operation-failed',
  );
});

test('private error records ignore metadata getters and hostile proxy traps', async () => {
  let primaryGetterCalls = 0;
  let cleanupGetterCalls = 0;
  let getTraps = 0;
  let prototypeTraps = 0;
  let descriptorTraps = 0;
  let ownKeysTraps = 0;
  const forged = new AppValidationError('validation', 'forged', undefined, {
    stage: VALIDATION_PRIMARY_STAGES.WEBHOOK_DELIVERY,
    reason: VALIDATION_REASON_CODES.TIMEOUT,
  });
  Object.defineProperties(forged, {
    primaryDiagnostic: {
      configurable: true,
      get() {
        primaryGetterCalls += 1;
        throw new Error('primaryDiagnostic getter must not be read');
      },
    },
    cleanupDiagnostics: {
      configurable: true,
      get() {
        cleanupGetterCalls += 1;
        throw new Error('cleanupDiagnostics getter must not be read');
      },
    },
  });
  const proxied = new Proxy(forged, {
    get() {
      getTraps += 1;
      throw new Error('proxy get trap must not fire');
    },
    getPrototypeOf() {
      prototypeTraps += 1;
      throw new Error('proxy getPrototypeOf trap must not fire');
    },
    getOwnPropertyDescriptor() {
      descriptorTraps += 1;
      throw new Error('proxy getOwnPropertyDescriptor trap must not fire');
    },
    ownKeys() {
      ownKeysTraps += 1;
      throw new Error('proxy ownKeys trap must not fire');
    },
  });

  let boundaryError: unknown;
  await assert.rejects(
    () =>
      withValidationStage(VALIDATION_PRIMARY_STAGES.WEBHOOK_BIND, async () => {
        throw proxied;
      }),
    (error: unknown) => {
      boundaryError = error;
      return true;
    },
  );
  assert.equal(
    formatValidationDiagnostics(boundaryError),
    'APP_VALIDATION_FAILURE primary=webhook-bind/generic>generic/generic',
  );
  assert.equal(primaryGetterCalls, 0);
  assert.equal(cleanupGetterCalls, 0);
  assert.equal(getTraps, 0);
  assert.equal(prototypeTraps, 0);
  assert.equal(descriptorTraps, 0);
  assert.equal(ownKeysTraps, 0);
});

test('hostile server cleanup preserves the primary line and attempts every later stage', async () => {
  const stages = Object.values(VALIDATION_CLEANUP_STAGES).filter(
    (stage) => stage !== VALIDATION_CLEANUP_STAGES.GENERIC,
  );
  const attempted: string[] = [];
  const hostile = new Proxy(new Error('hostile cleanup'), {
    get() {
      throw new Error('hostile cleanup get trap must not fire');
    },
    getPrototypeOf() {
      throw new Error('hostile cleanup prototype trap must not fire');
    },
    getOwnPropertyDescriptor() {
      throw new Error('hostile cleanup descriptor trap must not fire');
    },
    ownKeys() {
      throw new Error('hostile cleanup ownKeys trap must not fire');
    },
  });
  const operations = Object.fromEntries(
    stages.map((stage) => [
      stage,
      async () => {
        attempted.push(stage);
        if (stage === VALIDATION_CLEANUP_STAGES.SERVER) throw hostile;
      },
    ]),
  );
  const cleanup = await runValidationCleanup(operations);
  const primary = new AppValidationError('validation', 'primary', undefined, {
    stage: VALIDATION_PRIMARY_STAGES.WORKER_EXECUTION,
    reason: VALIDATION_REASON_CODES.OPERATION_FAILED,
  });
  assert.deepEqual(attempted, stages);
  assert.equal(cleanup.failures.length, 1);
  assert.equal(
    formatValidationDiagnostics({ primaryError: primary, cleanupFailures: cleanup.failures }),
    'APP_VALIDATION_FAILURE primary=worker-execution/operation-failed\nAPP_VALIDATION_CLEANUP_FAILURE cleanup=server/generic',
  );
});

test('cleanup-only hostile server and store failures remain cleanup-only', async () => {
  const stages = Object.values(VALIDATION_CLEANUP_STAGES).filter(
    (stage) => stage !== VALIDATION_CLEANUP_STAGES.GENERIC,
  );
  const attempted: string[] = [];
  const makeHostile = () =>
    new Proxy(new Error('hostile cleanup'), {
      get() {
        throw new Error('hostile cleanup get trap must not fire');
      },
      getPrototypeOf() {
        throw new Error('hostile cleanup prototype trap must not fire');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile cleanup descriptor trap must not fire');
      },
      ownKeys() {
        throw new Error('hostile cleanup ownKeys trap must not fire');
      },
    });
  const operations = Object.fromEntries(
    stages.map((stage) => [
      stage,
      async () => {
        attempted.push(stage);
        if (stage === VALIDATION_CLEANUP_STAGES.SERVER || stage === VALIDATION_CLEANUP_STAGES.STORE)
          throw makeHostile();
      },
    ]),
  );
  const cleanup = await runValidationCleanup(operations);
  const text = formatValidationDiagnostics(undefined, cleanup.failures);
  assert.deepEqual(attempted, stages);
  assert.equal(
    text,
    'APP_VALIDATION_CLEANUP_FAILURE cleanup=server/generic\nAPP_VALIDATION_CLEANUP_FAILURE cleanup=store/generic',
  );
  assert.doesNotMatch(text, /APP_VALIDATION_FAILURE primary=/u);
});

test('prototype forgeries and public fields are foreign to private error records', () => {
  const forged = Object.create(AppValidationError.prototype) as AppValidationError;
  Object.defineProperties(forged, {
    code: { configurable: true, enumerable: true, value: 'preflight' },
    stage: { configurable: true, enumerable: true, value: VALIDATION_PRIMARY_STAGES.WEBHOOK_BIND },
    reason: { configurable: true, enumerable: true, value: VALIDATION_REASON_CODES.TIMEOUT },
    cause: { configurable: true, enumerable: false, value: { code: 'preflight' } },
  });
  assert.equal(
    formatValidationDiagnostics(forged),
    'APP_VALIDATION_FAILURE primary=generic/generic',
  );
  assert.equal(validationExitCodeFor(forged), VALIDATION_EXIT_CODES.validation);
});

test('owned boundaries are idempotent, distinct boundaries add one cause, and depth stays bounded', async () => {
  const rejectAt = async (stage: string, value: unknown) => {
    let caught: unknown;
    await assert.rejects(
      () =>
        withValidationStage(stage, async () => {
          throw value;
        }),
      (error: unknown) => {
        caught = error;
        return true;
      },
    );
    return caught;
  };
  const leaf = new AppValidationError('validation', 'leaf', undefined, {
    stage: VALIDATION_PRIMARY_STAGES.STATE_INITIALIZATION,
    reason: VALIDATION_REASON_CODES.TIMEOUT,
  });
  const first = await rejectAt(VALIDATION_PRIMARY_STAGES.WEBHOOK_BIND, leaf);
  const same = await rejectAt(VALIDATION_PRIMARY_STAGES.WEBHOOK_BIND, first);
  assert.equal(same, first);
  const different = await rejectAt(VALIDATION_PRIMARY_STAGES.WEBHOOK_DELIVERY, first);
  assert.equal(
    formatValidationDiagnostics(different),
    'APP_VALIDATION_FAILURE primary=webhook-delivery/operation-failed>webhook-bind/operation-failed>state-initialization/timeout',
  );

  let bounded = different;
  for (const stage of [
    VALIDATION_PRIMARY_STAGES.WORKER_EXECUTION,
    VALIDATION_PRIMARY_STAGES.EVIDENCE_VERIFICATION,
    VALIDATION_PRIMARY_STAGES.RECONCILIATION,
    VALIDATION_PRIMARY_STAGES.DUPLICATE_REPLAY,
    VALIDATION_PRIMARY_STAGES.SUMMARY_WRITING,
  ])
    bounded = await rejectAt(stage, bounded);
  assert.equal(
    collectValidationDiagnostics(bounded).primary?.length,
    MAX_VALIDATION_DIAGNOSTIC_CAUSE_DEPTH,
  );
  assert.equal(
    collectValidationDiagnostics(different).primary?.at(-1)?.stage,
    VALIDATION_PRIMARY_STAGES.STATE_INITIALIZATION,
  );
});

test('private exit selection ignores public fields and hostile proxy traps', () => {
  const preflight = new AppValidationError('preflight', 'fixed', undefined, {
    stage: VALIDATION_PRIMARY_STAGES.PREFLIGHT_ARGUMENTS,
  });
  assert.equal(validationExitCodeFor(preflight), VALIDATION_EXIT_CODES.preflight);
  const hostile = new Proxy(preflight, {
    get() {
      throw new Error('exit helper get trap must not fire');
    },
    getPrototypeOf() {
      throw new Error('exit helper prototype trap must not fire');
    },
    getOwnPropertyDescriptor() {
      throw new Error('exit helper descriptor trap must not fire');
    },
    ownKeys() {
      throw new Error('exit helper ownKeys trap must not fire');
    },
  });
  assert.equal(validationExitCodeFor(hostile), VALIDATION_EXIT_CODES.validation);
});

test('cleanup-only diagnostics emit cleanup lines without a spurious primary line', async () => {
  const cleanup = await runValidationCleanup({
    [VALIDATION_CLEANUP_STAGES.IMAGE]: async () => {
      throw new Error(diagnosticHostileText);
    },
  });
  const text = formatValidationDiagnostics(undefined, cleanup.failures);
  assert.equal(text, 'APP_VALIDATION_CLEANUP_FAILURE cleanup=image/generic');
  assert.doesNotMatch(text, /APP_VALIDATION_FAILURE primary=/u);
});

test('unbranded, empty, sparse, getter, and proxy cleanup chains collapse safely', () => {
  const getterFailure = {
    get chain() {
      throw new Error('chain getter must not be read');
    },
    get stage() {
      return VALIDATION_CLEANUP_STAGES.SERVER;
    },
  };
  const sparse: unknown[] = [];
  sparse.length = 3;
  sparse[1] = { chain: [] };
  const proxyFailure = new Proxy(
    {},
    {
      get() {
        throw new Error('proxy property must not be read');
      },
    },
  );
  const text = formatValidationDiagnostics({
    cleanupFailures: [...sparse, getterFailure, proxyFailure],
  });
  assert.match(text, /APP_VALIDATION_CLEANUP_FAILURE cleanup=generic\/generic/u);
  assert.doesNotMatch(text, /APP_VALIDATION_CLEANUP_FAILURE cleanup=server\/generic/u);
  assert.doesNotMatch(text, />>|cleanup=$/u);
});

test('success has no failure diagnostics and preserves exit codes and summary serialization', () => {
  const summary = validSummary();
  const serialized = serializeValidationSummary(summary);
  assert.equal(formatValidationDiagnostics(undefined), '');
  assert.deepEqual(JSON.parse(serialized), summary);
  assert.deepEqual(VALIDATION_EXIT_CODES, { success: 0, preflight: 2, validation: 1 });
});

test('live snapshot repository identity is compared case-insensitively without widening repo scope', () => {
  const environment = {
    repository: 'kwlck/PatchProof',
    pullRequest: 7,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  };
  const snapshot = {
    number: 7,
    state: 'open',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    headRepository: 'kwlck/PatchProof',
    repository: 'kwlck/PatchProof',
    fork: false,
  };
  assert.doesNotThrow(() => assertSnapshotMatches(snapshot, environment));
  assert.throws(
    () => assertSnapshotMatches({ ...snapshot, headRepository: 'kwlck/Other' }, environment),
    /snapshot/u,
  );
});

test('synthetic webhook bytes and signatures are deterministic and tightly allowlisted', () => {
  const metadata = {
    number: 7,
    repository: 'octo/example',
    installationId: 1001,
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headRef: 'validation',
    headSha: 'b'.repeat(40),
    headRepository: 'octo/example',
  };
  const body = canonicalSyntheticPullRequest(metadata);
  assert.equal(body, canonicalSyntheticPullRequest(metadata));
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.deepEqual(parsed.repository, { full_name: 'octo/example' });
  assert.deepEqual(parsed.installation, { id: 1001 });
  const request = buildWebhookRequest(
    body,
    validEnvironment.PATCHPROOF_VALIDATION_WEBHOOK_SECRET,
    '123e4567-e89b-12d3-a456-426614174000',
  );
  assert.equal(
    request.signature,
    computeWebhookSignature(body, validEnvironment.PATCHPROOF_VALIDATION_WEBHOOK_SECRET),
  );
  assert.equal(request.event, 'pull_request');
  assert.throws(() => buildWebhookRequest(body, 'short', request.deliveryId), /secret/u);
  assert.throws(
    () => canonicalSyntheticPullRequest({ ...metadata, repository: 'evil/../../repo' }),
    /repository/u,
  );
});

test('summary serializer rejects unexpected fields and credential-shaped values', () => {
  const summary = validSummary();
  assert.equal(JSON.parse(serializeValidationSummary(summary)).schemaVersion, 1);
  assert.throws(
    () => serializeValidationSummary({ ...summary, unexpected: true }),
    /unexpected field/u,
  );
  assert.throws(
    () => assertSecretFreeText('Authorization: Bearer ghp_123456789', ['webhook-secret']),
    /Secret-bearing/u,
  );
  assert.throws(() => assertSecretFreeText('-----BEGIN PRIVATE KEY-----', []), /Secret-bearing/u);
  assert.throws(
    () => assertSecretFreeText('header abcdefghijklmnop.qrstuvwxyz12345678.ABCDEFGHIJKLMNOP', []),
    /Secret-bearing/u,
  );
  assert.throws(
    () => validateValidationSummary({ ...summary, cleanup: { ok: true, residualCount: 1 } }),
    /cleanup/u,
  );
});

test('summary destination is the fixed bounded RUNNER_TEMP path', () => {
  const runnerTemp = resolve(root, 'work', 'summary-destination-test-temp');
  assert.equal(summaryPath(runnerTemp), join(runnerTemp, 'patchproof-app-validation-summary.json'));
  assert.throws(() => summaryPath('relative/temp'), /temporary/u);
});

test('Docker build/config specs cannot pull, publish, or carry credentials', async () => {
  const tag = 'patchproof-app-validation-probe-0123456789abcdef0123456789abcdef';
  const validationContext = resolve(root, 'test', 'fixtures', 'app-validation');
  const command = buildValidationImageCommand(
    validationContext,
    join(validationContext, 'Dockerfile'),
    tag,
  );
  assert.equal(command[0], 'docker');
  assert.ok(command.includes('--pull=false'));
  assert.equal(
    command.some((value) => value === 'pull' || value === 'push' || value === 'login'),
    false,
  );
  assert.equal(command.includes('--build-arg'), false);
  assert.equal(command.includes('--secret'), false);
  assert.deepEqual(buildValidationImageInspectCommand(tag).slice(0, 3), [
    'docker',
    'image',
    'inspect',
  ]);
  assert.deepEqual(buildValidationImageRemoveCommand(tag).slice(0, 4), [
    'docker',
    'image',
    'rm',
    '--force',
  ]);
  assert.deepEqual(buildValidationContainerListCommand(), [
    'docker',
    'container',
    'ls',
    '--all',
    '--format',
    '{{.Names}}',
  ]);
  assert.deepEqual(buildValidationImageInventoryCommand(), [
    'docker',
    'image',
    'ls',
    '--all',
    '--no-trunc',
    '--format',
    '{{.Repository}}:{{.Tag}}\\t{{.ID}}',
  ]);
  const config = buildValidationConfig(tag);
  assert.match(config, /backend: docker/u);
  assert.match(config, /network: none/u);
  assert.match(config, /readOnlyRoot: true/u);
  assert.doesNotMatch(config, /(?:TOKEN=|SECRET=|PRIVATE_KEY=|GITHUB_TOKEN=)/iu);
  assert.match(buildValidationConfig(`sha256:${'a'.repeat(64)}`), /dockerImage: sha256:/u);
  const dockerfile = await readFile(
    join(root, 'test', 'fixtures', 'app-validation', 'Dockerfile'),
    'utf8',
  );
  assert.match(dockerfile, /^FROM scratch/mu);
  assert.doesNotMatch(dockerfile, /^FROM\s+(?!scratch)/imu);
});

test('Docker inventory dispatch separates the executable from its arguments', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const entries = await listValidationImages(async (file, args) => {
    calls.push({ file, args });
    return { stdout: `repo:tag\tsha256:${'a'.repeat(64)}\n`, stderr: '' };
  });
  assert.equal(entries.length, 1);
  assert.deepEqual(calls, [
    {
      file: 'docker',
      args: [
        'image',
        'ls',
        '--all',
        '--no-trunc',
        '--format',
        '{{.Repository}}:{{.Tag}}\\t{{.ID}}',
      ],
    },
  ]);
  assert.notEqual(calls[0].args[0], 'docker');
});

test('Docker image inspection dispatch separates the executable from its arguments', async () => {
  const workspace = await mkdtemp(join(root, 'work', 'app-validation-inspect-dispatch-'));
  const calls: Array<{ file: string; args: string[] }> = [];
  try {
    const image = await buildValidationImage({
      validationRoot: workspace,
      repositoryRoot: root,
      runId: '123e4567-e89b-12d3-a456-426614174000',
      command: async (file, args) => {
        calls.push({ file, args });
        if (file === 'docker' && args[0] === 'image' && args[1] === 'inspect')
          return { stdout: `sha256:${'a'.repeat(64)}\n`, stderr: '' };
        return { stdout: '', stderr: '' };
      },
    });
    const inspectCall = calls.find(
      ({ file, args }) => file === 'docker' && args[0] === 'image' && args[1] === 'inspect',
    );
    assert.deepEqual(inspectCall, {
      file: 'docker',
      args: ['image', 'inspect', '--format', '{{.Id}}', image.tag],
    });
    assert.notEqual(inspectCall?.args[0], 'docker');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('first-party probe accepts only EROFS as read-only proof', async () => {
  const probe = await readFile(join(root, 'test', 'fixtures', 'app-validation', 'probe.c'), 'utf8');
  assert.match(probe, /open\("\/patchproof-validation-root-write"/u);
  assert.doesNotMatch(probe, /\/etc\/patchproof-validation/u);
  assert.match(probe, /if\s*\(errno\s*!=\s*EROFS\)/u);
  assert.doesNotMatch(probe, /errno\s*(?:==|!=)\s*(?:ENOENT|EACCES|EPERM)/u);
  assert.match(probe, /root filesystem write check was inconclusive/u);
});

test('bounded reconciliation pagination enumerates beyond page one and fails closed when truncated', async () => {
  const seen: number[] = [];
  const items = await collectBoundedPages(
    async (page) => {
      seen.push(page);
      return page === 1
        ? { items: Array.from({ length: 100 }, (_, index) => index), total: 150, hasNext: false }
        : {
            items: Array.from({ length: 50 }, (_, index) => index + 100),
            total: 150,
            hasNext: false,
          };
    },
    { label: 'test surface' },
  );
  assert.deepEqual(seen, [1, 2]);
  assert.equal(items.length, 150);
  await assert.rejects(
    () =>
      collectBoundedPages(async () => ({ items: Array(100), total: 2_100, hasNext: false }), {
        label: 'test surface',
        maxPages: 2,
      }),
    /exceeded its bound/u,
  );
  await assert.rejects(
    () => collectBoundedPages(async () => ({ items: Array(10), total: 20, hasNext: false })),
    /incomplete/u,
  );
});

test('fixture overlay calls production source and executes only the checked-in fixture', async () => {
  const workspace = await mkdtemp(join(root, 'work', 'app-validation-overlay-'));
  const destination = join(workspace, 'destination');
  const calls: Array<{ repository: string; sha: string }> = [];
  try {
    const productionSource = {
      async materializeRevision(repository: string, sha: string, staging: string) {
        calls.push({ repository, sha });
        await writeFile(join(staging, 'untrusted-pr-code.txt'), 'must never be copied', 'utf8');
      },
    };
    const source = new FixtureOverlaySourceAdapter(
      productionSource,
      join(root, 'test', 'fixtures', 'app-validation'),
      workspace,
      'octo/example',
      'a'.repeat(40),
      'b'.repeat(40),
      buildValidationConfig('patchproof-app-validation-probe-0123456789abcdef0123456789abcdef'),
    );
    await source.materializeRevision('octo/example', 'a'.repeat(40), destination);
    assert.equal(calls.length, 1);
    assert.equal(
      await readFile(join(destination, 'untrusted-pr-code.txt'), 'utf8').catch(() => undefined),
      undefined,
    );
    assert.match(await readFile(join(destination, '.patchproof.yml'), 'utf8'), /backend: docker/u);
    assert.equal(
      (await readdir(workspace)).some((name) => name.startsWith('fetched-source-')),
      false,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('cleanup orchestration removes only newly-created validation containers and fails on residuals', async () => {
  const before = new Set(['patchproof-base-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  let current = new Set([...before, 'patchproof-head-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  const removed: string[] = [];
  const listContainers = async () => new Set(current);
  const command = async (_file: string, args: string[]) => {
    const name = args.at(-1);
    assert.equal(typeof name, 'string');
    removed.push(name as string);
    current.delete(name as string);
    return { stdout: '', stderr: '' };
  };
  assert.equal(await cleanupValidationContainers(before, { listContainers, command }), 0);
  assert.deepEqual(removed, ['patchproof-head-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  current = new Set([...before, 'patchproof-head-cccccccccccccccccccccccccccccccc']);
  await assert.rejects(
    () =>
      cleanupValidationContainers(before, {
        listContainers: async () => new Set(current),
        command: async () => {
          throw new Error('cleanup denied');
        },
      }),
    /cleanup failed/u,
  );
});

test('image cleanup confirms tag and image-id absence, while inventory failure is fatal', async () => {
  const tag = 'patchproof-app-validation-probe-0123456789abcdef0123456789abcdef';
  const imageId = `sha256:${'f'.repeat(64)}`;
  let current = [{ reference: `${tag}:latest`, id: imageId }];
  const removed: string[] = [];
  const listImages = async () => current.map((entry) => ({ ...entry }));
  const command = async (file: string, args: string[]) => {
    assert.equal(file, 'docker');
    assert.deepEqual(args.slice(0, 2), ['image', 'rm']);
    assert.notEqual(args[0], 'docker');
    const reference = args.at(-1);
    assert.equal(typeof reference, 'string');
    removed.push(reference as string);
    current = current.filter(
      (entry) =>
        entry.id !== reference &&
        entry.reference !== reference &&
        !entry.reference.startsWith(`${reference}:`) &&
        !entry.reference.startsWith(`${reference}@`),
    );
    return { stdout: '', stderr: '' };
  };
  assert.equal(await cleanupValidationImage({ tag, imageId }, { listImages, command }), 0);
  assert.deepEqual(removed, [tag]);
  await assert.rejects(
    () =>
      cleanupValidationImage(
        { tag, imageId },
        {
          listImages: async () => {
            throw new Error('daemon unavailable');
          },
        },
      ),
    /inventory failed/u,
  );
});

test('production webhook/store duplicate state prevents a second enqueue or mutation', async () => {
  const store = new MemoryStateStore();
  const deliveryId = '123e4567-e89b-12d3-a456-426614174002';
  const body = JSON.stringify({
    action: 'opened',
    number: 7,
    repository: { full_name: 'octo/example' },
    installation: { id: 1001 },
    pull_request: {
      base: { sha: 'a'.repeat(40), repo: { full_name: 'octo/example' } },
      head: { sha: 'b'.repeat(40), repo: { full_name: 'octo/example' } },
    },
  });
  let enqueued = 0;
  let checkCreates = 0;
  let checkUpdates = 0;
  let commentCreates = 0;
  let commentUpdates = 0;
  const github = {
    requiresInstallationId: true as const,
    appId: 42,
    async createCheck() {
      checkCreates += 1;
      return { id: 101 };
    },
    async updateCheck() {
      checkUpdates += 1;
    },
    async createComment() {
      commentCreates += 1;
      return { id: 202, body: 'managed' };
    },
    async updateComment() {
      commentUpdates += 1;
    },
  };
  const instrumented = instrumentProductionTransport(github);
  const dependencies = {
    webhookSecret: validEnvironment.PATCHPROOF_VALIDATION_WEBHOOK_SECRET,
    store,
    github: instrumented.transport,
    requireInstallationId: true,
    enqueue: async () => {
      enqueued += 1;
    },
  };
  const request = {
    rawBody: body,
    signature: computeWebhookSignature(body, dependencies.webhookSecret),
    deliveryId,
    event: 'pull_request',
  };
  const first = await handleWebhook(request, dependencies);
  const duplicate = await handleWebhook(request, dependencies);
  assert.equal(first.status, 202);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body, 'duplicate delivery ignored');
  assert.equal(enqueued, 1);
  assert.equal(checkCreates, 1);
  assert.equal(checkUpdates, 0);
  assert.equal(commentCreates, 1);
  assert.equal(commentUpdates, 0);
  assert.deepEqual(instrumented.counts, {
    createCheck: 1,
    updateCheck: 0,
    createComment: 1,
    updateComment: 0,
  });
  assert.equal(instrumented.mutationCount(), 2);
});
