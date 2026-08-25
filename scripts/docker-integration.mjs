import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const root = process.cwd();
await mkdir(join(root, 'work'), { recursive: true });

async function dockerAvailable() {
  try {
    const result = await execFileAsync(
      'docker',
      ['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'],
      {
        cwd: root,
        windowsHide: true,
        shell: false,
        timeout: 15_000,
      },
    );
    const versions = result.stdout.trim();
    return versions.length > 0 && !versions.endsWith('/');
  } catch {
    return false;
  }
}

async function patchproofContainers() {
  const result = await execFileAsync(
    'docker',
    ['container', 'ls', '--all', '--filter', 'name=patchproof-', '--format', '{{.Names}}'],
    { cwd: root, windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  return result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.startsWith('patchproof-'));
}

async function runCliFixture() {
  const output = join(root, 'work', 'docker-integration');
  try {
    await execFileAsync(
      process.execPath,
      [
        join(root, 'packages/cli/dist/main.js'),
        'run',
        'fixtures/pass/.patchproof.yml',
        '--base',
        'fixtures/pass/base',
        '--head',
        'fixtures/pass/head',
        '--output',
        output,
      ],
      { cwd: root, windowsHide: true, maxBuffer: 1_000_000 },
    );
  } catch (error) {
    const failure = error;
    const details = [failure.stderr, failure.stdout, failure.message].filter(
      (value) => typeof value === 'string' && value.length > 0,
    );
    throw new Error(details.join('\n') || String(failure));
  }
}

async function runCli(args) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [join(root, 'packages/cli/dist/main.js'), ...args],
      {
        cwd: root,
        windowsHide: true,
        shell: false,
        maxBuffer: 1_000_000,
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 99,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function createDockerProbe(name, scenario, options = {}) {
  const probeRoot = await mkdtemp(join(root, 'work', `docker-probe-${name}-`));
  const base = join(probeRoot, 'base');
  const head = join(probeRoot, 'head');
  const nested = 'nested';
  await Promise.all([
    mkdir(join(base, nested), { recursive: true }),
    mkdir(join(head, nested), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(base, nested, 'scenario.mjs'), scenario, 'utf8'),
    writeFile(join(head, nested, 'scenario.mjs'), scenario, 'utf8'),
  ]);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const outputBytes = options.outputBytes ?? 8_192;
  const config = `version: 1
name: Docker integration ${name}
scenario:
  id: docker-${name}
  name: Docker integration ${name}
  command: [node, scenario.mjs]
  cwd: ${nested}
  file: ${nested}/scenario.mjs
  expectedFailure:
    exitCode: 1
    reasonPattern: EXPECTED_BUG
policy:
  backend: docker
  network: none
  timeoutMs: ${timeoutMs}
  outputBytes: ${outputBytes}
  memoryMb: 128
  cpuCount: 1
  pids: 32
redaction:
  secrets: []
`;
  const configPath = join(probeRoot, '.patchproof.yml');
  const output = join(probeRoot, 'evidence');
  await writeFile(configPath, config, 'utf8');
  return {
    probeRoot,
    configPath,
    base,
    head,
    output,
    async run() {
      return runCli([
        'run',
        configPath,
        '--base',
        base,
        '--head',
        head,
        '--output',
        output,
        '--json',
      ]);
    },
  };
}

const containmentProbe = `
import fs from 'node:fs';
import net from 'node:net';

if (process.cwd() !== '/workspace/nested') throw new Error('unexpected cwd');
if (process.getuid?.() !== 65532) throw new Error('unexpected runtime uid');
const status = fs.readFileSync('/proc/self/status', 'utf8');
const capabilities = /^CapEff:\\s+([0-9a-f]+)$/im.exec(status)?.[1];
if (capabilities !== undefined && BigInt('0x' + capabilities) !== 0n)
  throw new Error('capabilities were not dropped');
try {
  fs.writeFileSync('/etc/patchproof-integration-probe', 'must fail');
  throw new Error('root filesystem is writable');
} catch (error) {
  if (error instanceof Error && error.message === 'root filesystem is writable') throw error;
}
for (const [file, limit] of [['/sys/fs/cgroup/memory.max', 128 * 1024 * 1024], ['/sys/fs/cgroup/pids.max', 32]]) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value !== 'max' && Number(value) > limit) throw new Error(file + ' exceeds limit');
  } catch (error) {
    if (error instanceof Error && error.message.includes('exceeds limit')) throw error;
  }
}
await new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '1.1.1.1', port: 80 });
  const finish = (error) => { socket.destroy(); error === undefined ? resolve() : reject(error); };
  socket.once('connect', () => finish(new Error('network unexpectedly enabled')));
  socket.once('error', () => finish());
  socket.setTimeout(500, () => finish());
});
if (process.env.PATCHPROOF_REVISION === 'base') {
  console.error('EXPECTED_BUG');
  process.exit(1);
}
`;

const timeoutProbe = `
if (process.env.PATCHPROOF_REVISION === 'base') console.error('EXPECTED_BUG');
setTimeout(() => {}, 30_000);
`;

const ignoredSignalProbe = `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1_000);
`;

const outputLimitProbe = `
process.stdout.write('x'.repeat(100_000));
`;

async function runContainmentProbes() {
  const containment = await createDockerProbe('containment', containmentProbe, {
    timeoutMs: 10_000,
  });
  try {
    const result = await containment.run();
    assert.equal(result.code, 0, result.stderr);
    const evidence = JSON.parse(
      await readFile(join(containment.output, 'patchproof.evidence.json'), 'utf8'),
    );
    assert.equal(evidence.outcome, 'PASS');
  } finally {
    await rm(containment.probeRoot, { recursive: true, force: true });
  }
  const timeout = await createDockerProbe('timeout', timeoutProbe, { timeoutMs: 150 });
  try {
    const result = await timeout.run();
    assert.equal(result.code, 2, result.stderr);
  } finally {
    await rm(timeout.probeRoot, { recursive: true, force: true });
  }
  const ignoredSignal = await createDockerProbe('ignored-signal', ignoredSignalProbe, {
    timeoutMs: 150,
  });
  try {
    const result = await ignoredSignal.run();
    assert.equal(result.code, 2, result.stderr);
  } finally {
    await rm(ignoredSignal.probeRoot, { recursive: true, force: true });
  }
  const outputLimit = await createDockerProbe('output-limit', outputLimitProbe, {
    outputBytes: 1_024,
  });
  try {
    const result = await outputLimit.run();
    assert.equal(result.code, 4, result.stderr);
  } finally {
    await rm(outputLimit.probeRoot, { recursive: true, force: true });
  }
  const cancellation = await createDockerProbe('cancellation', ignoredSignalProbe, {
    timeoutMs: 30_000,
  });
  try {
    const [{ parseConfigText }, { isPolicyDeniedRun, runTwoRevisions }] = await Promise.all([
      import('../packages/config/dist/index.js'),
      import('../packages/runner/dist/index.js'),
    ]);
    const parsed = parseConfigText(await readFile(cancellation.configPath, 'utf8'));
    assert.ok(parsed.config, 'cancellation probe config is valid');
    const controller = new AbortController();
    const running = runTwoRevisions({
      config: parsed.config,
      basePath: cancellation.base,
      headPath: cancellation.head,
      trustedConfig: true,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 1_000).unref();
    const result = await running;
    assert.equal(isPolicyDeniedRun(result), false);
    assert.match(result.base.execution.error ?? '', /cancelled|Docker/u);
    assert.match(result.head.execution.error ?? '', /cancelled|Docker/u);
  } finally {
    await rm(cancellation.probeRoot, { recursive: true, force: true });
  }
}

async function runWorkerFixture() {
  const [
    { computeWebhookSignature, MemoryStateStore },
    { handleWebhook },
    { SqliteQueue },
    { PatchProofWorker },
    { verifyEvidenceBundle },
  ] = await Promise.all([
    import('../packages/github/dist/index.js'),
    import('../apps/github-app/dist/webhook.js'),
    import('../apps/github-app/dist/queue.js'),
    import('../apps/github-app/dist/worker.js'),
    import('../packages/core/dist/index.js'),
  ]);
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const queue = new SqliteQueue(':memory:');
  const store = new MemoryStateStore();
  const calls = [];
  const outputRoot = await mkdtemp(join(root, 'work', 'docker-worker-'));
  const config = await readFile(join(root, 'fixtures/pass/.patchproof.yml'), 'utf8');
  const source = {
    async materializeRevision(repository, sha, destination) {
      const expectedRepository = 'octo/example';
      if (repository !== expectedRepository)
        throw new Error(`unexpected source repository: ${repository}`);
      const fixture = sha === baseSha ? 'base' : sha === headSha ? 'head' : undefined;
      if (fixture === undefined) throw new Error(`unexpected source SHA: ${sha}`);
      await cp(join(root, 'fixtures/pass', fixture), destination, {
        recursive: true,
        dereference: false,
      });
      await writeFile(join(destination, '.patchproof.yml'), config, 'utf8');
    },
  };
  const github = {
    async getPullRequest(repository, pullRequest) {
      assert.equal(repository, 'octo/example');
      assert.equal(pullRequest, 7);
      return {
        number: 7,
        baseSha,
        headSha,
        headRepository: 'octo/example',
        fork: false,
        state: 'open',
      };
    },
    async createCheck() {
      calls.push('create-check');
      return { id: 101 };
    },
    async updateCheck(repository, checkId) {
      calls.push(`update-check:${repository}:${checkId}`);
    },
    async createComment() {
      calls.push('create-comment');
      return { id: 202, body: 'managed' };
    },
    async updateComment(repository, commentId) {
      calls.push(`update-comment:${repository}:${commentId}`);
    },
  };
  const payload = JSON.stringify({
    action: 'created',
    repository: { full_name: 'octo/example' },
    issue: {
      number: 7,
      pull_request: { url: 'https://api.github.com/repos/octo/example/pulls/7' },
    },
    comment: { body: '/patchproof run', author_association: 'OWNER' },
  });
  try {
    const response = await handleWebhook(
      {
        rawBody: payload,
        signature: computeWebhookSignature(payload, 'docker-integration-secret'),
        deliveryId: 'docker-integration-delivery',
        event: 'issue_comment',
      },
      {
        webhookSecret: 'docker-integration-secret',
        store,
        github,
        enqueue: async (request) => {
          await queue.enqueue(request);
        },
      },
    );
    assert.equal(response.status, 202);
    const worker = new PatchProofWorker({
      queue,
      source,
      store,
      github,
      outputRoot,
      workerId: 'docker-integration-worker',
    });
    const results = await worker.runUntilIdle();
    assert.ok(results.some((result) => result.status === 'completed'));
    const jobs = await queue.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, 'succeeded');
    assert.equal(typeof jobs[0]?.evidencePath, 'string');
    const verification = await verifyEvidenceBundle(jobs[0].evidencePath);
    assert.equal(verification.valid, true, verification.errors.join('; '));
    const evidence = JSON.parse(await readFile(jobs[0].evidencePath, 'utf8'));
    assert.equal(evidence.outcome, 'PASS');
    assert.deepEqual(calls, [
      'create-check',
      'create-comment',
      'update-check:octo/example:101',
      'update-comment:octo/example:202',
    ]);
  } finally {
    queue.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
}

const requireDocker = process.env.PATCHPROOF_REQUIRE_DOCKER === '1';
if (!(await dockerAvailable())) {
  const message = 'Docker CLI/daemon unavailable; no local fallback';
  if (requireDocker) {
    console.error(`docker integration: FAIL (${message})`);
    process.exit(1);
  }
  console.log(`docker integration: SKIPPED (${message})`);
  process.exit(0);
}

try {
  const before = await patchproofContainers();
  assert.deepEqual(before, [], 'Docker integration starts with no residual PatchProof containers');
  await runCliFixture();
  await runContainmentProbes();
  await runWorkerFixture();
  // The daemon tears a force-removed container down asynchronously: `rm -f`
  // can return while the container is still listed for a short window. Wait
  // bounded before asserting so the check tests cleanup, not daemon timing.
  let after = await patchproofContainers();
  for (let attempt = 0; after.length > 0 && attempt < 20; attempt += 1) {
    await new Promise((resolvePause) => setTimeout(resolvePause, 500));
    after = await patchproofContainers();
  }
  assert.deepEqual(after, [], 'Docker integration leaves no residual PatchProof containers');
  console.log('docker integration: PASS (CLI, worker, and residual-container checks passed)');
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}
