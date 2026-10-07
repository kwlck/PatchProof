import { readFile, writeFile } from 'node:fs/promises';

const path = 'scripts/apply-v094.mjs';
let source = await readFile(path, 'utf8');
const before = `for (const path of ['packages/runner/src/workspace.ts', 'packages/core/src/evidence.ts']) {
  await transform(path, (source) =>
    replaceOnce(
      source,
      "    'yarn.lock',\\n    'npm-shrinkwrap.json',",
      "    'yarn.lock',\\n    'npm-shrinkwrap.json',\\n    'uv.lock',\\n    'poetry.lock',\\n    'Pipfile.lock',",
      path,
    ),
  );
}`;
const after = `await transform('packages/runner/src/workspace.ts', (source) =>
  replaceOnce(
    source,
    "  'yarn.lock',\\n  'npm-shrinkwrap.json',",
    "  'yarn.lock',\\n  'npm-shrinkwrap.json',\\n  'uv.lock',\\n  'poetry.lock',\\n  'Pipfile.lock',",
    'packages/runner/src/workspace.ts',
  ),
);
await transform('packages/core/src/evidence.ts', (source) =>
  replaceOnce(
    source,
    "    'yarn.lock',\\n    'npm-shrinkwrap.json',",
    "    'yarn.lock',\\n    'npm-shrinkwrap.json',\\n    'uv.lock',\\n    'poetry.lock',\\n    'Pipfile.lock',",
    'packages/core/src/evidence.ts',
  ),
);`;
if (!source.includes(before)) throw new Error('lockfile patch block not found');
source = source.replace(before, after);
await writeFile(path, source, 'utf8');
