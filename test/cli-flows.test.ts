import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const cli = resolve('packages/cli/dist/main.js');

async function invoke(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await exec(process.execPath, [cli, ...args], { cwd, maxBuffer: 1_000_000 });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 99, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function workingExample(): Promise<{ root: string; example: string; config: string }> {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-cli-flow-'));
  const example = join(root, 'example');
  const init = await invoke(['init', example], root);
  assert.equal(init.code, 0, init.stderr);
  const config = join(example, '.patchproof.yml');
  // Keep the test independent of whether its host has a Docker daemon.
  const yaml = (await readFile(config, 'utf8')).replace(
    /  backend: docker\n/u,
    '  backend: local\n  allowUnsafeLocal: true\n',
  );
  await writeFile(config, yaml);
  return { root, example, config };
}

test('init refuses occupied scaffold files before changing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-init-safe-'));
  await mkdir(join(root, 'base'));
  await writeFile(join(root, 'base', 'scenario.mjs'), 'keep me\n');
  const result = await invoke(['init', root], root);
  assert.equal(result.code, 2);
  assert.equal(await readFile(join(root, 'base', 'scenario.mjs'), 'utf8'), 'keep me\n');
  assert.match(result.stderr, /refusing to overwrite/u);
});

test('Python template has matching base/head scenario and a working first run', async (context) => {
  try {
    await exec('python3', ['--version']);
  } catch {
    context.skip('Python 3 is unavailable');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'patchproof-python-template-'));
  const example = join(root, 'example');
  assert.equal((await invoke(['init', example, '--template', 'python'], root)).code, 0);
  const config = join(example, '.patchproof.yml');
  const yaml = (await readFile(config, 'utf8')).replace(
    /  backend: docker\n/u,
    '  backend: local\n  allowUnsafeLocal: true\n',
  );
  await writeFile(config, yaml);
  assert.equal(
    await readFile(join(example, 'base', 'scenario.py'), 'utf8'),
    await readFile(join(example, 'head', 'scenario.py'), 'utf8'),
  );
  const run = await invoke(
    [
      'run',
      config,
      '--base',
      join(example, 'base'),
      '--head',
      join(example, 'head'),
      '--output',
      join(root, 'proof'),
    ],
    root,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /PatchProof PASS/u);
});

test('demo refuses nonempty directories and preserves their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-demo-safe-'));
  const demo = join(root, 'demo');
  await mkdir(demo);
  await writeFile(join(demo, 'keep.txt'), 'keep me\n');
  const result = await invoke(['setup', '--demo', '--demo-dir', demo], root);
  assert.equal(result.code, 2);
  assert.equal(await readFile(join(demo, 'keep.txt'), 'utf8'), 'keep me\n');
});

test('scaffold rejects an unrelated base failure and never overwrites evidence', async () => {
  const { root, example, config } = await workingExample();
  const output = join(root, 'proof');
  await writeFile(join(example, 'base', 'lib.cjs'), 'throw new Error("UNRELATED_FAILURE");\n');
  const first = await invoke(
    [
      'run',
      config,
      '--base',
      join(example, 'base'),
      '--head',
      join(example, 'head'),
      '--output',
      output,
    ],
    root,
  );
  assert.equal(first.code, 2, first.stderr);
  const evidence = join(output, 'patchproof.evidence.json');
  assert.equal(JSON.parse(await readFile(evidence, 'utf8')).outcome, 'INCONCLUSIVE');
  const second = await invoke(
    [
      'run',
      config,
      '--base',
      join(example, 'base'),
      '--head',
      join(example, 'head'),
      '--output',
      output,
    ],
    root,
  );
  assert.equal(second.code, 2);
  assert.match(second.stderr, /Evidence output already exists/u);
  assert.equal((await invoke(['verify', evidence], root)).code, 0);
});

test('Docker-to-local override requires trusted permission and explicit opt-in', async () => {
  const { root, example, config } = await workingExample();
  await writeFile(
    config,
    (await readFile(config, 'utf8')).replace('  backend: local\n', '  backend: docker\n'),
  );
  const base = join(example, 'base');
  const head = join(example, 'head');
  const args = ['run', config, '--base', base, '--head', head, '--backend', 'local'];
  const denied = await invoke([...args, '--output', join(root, 'denied')], root);
  assert.equal(denied.code, 3, denied.stderr);
  assert.match(denied.stdout, /POLICY DENIED/u);
  const preflightDenied = await invoke(
    ['preflight', config, '--base', base, '--head', head, '--backend', 'local', '--json'],
    root,
  );
  assert.equal(preflightDenied.code, 2);
  assert.equal(JSON.parse(preflightDenied.stdout).ok, false);
  const allowed = await invoke(
    [...args, '--allow-unsafe-local', '--output', join(root, 'allowed')],
    root,
  );
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.match(allowed.stdout, /PatchProof PASS/u);
});

