const COMMON_SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}(?=$|[^A-Za-z0-9-])/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{16,}(?=$|[^A-Za-z0-9+/=_-])/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

interface CommonPrefix {
  value: string;
  caseInsensitive?: boolean;
}

const COMMON_PREFIXES: CommonPrefix[] = [
  { value: 'ghp_' },
  { value: 'gho_' },
  { value: 'ghu_' },
  { value: 'ghs_' },
  { value: 'ghr_' },
  { value: 'github_pat_' },
  { value: 'xoxb-' },
  { value: 'xoxa-' },
  { value: 'xoxp-' },
  { value: 'xoxr-' },
  { value: 'xoxs-' },
  { value: 'AKIA' },
  { value: 'Bearer ', caseInsensitive: true },
  { value: 'Basic ', caseInsensitive: true },
  { value: '-----BEGIN ' },
];

interface CommonTokenSpec {
  prefix: string;
  body: RegExp;
  caseInsensitive?: boolean;
}

const COMMON_TOKEN_SPECS: CommonTokenSpec[] = [
  { prefix: 'ghp_', body: /^[A-Za-z0-9_]*$/u },
  { prefix: 'gho_', body: /^[A-Za-z0-9_]*$/u },
  { prefix: 'ghu_', body: /^[A-Za-z0-9_]*$/u },
  { prefix: 'ghs_', body: /^[A-Za-z0-9_]*$/u },
  { prefix: 'ghr_', body: /^[A-Za-z0-9_]*$/u },
  { prefix: 'github_pat_', body: /^[A-Za-z0-9_]*$/u },
  { prefix: 'xoxb-', body: /^[A-Za-z0-9-]*$/u },
  { prefix: 'xoxa-', body: /^[A-Za-z0-9-]*$/u },
  { prefix: 'xoxp-', body: /^[A-Za-z0-9-]*$/u },
  { prefix: 'xoxr-', body: /^[A-Za-z0-9-]*$/u },
  { prefix: 'xoxs-', body: /^[A-Za-z0-9-]*$/u },
  { prefix: 'AKIA', body: /^[0-9A-Z]*$/u },
  {
    prefix: 'Bearer ',
    body: /^[A-Za-z0-9+/=_-]*$/u,
    caseInsensitive: true,
  },
  {
    prefix: 'Basic ',
    body: /^[A-Za-z0-9+/=_-]*$/u,
    caseInsensitive: true,
  },
];

const STREAM_SLICE_CHARS = 4096;
export const STREAM_PENDING_LIMIT_BYTES = 64 * 1024;
const DEFAULT_REPLACEMENT = '[REDACTED]';

function replacementToken(secrets: readonly string[]): string {
  const configured = secrets.filter((secret) => secret.length > 0);
  const candidates = [DEFAULT_REPLACEMENT, '[MASKED]', '<redacted>', '[FILTERED]'];
  for (const candidate of candidates) {
    if (!configured.some((secret) => candidate.includes(secret))) return candidate;
  }
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (!configured.some((secret) => candidate.includes(secret))) return candidate;
  }
  return '';
}

