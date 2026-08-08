import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const publicFiles = [
  resolve(root, 'README.md'),
  resolve(root, 'LICENSE'),
  resolve(root, 'CONTRIBUTING.md'),
  resolve(root, 'CODE_OF_CONDUCT.md'),
  resolve(root, 'SECURITY.md'),
  resolve(root, 'SUPPORT.md'),
  resolve(root, 'GOVERNANCE.md'),
  resolve(root, 'CHANGELOG.md'),
  resolve(root, 'package.json'),
  resolve(root, '.env.example'),
  ...walk(resolve(root, '.changeset')),
  ...walk(resolve(root, 'docs'), ['.md', '.yml', '.yaml', '.txt']),
  ...walk(resolve(root, '.github')),
  ...walk(resolve(root, 'packages'), ['.ts', '.mjs', '.md', '.yml', '.yaml']),
  ...walk(resolve(root, 'apps'), ['.ts', '.mjs', '.md', '.yml', '.yaml']),
  ...walk(resolve(root, 'scripts'), ['.js', '.mjs', '.ts', '.md', '.yml', '.yaml']),
  ...walk(resolve(root, 'fixtures'), ['.js', '.mjs', '.md', '.txt', '.yml', '.yaml']),
  ...walk(resolve(root, 'test'), ['.js', '.mjs', '.ts', '.md']),
];
const failures = [];
for (const file of publicFiles) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (text.includes('\u2014')) failures.push(`${file}: contains an em dash (U+2014)`);
  if (text.includes('\u2013'))
    failures.push(`${file}: contains an en dash (U+2013); use a plain hyphen`);
}
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `editorial:check passed (${publicFiles.length} public files; no em/en dash characters)`,
  );

function walk(directory, extensions = ['.md', '.yml', '.yaml']) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', 'work', 'outputs'].includes(entry.name))
      files.push(...walk(path, extensions));
    else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)))
      files.push(path);
  }
  return files;
}
