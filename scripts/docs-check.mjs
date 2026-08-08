import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
  });
  for (const command of ['init', 'validate', 'run', 'verify', 'replay', 'doctor'])
    if (!help.includes(`patchproof ${command}`)) failures.push(`CLI help is missing ${command}`);
  const output = mkdtempSync(join(root, 'work', 'docs-check-'));
  try {
    const report = execFileSync(
      process.execPath,
      [
        cli,
        'run',
        'fixtures/pass/.patchproof.yml',
        '--base',
        'fixtures/pass/base',
        '--head',
        'fixtures/pass/head',
        '--backend',
        'local',
        '--allow-unsafe-local',
        '--output',
        output,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    for (const marker of ['PatchProof PASS -', 'BASE', 'HEAD', 'Evidence   schema=1', 'Replay'])
      if (!report.includes(marker)) failures.push(`CLI report is missing: ${marker}`);
  } catch (error) {
    failures.push(
      `CLI fixture report did not run: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
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
