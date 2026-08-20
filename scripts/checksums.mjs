import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const root = process.cwd();
const directoryArgumentIndex = process.argv.indexOf('--dir');
const outputArgumentIndex = process.argv.indexOf('--output');
const directory = resolve(
  root,
  directoryArgumentIndex >= 0 && process.argv[directoryArgumentIndex + 1] !== undefined
    ? process.argv[directoryArgumentIndex + 1]
    : join('work', 'release'),
);
const outputPath = resolve(
  root,
  outputArgumentIndex >= 0 && process.argv[outputArgumentIndex + 1] !== undefined
    ? process.argv[outputArgumentIndex + 1]
    : join(directory, 'SHA256SUMS'),
);
const explicitAssets = [];
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--asset' && process.argv[index + 1] !== undefined)
    explicitAssets.push(resolve(root, process.argv[index + 1]));
}

const assets =
  explicitAssets.length > 0
    ? explicitAssets
    : (await readdir(directory, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isFile() && (entry.name.endsWith('.tgz') || entry.name.endsWith('.spdx.json')),
        )
        .map((entry) => join(directory, entry.name));
assets.sort((left, right) => basename(left).localeCompare(basename(right)));
if (assets.length === 0) throw new Error(`No release assets found in ${directory}`);

const lines = [];
for (const asset of assets) {
  await stat(asset);
  const digest = createHash('sha256')
    .update(await readFile(asset))
    .digest('hex');
  lines.push(`${digest}  ${basename(asset)}`);
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote SHA256SUMS for ${assets.length} assets: ${outputPath}`);
