import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const lock = await readFile('pnpm-lock.yaml', 'utf8');
const packages = [...lock.matchAll(/^ {4}([^:]+):$/gmu)]
  .map((match) => match[1])
  .filter((name) => name !== undefined);
await mkdir('work/release', { recursive: true });
await writeFile(
  'work/release/patchproof-sbom.spdx.json',
  JSON.stringify(
    {
      spdxVersion: 'SPDX-2.3',
      name: 'patchproof-dependency-inventory',
      documentNamespace: `https://example.invalid/patchproof/${Date.now()}`,
      packages: packages.map((name) => ({ name, downloadLocation: 'NOASSERTION' })),
    },
    null,
    2,
  ),
);
console.log(
  `Wrote inventory for ${packages.length} lockfile entries (not a signing or attestation claim)`,
);
