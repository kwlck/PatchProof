import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = rootPackage.version;
const archiveArgumentIndex = process.argv.indexOf('--archive');
const archivePath = resolve(
  root,
  archiveArgumentIndex >= 0 && process.argv[archiveArgumentIndex + 1] !== undefined
    ? process.argv[archiveArgumentIndex + 1]
    : join('work', 'release', `patchproof-${version}.tgz`),
);

function tarEntries(archive) {
  const bytes = gunzipSync(archive);
  const entries = [];
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/u, '');
    const sizeText = header.toString('ascii', 124, 136).replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid tar size for ${name}`);
    const type = header.toString('ascii', 156, 157);
    const start = offset + 512;
    const end = start + size;
    if (end > bytes.length) throw new Error(`Truncated tar entry ${name}`);
    entries.push({ name, type, content: bytes.subarray(start, end) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function commandError(error) {
  if (error && typeof error === 'object') {
    const details = [error.stdout, error.stderr, error.message].filter(
      (value) => typeof value === 'string' && value.length > 0,
    );
    if (details.length > 0) return details.join('\n');
  }
  return String(error);
}

async function assertDeterministicArchive() {
  const buildScript = join(root, 'scripts', 'package-build.mjs');
  await execFileAsync(process.execPath, [buildScript, '--output', archivePath], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 2_000_000,
  });
  const first = await readFile(archivePath);
  await execFileAsync(process.execPath, [buildScript, '--output', archivePath], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 2_000_000,
  });
  const second = await readFile(archivePath);
  const firstHash = createHash('sha256').update(first).digest('hex');
  const secondHash = createHash('sha256').update(second).digest('hex');
  assert(
    first.equals(second),
    `Package archive is not deterministic (${firstHash} != ${secondHash})`,
  );
  assert(first[0] === 0x1f && first[1] === 0x8b, 'Archive is not gzip-compressed');
  assert(
    first[4] === 0 && first[5] === 0 && first[6] === 0 && first[7] === 0,
    'Gzip MTIME must be normalized to zero',
  );
  assert(first[9] === 255, 'Gzip OS byte must be normalized to 255 (portable/unknown)');
}

async function runCli(project, args) {
  const shim = join(
    project,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'patchproof.cmd' : 'patchproof',
  );
  await stat(shim);
  if (process.platform === 'win32') {
    const shimText = await readFile(shim, 'utf8');
    assert(
      /@kwlck[\\/]patchproof[\\/]bin[\\/]patchproof\.js/iu.test(shimText),
      'Windows .cmd shim does not target the installed JS binary',
    );
  }
  try {
    const executable = join(
      project,
      'node_modules',
      '@kwlck',
      'patchproof',
      'bin',
      'patchproof.js',
    );
    await stat(executable);
    return await execFileAsync(process.execPath, [executable, ...args], {
      cwd: project,
      windowsHide: true,
      maxBuffer: 2_000_000,
    });
  } catch (error) {
    throw new Error(`patchproof ${args.join(' ')} failed\n${commandError(error)}`);
  }
}

function npmCommand() {
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  return {
    command: process.execPath,
    prefix: [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')],
  };
}

await assertDeterministicArchive();
const archive = await readFile(archivePath);
const entries = tarEntries(archive);
const names = entries.map(({ name }) => name).sort();
const expectedNames = [
  'package/LICENSE',
  'package/README.md',
  'package/THIRD_PARTY_NOTICES',
  'package/bin/patchproof.js',
  'package/package.json',
];
assert(
  JSON.stringify(names) === JSON.stringify(expectedNames),
  `Unexpected archive file list:\n${names.join('\n')}`,
);
for (const entry of entries) {
  assert(
    entry.type === '0' || entry.type === '',
    `Archive contains a non-regular entry: ${entry.name}`,
  );
  assert(!entry.name.includes('..'), `Archive contains traversal text: ${entry.name}`);
  assert(
    !/(?:workspace:|node_modules|\.github|(?:^|\/)src(?:\/|$)|(?:^|\/)test(?:\/|$))/iu.test(
      entry.name,
    ),
    `Archive contains repository-only content: ${entry.name}`,
  );
  if (entry.name !== 'package/bin/patchproof.js')
    assert(
      !entry.content.includes(Buffer.from('\r\n')),
      `Archive text is not LF-normalized: ${entry.name}`,
    );
}

const manifestEntry = entries.find(({ name }) => name === 'package/package.json');
assert(manifestEntry !== undefined, 'Archive does not contain package/package.json');
const noticeEntry = entries.find(({ name }) => name === 'package/THIRD_PARTY_NOTICES');
assert(noticeEntry !== undefined, 'Archive does not contain THIRD_PARTY_NOTICES');
const readmeEntry = entries.find(({ name }) => name === 'package/README.md');
assert(readmeEntry !== undefined, 'Archive does not contain package/README.md');
const readmeText = readmeEntry.content.toString('utf8');
assert(readmeText.includes('npx patchproof --help'), 'README must use the installed npx wrapper');
assert(
  !readmeText.includes('npm install @kwlck/patchproof'),
  'README must not claim the package is available from the npm registry',
);
const yamlLicense = (await readFile(join(root, 'node_modules', 'yaml', 'LICENSE'), 'utf8')).trim();
const yamlPackage = JSON.parse(
  await readFile(join(root, 'node_modules', 'yaml', 'package.json'), 'utf8'),
);
const noticeText = noticeEntry.content.toString('utf8');
assert(yamlPackage.version === '2.9.0', `Unexpected bundled yaml version: ${yamlPackage.version}`);
assert(yamlPackage.license === 'ISC', 'Bundled yaml license metadata is not ISC');
assert(noticeText.includes('Package: yaml'), 'Third-party notice does not name yaml');
assert(
  noticeText.includes(`Version: ${yamlPackage.version}`),
  'Third-party notice lacks yaml version',
);
assert(noticeText.includes('License: ISC'), 'Third-party notice lacks yaml license identifier');
assert(noticeText.includes(yamlLicense), 'Third-party notice does not contain yaml LICENSE text');
const manifest = JSON.parse(manifestEntry.content.toString('utf8'));
assert(manifest.name === '@kwlck/patchproof', `Unexpected package name: ${manifest.name}`);
assert(
  manifest.version === version,
  `Archive version ${manifest.version} does not match ${version}`,
);
assert(
  manifest.bin?.patchproof === 'bin/patchproof.js',
  'Archive does not expose the patchproof binary',
);
assert(manifest.license === 'Apache-2.0', 'Archive license metadata is missing');
assert(manifest.author === 'kwlck', 'Archive author metadata is missing');
assert(
  manifest.repository?.url === 'https://github.com/kwlck/PatchProof.git',
  'Archive repository metadata is missing',
);
assert(
  manifest.bugs?.url === 'https://github.com/kwlck/PatchProof/issues',
  'Archive bugs metadata is missing',
);
assert(
  manifest.homepage === 'https://github.com/kwlck/PatchProof',
  'Archive homepage metadata is missing',
);
assert(manifest.engines?.node === '>=22.0.0', 'Archive Node engine metadata is missing');
assert(
  manifest.dependencies === undefined,
  'The standalone package must not have runtime dependencies',
);
assert(
  !JSON.stringify(manifest).includes('workspace:'),
  'Archive manifest contains workspace protocol text',
);

const cleanRoom = await mkdtemp(join(tmpdir(), 'patchproof-package-check-'));
try {
  const project = join(cleanRoom, 'project');
  const fixture = join(cleanRoom, 'fixture');
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'patchproof-clean-room', private: true }, null, 2)}\n`,
    'utf8',
  );
  const npm = npmCommand();
  await execFileAsync(
    npm.command,
    [
      ...npm.prefix,
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--offline',
      '--prefix',
      project,
      archivePath,
    ],
    { cwd: cleanRoom, windowsHide: true, maxBuffer: 2_000_000 },
  );
  await cp(join(root, 'fixtures', 'pass'), fixture, { recursive: true, dereference: false });
  const configPath = join(fixture, '.patchproof.yml');
  const fixtureConfig = await readFile(configPath, 'utf8');
  await writeFile(
    configPath,
    fixtureConfig.replace(
      /^(policy:\r?\n)(?:  allowUnsafeLocal:[^\r\n]*\r?\n)?/mu,
      'policy:\n  allowUnsafeLocal: true\n',
    ),
    'utf8',
  );

  const help = await runCli(project, ['--help']);
  assert(help.stdout.includes('PatchProof'), 'Installed binary did not print help');

  const initialized = join(cleanRoom, 'initialized');
  const init = await runCli(project, ['init', initialized]);
  assert(init.stdout.includes('.patchproof.yml'), 'Installed binary did not initialize a scenario');
  await stat(join(initialized, '.patchproof.yml'));

  const validation = await runCli(project, ['validate', configPath]);
  assert(
    validation.stdout.includes('Valid PatchProof configuration'),
    'Installed binary did not validate the fixture',
  );

  const output = join(cleanRoom, 'evidence');
  await runCli(project, [
    'run',
    configPath,
    '--base',
    join(fixture, 'base'),
    '--head',
    join(fixture, 'head'),
    '--backend',
    'local',
    '--allow-unsafe-local',
    '--output',
    output,
  ]);
  const evidencePath = join(output, 'patchproof.evidence.json');
  await stat(evidencePath);

  const verification = await runCli(project, ['verify', evidencePath]);
  assert(
    verification.stdout.includes('VALID evidence bundle'),
    'Installed binary did not verify the fixture bundle',
  );

  const replayPlan = await runCli(project, ['replay', evidencePath]);
  assert(
    replayPlan.stdout.includes('Replay plan'),
    'Installed binary did not produce a replay plan',
  );
} catch (error) {
  throw new Error(
    `Clean-room package smoke test failed for ${basename(archivePath)}\n${commandError(error)}`,
  );
} finally {
  await rm(cleanRoom, { recursive: true, force: true });
}

console.log(`Package check passed for ${archivePath}`);
