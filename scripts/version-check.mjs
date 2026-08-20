import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = process.cwd();
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const versionArgumentIndex = process.argv.indexOf('--version');
const expectedVersion =
  versionArgumentIndex >= 0 && process.argv[versionArgumentIndex + 1] !== undefined
    ? process.argv[versionArgumentIndex + 1]
    : rootManifest.version;
const tagArgumentIndex = process.argv.indexOf('--tag');
const requestedTag =
  tagArgumentIndex >= 0 && process.argv[tagArgumentIndex + 1] !== undefined
    ? process.argv[tagArgumentIndex + 1]
    : process.env.GITHUB_REF_TYPE === 'tag'
      ? process.env.GITHUB_REF_NAME
      : undefined;
const packageArgumentIndex = process.argv.indexOf('--package');
const packagePath =
  packageArgumentIndex >= 0 && process.argv[packageArgumentIndex + 1] !== undefined
    ? resolve(root, process.argv[packageArgumentIndex + 1])
    : undefined;
const assets = [];
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--asset' && process.argv[index + 1] !== undefined)
    assets.push(resolve(root, process.argv[index + 1]));
}

const errors = [];
const changelogVersionPattern = (releaseVersion) =>
  new RegExp(
    `^##\\s+${releaseVersion.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:\\s|$)[^\\r\\n]*`,
    'mu',
  );
function check(condition, message) {
  if (!condition) errors.push(message);
}

check(
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion),
  `Invalid release version: ${expectedVersion}`,
);
if (requestedTag !== undefined && requestedTag.length > 0)
  check(
    requestedTag === `v${expectedVersion}`,
    `Requested tag ${requestedTag} must be v${expectedVersion}`,
  );
const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
const changelogMatch = changelog.match(changelogVersionPattern(expectedVersion));
check(changelogMatch !== null, `CHANGELOG.md must contain a ${expectedVersion} marker`);
if (requestedTag !== undefined && changelogMatch !== null)
  check(
    !/-\s*unreleased\b/iu.test(changelogMatch[0]),
    `CHANGELOG.md ${expectedVersion} entry must be released before tagging ${requestedTag}`,
  );

const manifestPaths = [join(root, 'package.json')];
for (const workspaceDirectory of ['packages', 'apps']) {
  const directory = join(root, workspaceDirectory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = join(directory, entry.name, 'package.json');
      try {
        await stat(candidate);
        manifestPaths.push(candidate);
      } catch {
        // A workspace directory without a package manifest is not a package.
      }
    }
  }
}
for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  check(
    manifest.version === expectedVersion,
    `${manifestPath} version ${manifest.version} does not match ${expectedVersion}`,
  );
}

if (packagePath !== undefined) {
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  check(manifest.name === '@kwlck/patchproof', `${packagePath} has the wrong package name`);
  check(manifest.version === expectedVersion, `${packagePath} has the wrong package version`);
}

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'dist') result.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) result.push(path);
  }
  return result;
}
const productVersionPattern =
  /product\s*:\s*\{\s*name\s*:\s*['"]PatchProof['"]\s*,\s*version\s*:\s*['"]([^'"]+)['"]/gmu;
for (const sourceRoot of ['packages', 'apps']) {
  for (const file of await sourceFiles(join(root, sourceRoot))) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(productVersionPattern))
      check(match[1] === expectedVersion, `${file} contains product version ${match[1]}`);
  }
}

for (const asset of assets) {
  const filename = asset.split(/[\\/]/u).pop();
  check(filename !== undefined, `Invalid asset path ${asset}`);
  if (filename === undefined) continue;
  const validName =
    filename === `patchproof-${expectedVersion}.tgz` ||
    filename === `patchproof-${expectedVersion}.spdx.json` ||
    filename === 'SHA256SUMS';
  check(validName, `Asset filename ${filename} does not match ${expectedVersion}`);
  try {
    await stat(asset);
  } catch {
    check(false, `Release asset does not exist: ${asset}`);
  }
}

if (errors.length > 0) {
  console.error('Version consistency check failed');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Version consistency check passed for ${expectedVersion}`);
  if (requestedTag !== undefined) console.log(`  tag: ${requestedTag}`);
  console.log(`  manifests: ${manifestPaths.length}`);
  console.log(`  source product constants checked where present`);
}
