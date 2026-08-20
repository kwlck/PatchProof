import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const markdown = [
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'SUPPORT.md',
  'GOVERNANCE.md',
  'CHANGELOG.md',
  ...walk(resolve(root, 'docs')),
  ...walk(resolve(root, '.github')),
  ...walk(resolve(root, '.changeset')),
];
const failures = [];
for (const file of markdown) {
  const content = readFileSync(resolve(root, file), 'utf8');
  for (const match of content.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/gu)) {
    const link = match[1];
    if (!link || link.startsWith('http') || link.startsWith('mailto:') || link.startsWith('#'))
      continue;
    const target = resolve(dirname(resolve(root, file)), link);
    if (!existsSync(target)) failures.push(`${file}: missing link target ${link}`);
  }
}
const fixture = readFileSync(resolve(root, 'fixtures/pass/.patchproof.yml'), 'utf8');
if (!/^version:\s*1\s*$/mu.test(fixture))
  failures.push('fixtures/pass/.patchproof.yml must declare version: 1');
const examplePath = resolve(root, 'docs/examples/terminal-pass.txt');
const example = readFileSync(examplePath, 'utf8');
for (const marker of [
  'PatchProof PASS -',
  'BASE  fail        exit=1',
  'HEAD  pass        exit=0',
  'Evidence   schema=1 sha256=',
  'Policy     backend=local network=none trusted-config=base',
  'Replay     patchproof replay patchproof.evidence.json --yes',
]) {
  if (!example.includes(marker)) failures.push(`terminal example is missing: ${marker}`);
}
if (!existsSync(resolve(root, 'packages/cli/dist/main.js')))
  failures.push('built CLI is missing; run pnpm build before docs:check');
else {
  const cli = resolve(root, 'packages/cli/dist/main.js');
  const help = execFileSync(process.execPath, [cli, '--help'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  for (const command of ['init', 'validate', 'run', 'verify', 'replay', 'doctor'])
    if (!help.includes(`patchproof ${command}`)) failures.push(`CLI help is missing ${command}`);
  const workspace = mkdtempSync(join(root, 'work', 'docs-check-'));
  try {
    const config = materializeLocalFixture(workspace);
    const output = join(workspace, 'output');
    const report = execFileSync(
      process.execPath,
      [
        cli,
        'run',
        config,
        '--base',
        resolve(root, 'fixtures/pass/base'),
        '--head',
        resolve(root, 'fixtures/pass/head'),
        '--backend',
        'local',
        '--allow-unsafe-local',
        '--output',
        output,
      ],
      { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 1_000_000 },
    );
    for (const marker of ['PatchProof PASS -', 'BASE', 'HEAD', 'Evidence   schema=1', 'Replay'])
      if (!report.includes(marker)) failures.push(`CLI report is missing: ${marker}`);
  } catch (error) {
    failures.push(`CLI fixture report did not run: ${commandDiagnostics(error)}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `docs:check passed (${markdown.length} Markdown files, CLI help, fixture schema, and links)`,
  );

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(path.slice(root.length + 1));
  }
  return result;
}

function materializeLocalFixture(workspace) {
  const source = resolve(root, 'fixtures/pass/.patchproof.yml');
  const destination = join(workspace, 'pass.local.patchproof.yml');
  copyFileSync(source, destination);
  const fixture = readFileSync(destination, 'utf8');
  const policy = /^(policy:\r?\n)(?:  allowUnsafeLocal:[^\r\n]*\r?\n)?/mu;
  if (!policy.test(fixture)) throw new Error('trusted fixture is missing its policy section');
  const localFixture = fixture.replace(policy, (section, header) => {
    const lineEnding = header.endsWith('\r\n') ? '\r\n' : '\n';
    return `${header}  allowUnsafeLocal: true${lineEnding}`;
  });
  if (!/^  allowUnsafeLocal:\s*true\s*$/mu.test(localFixture))
    throw new Error('temporary docs-check fixture did not enable unsafe local execution');
  writeFileSync(destination, localFixture, 'utf8');
  return destination;
}

function commandDiagnostics(error) {
  if (error !== null && typeof error === 'object') {
    const status =
      'status' in error && (typeof error.status === 'number' || typeof error.status === 'string')
        ? `exit code ${String(error.status)}`
        : undefined;
    const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const details = [status];
    if (stderr.length > 0) {
      const bounded =
        stderr.length > 4_096 ? `${stderr.slice(0, 4_096)}\n[stderr truncated]` : stderr;
      details.push(`stderr: ${bounded}`);
    }
    if (details.some((detail) => detail !== undefined)) return details.filter(Boolean).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}
