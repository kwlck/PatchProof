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
const interpolationBefore = "await writeFile(bundlePath, \\\`${canonicalize(bundle)}\\\\n\\\`, 'utf8');";
const interpolationAfter = "await writeFile(bundlePath, \\\`\\${canonicalize(bundle)}\\\\n\\\`, 'utf8');";
if (!source.includes(interpolationBefore)) throw new Error('regression test interpolation was not found');
source = source.replace(interpolationBefore, interpolationAfter);
const migrationImportBefore = "const migrationHelper = `import { DatabaseSync } from 'node:sqlite';";
const migrationImportAfter = "const migrationHelper = `import type { DatabaseSync } from 'node:sqlite';";
if (!source.includes(migrationImportBefore)) throw new Error('migration helper import was not found');
source = source.replace(migrationImportBefore, migrationImportAfter);

const finalMarker = "console.log('Applied PatchProof v0.9.4 hardening changes.');";
if (!source.includes(finalMarker)) throw new Error('final patch marker was not found');
const fixtureRefresh = `{
  const fixturePath = 'docs/examples/fixture-proof/patchproof.evidence.json';
  const fixtureBundle = JSON.parse(await readFile(fixturePath, 'utf8'));
  fixtureBundle.product.version = '0.9.4';
  const canonicalValue = (value) => {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('non-finite canonical JSON number');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    if (Array.isArray(value)) return '[' + value.map((item) => canonicalValue(item)).join(',') + ']';
    if (typeof value === 'object') {
      const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
      return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalValue(value[key])).join(',') + '}';
    }
    throw new TypeError('unsupported canonical JSON value');
  };
  const unsigned = { ...fixtureBundle, integrity: { algorithm: 'sha256', canonicalSha256: null, signer: null } };
  const { createHash } = await import('node:crypto');
  fixtureBundle.integrity = {
    algorithm: 'sha256',
    canonicalSha256: createHash('sha256').update(canonicalValue(unsigned)).digest('hex'),
    signer: null,
  };
  await writeFile(fixturePath, JSON.stringify(fixtureBundle, null, 2) + '\\n', 'utf8');
}

`;
source = source.replace(finalMarker, fixtureRefresh + finalMarker);
await writeFile(path, source, 'utf8');
