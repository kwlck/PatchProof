import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const rootPackagePath = join(root, 'package.json');
const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'));
const version = rootPackage.version;
if (typeof version !== 'string' || version.length === 0) {
  throw new Error('Root package.json must contain a non-empty version');
}

const outputArgumentIndex = process.argv.indexOf('--output');
const archivePath = resolve(
  root,
  outputArgumentIndex >= 0 && process.argv[outputArgumentIndex + 1] !== undefined
    ? process.argv[outputArgumentIndex + 1]
    : join('work', 'release', `patchproof-${version}.tgz`),
);
const releaseDirectory = dirname(archivePath);
const stagingDirectory = join(releaseDirectory, 'package');
const executablePath = join(stagingDirectory, 'bin', 'patchproof.js');
const outputDirectory = releaseDirectory;

await rm(stagingDirectory, { recursive: true, force: true });
await rm(join(outputDirectory, `patchproof-${version}.spdx.json`), { force: true });
await rm(join(outputDirectory, 'patchproof-sbom.spdx.json'), { force: true });
await rm(join(outputDirectory, 'SHA256SUMS'), { force: true });
await mkdir(join(stagingDirectory, 'bin'), { recursive: true });
await mkdir(releaseDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });

const sourceEntry = resolve(root, 'packages', 'cli', 'dist', 'main.js');
const yamlPackagePath = resolve(root, 'node_modules', 'yaml', 'package.json');
const yamlLicensePath = resolve(root, 'node_modules', 'yaml', 'LICENSE');
const yamlPackage = JSON.parse(await readFile(yamlPackagePath, 'utf8'));
if (yamlPackage.version !== '2.9.0' || yamlPackage.license !== 'ISC') {
  throw new Error(`Expected yaml@2.9.0 ISC, found ${yamlPackage.version} ${yamlPackage.license}`);
}
const yamlLicense = (await readFile(yamlLicensePath, 'utf8')).trim();
function normalizeText(text) {
  return text.replace(/\r\n?/gu, '\n');
}
await build({
  entryPoints: [sourceEntry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: executablePath,
  // The minified bundle omits comments; the complete installed yaml license is archived below.
  legalComments: 'none',
  sourcemap: false,
  minify: true,
  charset: 'utf8',
});
const bundle = await readFile(executablePath);
const bundleText = bundle.toString('utf8');
const runtimeRequire =
  "import { createRequire as __patchproofCreateRequire } from 'node:module';\nconst require = __patchproofCreateRequire(import.meta.url);\n";
if (bundleText.startsWith('#!')) {
  const newline = bundleText.indexOf('\n');
  await writeFile(
    executablePath,
    `${bundleText.slice(0, newline + 1)}${runtimeRequire}${bundleText.slice(newline + 1)}`,
  );
} else {
  await writeFile(executablePath, `#!/usr/bin/env node\n${runtimeRequire}${bundleText}`);
}
await chmod(executablePath, 0o755);

const publicPackage = {
  name: '@kwlck/patchproof',
  version,
  description: 'Replayable evidence for pull-request bug fixes',
  type: 'module',
  bin: { patchproof: 'bin/patchproof.js' },
  license: 'Apache-2.0',
  repository: { type: 'git', url: 'https://github.com/kwlck/PatchProof.git' },
  bugs: { url: 'https://github.com/kwlck/PatchProof/issues' },
  homepage: 'https://github.com/kwlck/PatchProof',
  author: 'kwlck',
  keywords: ['patchproof', 'pull-request', 'reproducible-testing', 'evidence'],
  engines: { node: '>=22.0.0' },
};
await writeFile(
  join(stagingDirectory, 'package.json'),
  `${JSON.stringify(publicPackage, null, 2)}\n`,
  'utf8',
);
await writeFile(
  join(stagingDirectory, 'README.md'),
  `# PatchProof\n\nPatchProof runs one trusted reproduction against base and head revisions and writes a verifiable evidence bundle.\n\n## Install from a GitHub Release\n\nDownload \`patchproof-${version}.tgz\` from the GitHub Release assets. In the directory containing the archive, install the local tarball:\n\n\`\`\`text\nnpm install ./patchproof-${version}.tgz\nnpx patchproof --help\n\`\`\`\n\nFor a local build from the source repository, run \`pnpm package:build\` and install \`./work/release/patchproof-${version}.tgz\`.\n\n## Usage\n\n\`\`\`text\nnpx patchproof init ./scenario\nnpx patchproof validate ./scenario/.patchproof.yml\n\`\`\`\n\nThe Docker backend is the production default. The local backend is intended for development and requires both \`--backend local\` and \`--allow-unsafe-local\`.\n\nSee THIRD_PARTY_NOTICES for bundled dependency licenses.\n\nProject documentation: https://github.com/kwlck/PatchProof\n`,
  'utf8',
);
await writeFile(
  join(stagingDirectory, 'THIRD_PARTY_NOTICES'),
  normalizeText(
    `PatchProof bundles yaml ${yamlPackage.version}.\n\nPackage: yaml\nVersion: ${yamlPackage.version}\nLicense: ISC\n\n${yamlLicense}\n`,
  ),
  'utf8',
);
await writeFile(
  join(stagingDirectory, 'LICENSE'),
  normalizeText(await readFile(join(root, 'LICENSE'), 'utf8')),
  'utf8',
);

function tarHeader(name, size, mode) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header[156] = 0x30;
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

const archiveFiles = [
  {
    name: 'package/LICENSE',
    content: await readFile(join(stagingDirectory, 'LICENSE')),
    mode: 0o644,
  },
  {
    name: 'package/README.md',
    content: await readFile(join(stagingDirectory, 'README.md')),
    mode: 0o644,
  },
  {
    name: 'package/THIRD_PARTY_NOTICES',
    content: await readFile(join(stagingDirectory, 'THIRD_PARTY_NOTICES')),
    mode: 0o644,
  },
  {
    name: 'package/bin/patchproof.js',
    content: await readFile(executablePath),
    mode: 0o755,
  },
  {
    name: 'package/package.json',
    content: await readFile(join(stagingDirectory, 'package.json')),
    mode: 0o644,
  },
];
const tarBlocks = [];
for (const file of archiveFiles) {
  tarBlocks.push(tarHeader(file.name, file.content.byteLength, file.mode));
  tarBlocks.push(file.content);
  const padding = (512 - (file.content.byteLength % 512)) % 512;
  if (padding > 0) tarBlocks.push(Buffer.alloc(padding));
}
tarBlocks.push(Buffer.alloc(1024));
await rm(archivePath, { force: true });
const gzip = gzipSync(Buffer.concat(tarBlocks), { level: 9, mtime: 0 });
// Node/zlib has historically emitted a host-dependent OS byte in the gzip
// header. RFC 1952 reserves 255 for an unknown/portable OS, so normalize it
// explicitly along with MTIME to make Windows and Linux bytes identical.
gzip[4] = 0;
gzip[5] = 0;
gzip[6] = 0;
gzip[7] = 0;
gzip[9] = 255;
await rm(archivePath, { force: true });
await writeFile(archivePath, gzip);

console.log(`Built @kwlck/patchproof ${version}`);
console.log(`  staging: ${stagingDirectory}`);
console.log(`  archive: ${archivePath}`);
