import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { verifyEvidenceBundle } from '@patchproof/core';
import { handleWebhook } from '../apps/github-app/dist/webhook.js';
import { computeWebhookSignature, MemoryStateStore } from '@patchproof/github';

const execFileAsync = promisify(execFile);
const root = resolve(process.cwd());
const cli = join(root, 'packages', 'cli', 'dist', 'main.js');

async function cliRun(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 1_000_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 99,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

async function run(): Promise<void> {
  const outputRoot = join(root, 'work', 'e2e');
  await mkdir(outputRoot, { recursive: true });
  // The maintained Docker fixture intentionally leaves unsafe local execution
  // disabled. This test opts into local development explicitly in a temporary
  // trusted config so it exercises the CLI without weakening the fixture.
  const passConfigPath = join(outputRoot, 'pass.local.patchproof.yml');
  const passConfig = (await readFile(join(root, 'fixtures/pass/.patchproof.yml'), 'utf8')).replace(
    /  backend: docker\r?\n/u,
    '  backend: local\n  allowUnsafeLocal: true\n',
  );
  await writeFile(passConfigPath, passConfig, 'utf8');
  const pass = await cliRun([
    'run',
    passConfigPath,
    '--base',
    'fixtures/pass/base',
    '--head',
    'fixtures/pass/head',
    '--backend',
    'local',
    '--allow-unsafe-local',
    '--output',
    join(outputRoot, 'pass'),
  ]);
  assert.equal(pass.code, 0, pass.stderr);
  const bundlePath = join(outputRoot, 'pass', 'patchproof.evidence.json');
  const verified = await cliRun(['verify', bundlePath, '--json']);
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).valid, true);
  const original = await readFile(bundlePath, 'utf8');
  const parsed = JSON.parse(original) as Record<string, unknown>;
  const executions = parsed.executions as Record<string, Record<string, unknown>>;
  for (const revision of ['base', 'head']) {
    const execution = executions[revision];
    const environment = execution?.environment as Record<string, unknown>;
    assert.equal('PATH' in environment, false);
    assert.equal('SystemRoot' in environment, false);
    assert.equal((execution?.launcherEnvironment as Record<string, unknown>).omitted, true);
  }
  const sources = parsed.sources as Record<string, Record<string, unknown>>;
  const replayMetadata = parsed.replay as Record<string, unknown>;
  assert.equal(sources.base?.location, 'base');
  assert.equal(sources.head?.location, 'head');
  assert.equal(replayMetadata.baseLocation, 'base');
  assert.equal(replayMetadata.headLocation, 'head');
  assert.equal(JSON.stringify(parsed).includes(root), false);
  parsed.verdict = 'tampered by e2e';
  await writeFile(bundlePath, `${JSON.stringify(parsed)}\n`);
  const tampered = await cliRun(['verify', bundlePath]);
  assert.equal(tampered.code, 2);
  await writeFile(bundlePath, original);
  assert.equal((await verifyEvidenceBundle(bundlePath)).valid, true);
  const replay = await cliRun(['replay', bundlePath]);
  assert.equal(replay.code, 0);
  assert.match(replay.stdout, /Replay plan \(not executed\)/u);
  assert.match(replay.stdout, /currentEnvironment/u);
  assert.match(replay.stdout, /recordedBackend/u);
  const replayWithoutPaths = await cliRun(['replay', bundlePath, '--yes']);
  assert.equal(replayWithoutPaths.code, 2);
  assert.match(replayWithoutPaths.stderr, /requires --base <dir> and --head <dir>/u);
  const replayRun = await cliRun([
    'replay',
    bundlePath,
    '--yes',
    '--backend',
    'local',
    '--allow-unsafe-local',
    '--base',
    'fixtures/pass/base',
    '--head',
    'fixtures/pass/head',
  ]);
  assert.equal(replayRun.code, 0, replayRun.stderr);
  assert.match(replayRun.stdout, /Replay executed/u);

  const basePass = await cliRun([
    'run',
    'fixtures/base-pass/.patchproof.yml',
    '--base',
    'fixtures/base-pass/base',
    '--head',
    'fixtures/base-pass/head',
    '--backend',
    'local',
    '--allow-unsafe-local',
    '--output',
    join(outputRoot, 'base-pass'),
  ]);
  assert.equal(basePass.code, 2);
  const headFails = await cliRun([
    'run',
    'fixtures/head-fails/.patchproof.yml',
    '--base',
    'fixtures/head-fails/base',
    '--head',
    'fixtures/head-fails/head',
    '--backend',
    'local',
    '--allow-unsafe-local',
    '--output',
    join(outputRoot, 'head-fails'),
  ]);
  assert.equal(headFails.code, 1);
  const timeout = await cliRun([
    'run',
    'fixtures/timeout/.patchproof.yml',
    '--base',
    'fixtures/timeout/base',
    '--head',
    'fixtures/timeout/head',
    '--backend',
    'local',
    '--allow-unsafe-local',
    '--output',
    join(outputRoot, 'timeout'),
  ]);
  assert.equal(timeout.code, 2);
  const timeoutBundle = join(outputRoot, 'timeout', 'patchproof.evidence.json');
  const timeoutVerification = await cliRun(['verify', timeoutBundle, '--json']);
  assert.equal(timeoutVerification.code, 0, timeoutVerification.stderr);
  assert.equal(JSON.parse(await readFile(timeoutBundle, 'utf8')).outcome, 'INCONCLUSIVE');
  const denied = await cliRun([
    'run',
    'fixtures/policy-denied/.patchproof.yml',
    '--base',
    'fixtures/policy-denied/base',
    '--head',
    'fixtures/policy-denied/head',
    '--backend',
    'local',
    '--output',
    join(outputRoot, 'denied'),
  ]);
  assert.equal(denied.code, 3);
  const redaction = await cliRun([
    'run',
    'fixtures/redaction/.patchproof.yml',
    '--base',
    'fixtures/redaction/base',
    '--head',
    'fixtures/redaction/head',
    '--backend',
    'local',
    '--allow-unsafe-local',
    '--output',
    join(outputRoot, 'redaction'),
  ]);
  assert.equal(redaction.code, 0);
  const redactedLog = await readFile(
    join(outputRoot, 'redaction', 'artifacts', 'base.stderr.log'),
    'utf8',
  );
  assert.equal(redactedLog.includes('fixture-secret-123456789'), false);

  const webhookPayload = JSON.stringify({
    action: 'opened',
    number: 9,
    repository: { full_name: 'octo/e2e' },
    pull_request: {
      base: { sha: 'b'.repeat(40) },
      head: { sha: 'c'.repeat(40), repo: { full_name: 'octo/e2e' } },
    },
  });
  let queued = false;
  const webhook = await handleWebhook(
    {
      rawBody: webhookPayload,
      signature: computeWebhookSignature(webhookPayload, 'e2e-webhook-secret'),
      deliveryId: 'e2e-delivery',
      event: 'pull_request',
    },
    {
      webhookSecret: 'e2e-webhook-secret',
      store: new MemoryStateStore(),
      github: {
        async getPullRequest() {
          return {
            number: 9,
            baseSha: 'b'.repeat(40),
            headSha: 'c'.repeat(40),
            headRepository: 'octo/example',
            fork: false,
            state: 'open' as const,
          };
        },
        async createCheck() {
          return { id: 1 };
        },
        async updateCheck() {},
        async createComment() {
          return { id: 2, body: 'managed' };
        },
        async updateComment() {},
      },
      enqueue: async () => {
        queued = true;
      },
    },
  );
  assert.equal(webhook.status, 202);
  assert.equal(queued, true);
}

run()
  .then(() =>
    console.log(
      'e2e: fixture run, verify, tamper rejection, replay plan, outcome matrix, redaction, and webhook flow passed',
    ),
  )
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
