import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const root = process.cwd();

async function dockerAvailable() {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      cwd: root,
      windowsHide: true,
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
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

if (!(await dockerAvailable())) {
  console.log('docker integration: SKIPPED (Docker CLI/daemon unavailable; no local fallback)');
  process.exit(0);
}

try {
  await runCliFixture();
  await runWorkerFixture();
  console.log('docker integration: PASS (CLI and webhook-to-worker Docker fail to pass fixture)');
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}
