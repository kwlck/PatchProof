import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = rootPackage.version;
const outputArgumentIndex = process.argv.indexOf('--output');
const artifactArgumentIndex = process.argv.indexOf('--artifact');
const outputPath = resolve(
  root,
  outputArgumentIndex >= 0 && process.argv[outputArgumentIndex + 1] !== undefined
    ? process.argv[outputArgumentIndex + 1]
    : join('work', 'release', `patchproof-${version}.spdx.json`),
);
const artifactPath = resolve(
  root,
  artifactArgumentIndex >= 0 && process.argv[artifactArgumentIndex + 1] !== undefined
    ? process.argv[artifactArgumentIndex + 1]
    : join('work', 'release', `patchproof-${version}.tgz`),
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha1(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

function packageUrl(name, packageVersion) {
  const encodedName = name.startsWith('@') ? `%40${name.slice(1)}` : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(packageVersion)}`;
}

function parseTarEntries(archive) {
  const bytes = gunzipSync(archive);
  const entries = [];
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/u, '');
    const size = Number.parseInt(
      header.toString('ascii', 124, 136).replace(/\0.*$/u, '').trim() || '0',
      8,
    );
    const type = header.toString('ascii', 156, 157);
    if (!Number.isSafeInteger(size) || size < 0 || (type !== '0' && type !== ''))
      throw new Error(`Invalid release archive entry: ${name}`);
    const start = offset + 512;
    const end = start + size;
    if (end > bytes.length) throw new Error(`Truncated release archive entry: ${name}`);
    entries.push({ name, content: bytes.subarray(start, end) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function releaseTimestamp() {
  const configured = process.env.SOURCE_DATE_EPOCH;
  if (configured !== undefined) {
    if (!/^\d+$/u.test(configured))
      throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer');
    const epoch = Number.parseInt(configured, 10);
    if (!Number.isSafeInteger(epoch) || epoch < 0)
      throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer');
    return { epoch, source: 'SOURCE_DATE_EPOCH' };
  }
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%ct'], { cwd: root });
    const epoch = Number.parseInt(stdout.trim(), 10);
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('invalid git timestamp');
    return { epoch, source: 'git commit timestamp fallback' };
  } catch {
    throw new Error(
      'SOURCE_DATE_EPOCH is required outside a git checkout; set it to the release commit timestamp',
    );
  }
}

const archive = await readFile(artifactPath);
const entries = parseTarEntries(archive);
if (entries.length === 0) throw new Error(`Release archive has no files: ${artifactPath}`);
const entryNames = new Set(entries.map(({ name }) => name));
const noticeName = 'package/THIRD_PARTY_NOTICES';
if (!entryNames.has(noticeName)) throw new Error('Release archive lacks THIRD_PARTY_NOTICES');

const yamlPackagePath = resolve(root, 'node_modules', 'yaml', 'package.json');
const yamlLicensePath = resolve(root, 'node_modules', 'yaml', 'LICENSE');
const yamlPackage = JSON.parse(await readFile(yamlPackagePath, 'utf8'));
const yamlLicense = (await readFile(yamlLicensePath, 'utf8')).trim();
if (yamlPackage.version !== '2.9.0' || yamlPackage.license !== 'ISC')
  throw new Error(
    `Expected bundled yaml@2.9.0 ISC, found ${yamlPackage.version} ${yamlPackage.license}`,
  );
const noticeText = entries.find(({ name }) => name === noticeName).content.toString('utf8');
if (!noticeText.includes(yamlLicense))
  throw new Error('THIRD_PARTY_NOTICES does not contain the installed yaml LICENSE text');

const productId = 'SPDXRef-Package-patchproof';
const yamlId = 'SPDXRef-Package-yaml';
const files = entries.map(({ name, content }) => ({
  SPDXID: `SPDXRef-File-${sha256(Buffer.from(name)).slice(0, 24)}`,
  fileName: name,
  // SPDX-2.3 requires SHA-1 for every analyzed file. Keep SHA-256 as the
  // stronger supplemental digest used by our release/checksum checks.
  checksums: [
    { algorithm: 'SHA1', checksumValue: sha1(content) },
    { algorithm: 'SHA256', checksumValue: sha256(content) },
  ],
  licenseConcluded: 'NOASSERTION',
  licenseInfoInFiles: ['NOASSERTION'],
  copyrightText: 'NOASSERTION',
}));
const packageVerificationCodeValue = sha1(
  [...files]
    .map((file) => file.checksums.find((checksum) => checksum.algorithm === 'SHA1').checksumValue)
    .sort()
    .join(''),
);
const packageFile = `patchproof-${version}.tgz`;
const product = {
  SPDXID: productId,
  name: '@kwlck/patchproof',
  versionInfo: version,
  packageFileName: packageFile,
  downloadLocation: `https://github.com/kwlck/PatchProof/releases/download/v${version}/${packageFile}`,
  filesAnalyzed: true,
  hasFiles: files.map((file) => file.SPDXID),
  packageVerificationCode: { packageVerificationCodeValue },
  licenseConcluded: 'Apache-2.0 AND ISC',
  licenseDeclared: 'Apache-2.0',
  copyrightText: 'NOASSERTION',
  checksums: [{ algorithm: 'SHA256', checksumValue: sha256(archive) }],
  externalRefs: [
    {
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: packageUrl('@kwlck/patchproof', version),
    },
  ],
};
const yaml = {
  SPDXID: yamlId,
  name: 'yaml',
  versionInfo: yamlPackage.version,
  downloadLocation: `https://registry.npmjs.org/yaml/-/yaml-${yamlPackage.version}.tgz`,
  filesAnalyzed: false,
  licenseConcluded: 'ISC',
  licenseDeclared: 'ISC',
  copyrightText: 'Copyright Eemeli Aro <eemeli@gmail.com>',
  externalRefs: [
    {
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: packageUrl('yaml', yamlPackage.version),
    },
  ],
  comment: 'Bundled runtime dependency. Its complete ISC notice is in package/THIRD_PARTY_NOTICES.',
};
const relationships = [
  {
    spdxElementId: 'SPDXRef-DOCUMENT',
    relationshipType: 'DESCRIBES',
    relatedSpdxElement: productId,
  },
  { spdxElementId: productId, relationshipType: 'DEPENDS_ON', relatedSpdxElement: yamlId },
  { spdxElementId: productId, relationshipType: 'CONTAINS', relatedSpdxElement: yamlId },
  ...files.map((file) => ({
    spdxElementId: productId,
    relationshipType: 'CONTAINS',
    relatedSpdxElement: file.SPDXID,
  })),
];
const timestamp = await releaseTimestamp();
const document = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `patchproof-${version}`,
  documentNamespace: `https://github.com/kwlck/PatchProof/releases/download/v${version}/patchproof-${version}.spdx.json`,
  creationInfo: {
    created: new Date(timestamp.epoch * 1000).toISOString().replace('.000Z', 'Z'),
    creators: [`Tool: PatchProof SBOM generator-${version}`],
    licenseListVersion: '3.26',
  },
  documentDescribes: [productId],
  packages: [product, yaml],
  files,
  relationships,
  comment: `Artifact-derived SBOM for ${packageFile}; timestamp source: ${timestamp.source}. Only bundled runtime components are listed.`,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
await stat(artifactPath);
console.log(
  `Wrote SPDX 2.3 artifact SBOM with ${document.packages.length} packages, ${files.length} files, and ${relationships.length} relationships`,
);
console.log(`  output: ${outputPath}`);
console.log(`  timestamp source: ${timestamp.source}`);
