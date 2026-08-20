import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const root = process.cwd();
const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = rootPackage.version;
const inputArgumentIndex = process.argv.indexOf('--input');
const artifactArgumentIndex = process.argv.indexOf('--artifact');
if (artifactArgumentIndex < 0 || process.argv[artifactArgumentIndex + 1] === undefined)
  throw new Error('SBOM validation requires --artifact <release.tgz>');
const artifactPath = resolve(root, process.argv[artifactArgumentIndex + 1]);
const inputPath = resolve(
  root,
  inputArgumentIndex >= 0 && process.argv[inputArgumentIndex + 1] !== undefined
    ? process.argv[inputArgumentIndex + 1]
    : join('work', 'release', `patchproof-${version}.spdx.json`),
);
const document = JSON.parse(await readFile(inputPath, 'utf8'));
const artifact = await readFile(artifactPath);
const errors = [];
const packageIds = new Set();
const relationshipKeys = new Set();
const validRelationshipTypes = new Set(['DESCRIBES', 'DEPENDS_ON', 'CONTAINS']);

function requireValue(condition, message) {
  if (!condition) errors.push(message);
}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest('hex');
}

function tarEntries(bytes) {
  const tar = gunzipSync(bytes);
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const fileName = header.toString('utf8', 0, 100).replace(/\0.*$/u, '');
    const size = Number.parseInt(
      header.toString('ascii', 124, 136).replace(/\0.*$/u, '').trim() || '0',
      8,
    );
    const type = header.toString('ascii', 156, 157);
    if (!fileName.startsWith('package/') || fileName.includes('..') || type !== '0')
      throw new Error(`Unsafe release archive entry: ${fileName}`);
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end > tar.length)
      throw new Error(`Invalid archive entry: ${fileName}`);
    entries.push({ fileName, content: tar.subarray(start, end) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
const archiveEntries = tarEntries(artifact);
const archiveByName = new Map(archiveEntries.map((entry) => [entry.fileName, entry]));

requireValue(document.spdxVersion === 'SPDX-2.3', 'spdxVersion must be SPDX-2.3');
requireValue(document.dataLicense === 'CC0-1.0', 'dataLicense must be CC0-1.0');
requireValue(document.SPDXID === 'SPDXRef-DOCUMENT', 'SPDXID must be SPDXRef-DOCUMENT');
requireValue(typeof document.name === 'string' && document.name.length > 0, 'name is required');
requireValue(
  typeof document.documentNamespace === 'string' && /^https:\/\//u.test(document.documentNamespace),
  'documentNamespace must be an HTTPS URI',
);
requireValue(Array.isArray(document.creationInfo?.creators), 'creationInfo.creators is required');
requireValue(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(document.creationInfo?.created ?? ''),
  'creationInfo.created must be seconds-only UTC',
);
requireValue(
  document.creationInfo?.creators?.length === 1 &&
    document.creationInfo.creators[0] === `Tool: PatchProof SBOM generator-${version}`,
  'creationInfo.creators must identify the versioned generator tool',
);
requireValue(
  Array.isArray(document.packages) && document.packages.length > 0,
  'packages must be non-empty',
);
requireValue(Array.isArray(document.relationships), 'relationships is required');
requireValue(
  Array.isArray(document.documentDescribes) && document.documentDescribes.length > 0,
  'documentDescribes must be non-empty',
);

const packageById = new Map();
for (const item of document.packages ?? []) {
  const id = item?.SPDXID;
  requireValue(
    typeof id === 'string' && /^SPDXRef-[A-Za-z0-9.-]+$/u.test(id),
    `Invalid package SPDXID: ${id}`,
  );
  if (typeof id === 'string') {
    requireValue(!packageIds.has(id), `Duplicate package SPDXID: ${id}`);
    packageIds.add(id);
    packageById.set(id, item);
  }
  requireValue(
    typeof item?.name === 'string' && item.name.length > 0,
    `Package ${id} needs a name`,
  );
  requireValue(
    typeof item?.versionInfo === 'string' && item.versionInfo.length > 0,
    `Package ${id} needs a versionInfo`,
  );
  requireValue(
    typeof item?.downloadLocation === 'string',
    `Package ${id} needs a downloadLocation`,
  );
  requireValue(typeof item?.filesAnalyzed === 'boolean', `Package ${id} needs filesAnalyzed`);
  requireValue(typeof item?.licenseConcluded === 'string', `Package ${id} needs licenseConcluded`);
  requireValue(typeof item?.licenseDeclared === 'string', `Package ${id} needs licenseDeclared`);
  requireValue(typeof item?.copyrightText === 'string', `Package ${id} needs copyrightText`);
  for (const externalRef of item?.externalRefs ?? []) {
    requireValue(
      externalRef.referenceCategory === 'PACKAGE-MANAGER' &&
        externalRef.referenceType === 'purl' &&
        typeof externalRef.referenceLocator === 'string' &&
        externalRef.referenceLocator.startsWith('pkg:npm/'),
      `Package ${id} has an invalid npm purl reference`,
    );
  }
  for (const checksum of item?.checksums ?? []) {
    const length = checksum.algorithm === 'SHA1' ? 40 : checksum.algorithm === 'SHA256' ? 64 : 0;
    requireValue(length > 0, `Package ${id} has an unsupported checksum algorithm`);
    requireValue(
      length === 0 || new RegExp(`^[a-f0-9]{${length}}$`, 'iu').test(checksum.checksumValue ?? ''),
      `Package ${id} has an invalid ${checksum.algorithm} checksum`,
    );
  }
}

const fileById = new Map();
for (const item of document.files ?? []) {
  const id = item?.SPDXID;
  requireValue(
    typeof id === 'string' && /^SPDXRef-[A-Za-z0-9.-]+$/u.test(id),
    `Invalid file SPDXID: ${id}`,
  );
  if (typeof id === 'string') {
    requireValue(!fileById.has(id), `Duplicate file SPDXID: ${id}`);
    fileById.set(id, item);
  }
  requireValue(
    typeof item?.fileName === 'string' && item.fileName.length > 0,
    `File ${id} needs a fileName`,
  );
  const checksums = new Map(
    (item?.checksums ?? []).map((checksum) => [checksum.algorithm, checksum.checksumValue]),
  );
  requireValue(checksums.has('SHA1'), `File ${id} must have the SPDX-required SHA1 checksum`);
  requireValue(checksums.has('SHA256'), `File ${id} must have a SHA256 checksum`);
  for (const [algorithm, value] of checksums) {
    const length = algorithm === 'SHA1' ? 40 : algorithm === 'SHA256' ? 64 : 0;
    requireValue(length > 0, `File ${id} has an unsupported checksum algorithm ${algorithm}`);
    requireValue(
      length === 0 || new RegExp(`^[a-f0-9]{${length}}$`, 'iu').test(value ?? ''),
      `File ${id} has an invalid ${algorithm} checksum`,
    );
  }
}
for (const fileId of packageById.get('SPDXRef-Package-patchproof')?.hasFiles ?? []) {
  requireValue(fileById.has(fileId), `Artifact package hasFiles references unknown file ${fileId}`);
}

for (const related of document.documentDescribes ?? []) {
  requireValue(packageById.has(related), `documentDescribes references unknown package ${related}`);
}
for (const relationship of document.relationships ?? []) {
  const key = `${relationship.spdxElementId}|${relationship.relationshipType}|${relationship.relatedSpdxElement}`;
  requireValue(!relationshipKeys.has(key), `Duplicate relationship ${key}`);
  relationshipKeys.add(key);
  requireValue(
    relationship.relationshipType === 'DESCRIBES'
      ? relationship.spdxElementId === 'SPDXRef-DOCUMENT'
      : packageById.has(relationship.spdxElementId),
    `Invalid relationship source ${relationship.spdxElementId}`,
  );
  requireValue(
    validRelationshipTypes.has(relationship.relationshipType),
    `Invalid relationship type ${relationship.relationshipType}`,
  );
  requireValue(
    relationship.relationshipType === 'CONTAINS'
      ? packageById.has(relationship.relatedSpdxElement) ||
          fileById.has(relationship.relatedSpdxElement)
      : packageById.has(relationship.relatedSpdxElement),
    `Invalid relationship target ${relationship.relatedSpdxElement}`,
  );
}

const product = packageById.get('SPDXRef-Package-patchproof');
requireValue(product?.name === '@kwlck/patchproof', 'Artifact package identity is missing');
requireValue(product?.versionInfo === version, `Artifact package version must be ${version}`);
requireValue(
  product?.licenseDeclared === 'Apache-2.0',
  'Artifact package license must be Apache-2.0',
);
requireValue(
  product?.packageFileName === `patchproof-${version}.tgz`,
  'Artifact packageFileName must match the release asset name',
);
requireValue(product?.filesAnalyzed === true, 'Artifact package must analyze staged files');
const analyzedFiles = (product?.hasFiles ?? [])
  .map((fileId) => fileById.get(fileId))
  .filter(Boolean);
const verificationCode = product?.packageVerificationCode?.packageVerificationCodeValue;
requireValue(
  typeof verificationCode === 'string' && /^[a-f0-9]{40}$/iu.test(verificationCode),
  'Artifact package needs a 40-character packageVerificationCodeValue',
);
if (analyzedFiles.length > 0) {
  const expectedVerificationCode = digest(
    'sha1',
    [...analyzedFiles]
      .map(
        (file) => file.checksums.find((checksum) => checksum.algorithm === 'SHA1')?.checksumValue,
      )
      .sort()
      .join(''),
  );
  requireValue(
    verificationCode === expectedVerificationCode,
    'Artifact packageVerificationCodeValue does not match the analyzed file SHA1 values',
  );
}
const archiveDigest = digest('sha256', artifact);
requireValue(
  product?.checksums?.some(
    (checksum) => checksum.algorithm === 'SHA256' && checksum.checksumValue === archiveDigest,
  ),
  'Artifact package SHA256 checksum does not match --artifact',
);
const listedNames = new Set();
for (const file of analyzedFiles) {
  listedNames.add(file.fileName);
  const archiveEntry = archiveByName.get(file.fileName);
  requireValue(
    archiveEntry !== undefined,
    `SBOM file is missing from release archive: ${file.fileName}`,
  );
  if (archiveEntry !== undefined) {
    const sha1Value = digest('sha1', archiveEntry.content);
    const sha256Value = digest('sha256', archiveEntry.content);
    requireValue(
      file.checksums.some(
        (checksum) => checksum.algorithm === 'SHA1' && checksum.checksumValue === sha1Value,
      ),
      `SBOM SHA1 does not match archive file: ${file.fileName}`,
    );
    requireValue(
      file.checksums.some(
        (checksum) => checksum.algorithm === 'SHA256' && checksum.checksumValue === sha256Value,
      ),
      `SBOM SHA256 does not match archive file: ${file.fileName}`,
    );
  }
}
for (const archiveEntry of archiveEntries)
  requireValue(
    listedNames.has(archiveEntry.fileName),
    `Archive file is absent from SBOM: ${archiveEntry.fileName}`,
  );
const yaml = packageById.get('SPDXRef-Package-yaml');
requireValue(yaml?.versionInfo === '2.9.0', 'SBOM must identify bundled yaml@2.9.0');
requireValue(yaml?.licenseDeclared === 'ISC', 'Bundled yaml license must be ISC');
requireValue(
  document.relationships?.some(
    (item) =>
      item.spdxElementId === 'SPDXRef-Package-patchproof' &&
      item.relationshipType === 'DEPENDS_ON' &&
      item.relatedSpdxElement === 'SPDXRef-Package-yaml',
  ),
  'SBOM must express the bundled yaml dependency',
);
requireValue(
  document.relationships?.some(
    (item) =>
      item.spdxElementId === 'SPDXRef-Package-patchproof' &&
      item.relationshipType === 'CONTAINS' &&
      item.relatedSpdxElement === 'SPDXRef-Package-yaml',
  ),
  'SBOM must express that yaml is bundled',
);
requireValue(
  (document.files ?? []).some((item) => item.fileName === 'package/THIRD_PARTY_NOTICES'),
  'SBOM must checksum THIRD_PARTY_NOTICES',
);

if (errors.length > 0) {
  console.error(`SBOM validation failed for ${inputPath}`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`SBOM validation passed for ${inputPath}`);
  console.log(`  packages: ${document.packages.length}`);
  console.log(`  relationships: ${document.relationships.length}`);
}