function replacementForSecrets(
  text: string,
  secrets: readonly string[],
  replacement: string,
): string {
  let output = text;
  for (const secret of [...secrets]
    .filter((item) => item.length > 0)
    .sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join(replacement);
  }
  for (const pattern of COMMON_SECRET_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

function isWord(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

function prefixMatchesAt(
  text: string,
  start: number,
  prefix: string,
  caseInsensitive = false,
): boolean {
  const value = text.slice(start, start + prefix.length);
  return caseInsensitive ? value.toLowerCase() === prefix.toLowerCase() : value === prefix;
}

function prefixMatchesSuffix(text: string, prefix: CommonPrefix, length: number): boolean {
  const value = text.slice(text.length - length);
  const expected = prefix.value.slice(0, length);
  return prefix.caseInsensitive === true
    ? value.toLowerCase() === expected.toLowerCase()
    : value === expected;
}

function safeCodeUnitBoundary(text: string, index: number): number {
  if (
    index > 0 &&
    index < text.length &&
    /[\uD800-\uDBFF]/u.test(text[index - 1] ?? '') &&
    /[\uDC00-\uDFFF]/u.test(text[index] ?? '')
  )
    return index - 1;
  return index;
}

function findExactPartialStart(text: string, secrets: readonly string[]): number | undefined {
  const candidates = secrets.filter((secret) => secret.length > 0);
  const longest = candidates.reduce((max, secret) => Math.max(max, secret.length), 0);
  const first = Math.max(0, text.length - Math.max(1, longest));
  for (let start = first; start < text.length; start += 1) {
    const suffix = text.slice(start);
    if (candidates.some((secret) => suffix.length < secret.length && secret.startsWith(suffix)))
      return start;
  }
  return undefined;
}

function findPrefixSuffixStart(text: string): number | undefined {
  let earliest: number | undefined;
  for (const prefix of COMMON_PREFIXES) {
    for (let length = 1; length <= Math.min(prefix.value.length, text.length); length += 1) {
      if (!prefixMatchesSuffix(text, prefix, length)) continue;
      const start = text.length - length;
      if (earliest === undefined || start < earliest) earliest = start;
    }
  }
  return earliest;
}

function findCommonPartialStart(text: string): number | undefined {
  let earliest = findPrefixSuffixStart(text);
  for (const spec of COMMON_TOKEN_SPECS) {
    const searchText = spec.caseInsensitive ? text.toLowerCase() : text;
    const searchPrefix = spec.caseInsensitive ? spec.prefix.toLowerCase() : spec.prefix;
    let start = searchText.indexOf(searchPrefix);
    while (start >= 0) {
      if (
        prefixMatchesAt(text, start, spec.prefix, spec.caseInsensitive) &&
        (start === 0 || !isWord(text[start - 1]))
      ) {
        const body = text.slice(start + spec.prefix.length);
        if (spec.body.test(body)) {
          if (earliest === undefined || start < earliest) earliest = start;
        }
      }
      start = searchText.indexOf(searchPrefix, start + 1);
    }
  }
  const privateHeader = text.lastIndexOf('-----BEGIN');
  if (privateHeader >= 0 && !/-----END [A-Z ]*PRIVATE KEY-----/u.test(text.slice(privateHeader))) {
    if (earliest === undefined || privateHeader < earliest) earliest = privateHeader;
  }
  return earliest;
}

function findPartialStart(text: string, secrets: readonly string[]): number | undefined {
  const exact = findExactPartialStart(text, secrets);
  const common = findCommonPartialStart(text);
  if (exact === undefined) return common;
  if (common === undefined) return exact;
  return Math.min(exact, common);
}

export class StreamingRedactor {
  private carry = '';
  private readonly replacement: string;

  public constructor(private readonly secrets: readonly string[] = []) {
    this.replacement = replacementToken(secrets);
  }

  private drain(final: boolean): string {
    let output = '';
    while (this.carry.length > 0) {
      const redacted = replacementForSecrets(this.carry, this.secrets, this.replacement);
      const partialStart = final ? undefined : findPartialStart(redacted, this.secrets);
      if (partialStart === undefined) {
        output += redacted;
        this.carry = '';
        break;
      }
      const safeEnd = safeCodeUnitBoundary(redacted, partialStart);
      if (safeEnd > 0) {
        output += redacted.slice(0, safeEnd);
        this.carry = redacted.slice(safeEnd);
        continue;
      }
      if (Buffer.byteLength(this.carry, 'utf8') > STREAM_PENDING_LIMIT_BYTES) {
        // The configured replacement already avoids every configured secret,
        // including a literal marker listed by an operator.
        output += this.replacement;
        this.carry = '';
      }
      break;
    }
    return output;
  }

  public push(chunk: string): string {
    let output = '';
    for (let offset = 0; offset < chunk.length; offset += STREAM_SLICE_CHARS) {
      this.carry += chunk.slice(offset, offset + STREAM_SLICE_CHARS);
      output += this.drain(false);
    }
    return output;
  }

  public finish(): string {
    return this.drain(true);
  }
}

export function redactText(text: string, secrets: readonly string[] = []): string {
  const redactor = new StreamingRedactor(secrets);
  return redactor.push(text) + redactor.finish();
}

export interface BoundedLog {
  text: string;
  truncated: boolean;
  sizeBytes: number;
}

export function boundLog(text: string, maxBytes: number): BoundedLog {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('Log byte limit must be a non-negative safe integer');
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  if (sizeBytes <= maxBytes) return { text, truncated: false, sizeBytes };
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1;
  end = safeCodeUnitBoundary(text, end);
  return { text: text.slice(0, end), truncated: true, sizeBytes };
}

export function redactAndBound(
  text: string,
  secrets: readonly string[],
  maxBytes: number,
): BoundedLog {
  return boundLog(redactText(text, secrets), maxBytes);
}
