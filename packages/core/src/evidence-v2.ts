import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalize, evidenceDigest } from './canonical.js';
import {
  verifyEvidenceBundle as verifyLegacyEvidenceBundle,
  type VerificationResult,
} from './evidence.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function duplicateJsonKeys(source: string): string[] {
  const stack: Array<Set<string> | null> = [];
  const duplicates: string[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      let lookahead = index;
      while (/\s/u.test(source[lookahead] ?? '')) lookahead += 1;
      const frame = stack[stack.length - 1];
      if (source[lookahead] === ':' && frame instanceof Set) {
        let key: unknown;
        try {
          key = JSON.parse(source.slice(start, index)) as unknown;
        } catch {
          key = undefined;
        }
        if (typeof key === 'string') {
          if (frame.has(key) && duplicates.length < 32) duplicates.push(key);
          frame.add(key);
        }
      }
      continue;
    }
    if (character === '{') stack.push(new Set<string>());
    else if (character === '[') stack.push(null);
    else if (character === '}' || character === ']') stack.pop();
    index += 1;
  }
  return duplicates;
}

function exactKeys(
  object: Record<string, unknown>,
  required: readonly string[],
  path: string,
  errors: string[],
): void {
  const allowed = new Set(required);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${path} contains unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!(key in object)) errors.push(`${path} is missing required field: ${key}`);
  }
}

function normalizeV2Source(
  value: unknown,
  revision: 'base' | 'head',
  errors: string[],
): Record<string, unknown> | undefined {
  const path = `sources.${revision}`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const kind = value.kind;
  if (kind !== 'git-commit' && kind !== 'directory-tree') {
    errors.push(`${path}.kind must be git-commit or directory-tree`);
    return undefined;
  }
  const common = ['revision', 'ref', 'kind', 'location'] as const;
  exactKeys(
    value,
    kind === 'git-commit'
      ? [...common, 'commitOid', 'objectFormat']
      : [...common, 'sha256'],
    path,
    errors,
  );
  if (value.revision !== revision) errors.push(`${path}.revision must be ${revision}`);
  if (typeof value.ref !== 'string' || value.ref.length === 0)
    errors.push(`${path}.ref must be a non-empty string`);
  if (typeof value.location !== 'string' || value.location.length === 0)
    errors.push(`${path}.location must be a non-empty string`);

  if (kind === 'directory-tree') {
    const digest = value.sha256;
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/iu.test(digest))
      errors.push(`${path}.sha256 must be a tree SHA-256 for directory-tree sources`);
    if (errors.length > 0 || typeof digest !== 'string') return undefined;
    return {
      revision,
      ref: value.ref,
      sha256: digest,
      kind,
      location: value.location,
    };
  }

  const oid = value.commitOid;
  const objectFormat = value.objectFormat;
  if (typeof oid !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(oid))
    errors.push(`${path}.commitOid must be a 40- or 64-character Git object ID`);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    errors.push(`${path}.objectFormat must be sha1 or sha256`);
  if (typeof oid === 'string') {
    if (objectFormat === 'sha1' && oid.length !== 40)
      errors.push(`${path}.commitOid length does not match objectFormat sha1`);
    if (objectFormat === 'sha256' && oid.length !== 64)
      errors.push(`${path}.commitOid length does not match objectFormat sha256`);
    if (typeof value.ref === 'string' && value.ref.toLowerCase() !== oid.toLowerCase())
      errors.push(`${path}.ref and commitOid must identify the same commit`);
  }
  if (errors.length > 0 || typeof oid !== 'string') return undefined;

  // The v1 verifier expects a 40-character field called sha256. We already
  // validated the complete v2 OID above, so a deterministic 40-char surrogate
  // is sufficient for reusing all non-source structural/artifact checks.
  const legacyOid = oid.slice(0, 40);
  return {
    revision,
    ref: legacyOid,
    sha256: legacyOid,
    kind,
    location: value.location,
  };
}

function failure(errors: string[], digestValid = false): VerificationResult {
  return {
    valid: false,
    schemaSupported: true,
    digestValid,
    artifactsValid: false,
    completenessValid: false,
    errors,
  };
}

/** Verify schema v1 directly and schema v2 through a strict compatibility layer. */
export async function verifyEvidenceBundle(bundlePath: string): Promise<VerificationResult> {
  let source: string;
  try {
    source = await readFile(bundlePath, 'utf8');
  } catch {
    return verifyLegacyEvidenceBundle(bundlePath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return verifyLegacyEvidenceBundle(bundlePath);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 2) return verifyLegacyEvidenceBundle(bundlePath);

  const errors = duplicateJsonKeys(source).map(
    (key) => `Evidence JSON contains a duplicate object key: ${JSON.stringify(key)}`,
  );
  if (!isRecord(parsed.integrity)) errors.push('integrity must be an object');
  const expectedDigest = isRecord(parsed.integrity) ? parsed.integrity.canonicalSha256 : undefined;
  const digestValid =
    typeof expectedDigest === 'string' &&
    /^[0-9a-f]{64}$/iu.test(expectedDigest) &&
    evidenceDigest(parsed as { integrity: unknown; [key: string]: unknown }) === expectedDigest;
  if (!digestValid) errors.push('Canonical SHA-256 digest does not match');

  const sources = parsed.sources;
  if (!isRecord(sources)) {
    errors.push('sources must be an object');
    return failure(errors, digestValid);
  }
  const base = normalizeV2Source(sources.base, 'base', errors);
  const head = normalizeV2Source(sources.head, 'head', errors);
  if (base === undefined || head === undefined || errors.some((error) => error.includes('duplicate object key')))
    return failure(errors, digestValid);

  const normalized = {
    ...parsed,
    schemaVersion: 1,
    sources: { base, head },
    integrity: { algorithm: 'sha256', canonicalSha256: null, signer: null },
  } as Record<string, unknown> & { integrity: unknown };
  normalized.integrity = {
    algorithm: 'sha256',
    canonicalSha256: evidenceDigest(normalized),
    signer: null,
  };

  const temporaryPath = join(dirname(bundlePath), `.patchproof-v2-${randomUUID()}.json`);
  try {
    await writeFile(temporaryPath, `${canonicalize(normalized)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    const legacy = await verifyLegacyEvidenceBundle(temporaryPath);
    const combinedErrors = [...errors, ...legacy.errors];
    return {
      valid: combinedErrors.length === 0 && digestValid && legacy.valid,
      schemaSupported: true,
      digestValid,
      artifactsValid: legacy.artifactsValid,
      completenessValid: legacy.completenessValid,
      errors: combinedErrors,
    };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