test('git run uses base config and records dirty head bytes instead of HEAD SHA', async () => {
  const { root, example, config } = await workingExample();
  await exec('git', ['init', '-q', example]);
  await exec('git', ['-C', example, 'config', 'user.name', 'Audit']);
  await exec('git', ['-C', example, 'config', 'user.email', 'audit@example.invalid']);
  await writeFile(join(example, 'lib.cjs'), await readFile(join(example, 'base', 'lib.cjs')));
  await writeFile(
    join(example, 'scenario.mjs'),
    await readFile(join(example, 'base', 'scenario.mjs')),
  );
  await exec('git', ['-C', example, 'add', '.patchproof.yml', 'lib.cjs', 'scenario.mjs']);
  await exec('git', ['-C', example, 'commit', '-qm', 'broken']);
  const commit = (await exec('git', ['-C', example, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(example, 'lib.cjs'), await readFile(join(example, 'head', 'lib.cjs')));
  await writeFile(
    config,
    (await readFile(config, 'utf8')).replace('Reproduce the claimed bug', 'Untrusted head title'),
  );
  const output = join(root, 'git-proof');
  const result = await invoke(
    [
      'run',
      config,
      '--base',
      'git:HEAD',
      '--head',
      example,
      '--git-repo',
      example,
      '--output',
      output,
    ],
    root,
  );
  assert.equal(result.code, 0, result.stderr);
  const evidence = JSON.parse(await readFile(join(output, 'patchproof.evidence.json'), 'utf8'));
  assert.equal(evidence.outcome, 'PASS');
  assert.equal(evidence.scenario.name, 'Reproduce the claimed bug');
  assert.equal(evidence.sources.base.sha256, commit);
  assert.equal(evidence.sources.base.kind, 'git-commit');
  assert.equal(evidence.sources.head.kind, 'directory-tree');
  assert.notEqual(evidence.sources.head.sha256, commit);
});

test('published sign and verify flags complete a real RSA cycle', async () => {
  const { root, example, config } = await workingExample();
  const output = join(root, 'signed-proof');
  const run = await invoke(
    [
      'run',
      config,
      '--base',
      join(example, 'base'),
      '--head',
      join(example, 'head'),
      '--output',
      output,
    ],
    root,
  );
  assert.equal(run.code, 0, run.stderr);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePath = join(root, 'private.pem');
  const publicPath = join(root, 'public.pem');
  const signature = join(root, 'signature.json');
  await writeFile(privatePath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
  const evidence = join(output, 'patchproof.evidence.json');
  assert.equal(
    (await invoke(['sign', evidence, '--key', privatePath, '--out', signature], root)).code,
    0,
  );
  const verified = await invoke(
    ['verify', evidence, '--signature', signature, '--key', publicPath],
    root,
  );
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout, /VALID/u);
});

test('preflight checks the trusted scenario without running it and history keeps separate runs', async () => {
  const { root, example, config } = await workingExample();
  const base = join(example, 'base');
  const head = join(example, 'head');
  const preflight = await invoke(
    ['preflight', config, '--base', base, '--head', head, '--json'],
    root,
  );
  assert.equal(preflight.code, 0, preflight.stderr);
  assert.equal(
    JSON.parse(preflight.stdout).checks.find(
      (item: { name: string }) => item.name === 'trustedScenario',
    ).ok,
    true,
  );
  const first = await invoke(['run', config, '--base', base, '--head', head, '--json'], root);
  const second = await invoke(['run', config, '--base', base, '--head', head, '--json'], root);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  const a = JSON.parse(first.stdout);
  const b = JSON.parse(second.stdout);
  assert.notEqual(a.bundlePath, b.bundlePath);
  const listed = await invoke(['runs', 'list', '--json'], root);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).runs.length, 2);
  const compared = await invoke(['runs', 'compare', a.bundlePath, b.bundlePath, '--json'], root);
  assert.equal(compared.code, 0, compared.stderr);
  assert.equal(JSON.parse(compared.stdout).sameScenario, true);
  const shown = await invoke(['runs', 'show', a.bundlePath, '--json'], root);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).outcome, 'PASS');
});
