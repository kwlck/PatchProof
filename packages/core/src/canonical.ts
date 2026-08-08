import { createHash } from 'node:crypto';

function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON does not support non-finite numbers');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

/** RFC 8785-inspired canonical JSON for the JSON data we emit. */
export function canonicalize(value: unknown): string {
  return canonicalValue(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function unsignedEvidencePayload(bundle: {
  integrity: unknown;
  [key: string]: unknown;
}): Record<string, unknown> {
  const rest = { ...bundle };
  delete rest.integrity;
  return { ...rest, integrity: { algorithm: 'sha256', canonicalSha256: null, signer: null } };
}

export function evidenceDigest(bundle: { integrity: unknown; [key: string]: unknown }): string {
  return sha256(canonicalize(unsignedEvidencePayload(bundle)));
}
