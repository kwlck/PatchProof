import { createPrivateKey, createSign } from 'node:crypto';
import type { GitHubMutationOptions } from '@patchproof/github';

const DEFAULT_TOKEN_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PRIVATE_KEY_BYTES = 128 * 1024;
const MAX_TOKEN_LENGTH = 16_384;
const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_INSTALLATION_TOKEN_PATH = '/app/installations/';
const RFC3339_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

export interface GitHubAppCredentials {
  appId: number;
  privateKey: string;
}

export interface GitHubInstallationTokenProvider {
  /** App-backed adapters require an installation identity for every request. */
  readonly requiresInstallationId: true;
  /** Production providers expose this for exact managed-surface ownership checks. */
  readonly appId?: number;
  getToken(installationId: number, options?: GitHubMutationOptions): Promise<string>;
}

export class GitHubAuthError extends Error {
  public readonly code: 'configuration' | 'request' | 'response' | 'aborted';

  public constructor(
    code: 'configuration' | 'request' | 'response' | 'aborted',
    message: string,
    cause?: unknown,
  ) {
    // Never include the private key, JWT, installation token, or response body.
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GitHubAuthError';
    this.code = code;
  }
}

export interface GitHubAppAuthOptions {
  safetyMarginMs?: number;
  requestTimeoutMs?: number;
  clock?: () => Date;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

function assertInstallationId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new GitHubAuthError('configuration', 'GitHub installation identity is invalid');
  return value;
}

export function parseInstallationId(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function normalizePrivateKey(privateKey: string): string {
  const normalized = privateKey.replaceAll('\\n', '\n').trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_PRIVATE_KEY_BYTES)
    throw new GitHubAuthError('configuration', 'GitHub App private key is invalid');
  return normalized;
}

function assertAppId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new GitHubAuthError('configuration', 'GitHub App ID is invalid');
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new GitHubAuthError('configuration', 'GitHub authentication timing is invalid');
  return value;
}

function parseRfc3339Timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = RFC3339_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    month === 2 ? (isLeapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;

  const timezone = match[8] ?? '';
  let offsetMinutes = 0;
  if (timezone !== 'Z') {
    const offsetHours = Number(timezone.slice(1, 3));
    const offsetMinutesPart = Number(timezone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutesPart > 59) return undefined;
    offsetMinutes = (timezone.startsWith('-') ? -1 : 1) * (offsetHours * 60 + offsetMinutesPart);
  }
  const fraction = match[7] ?? '';
  const milliseconds = fraction.length === 0 ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  const timestamp = date.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function installationTokenEndpoint(installationId: number): URL {
  const canonicalId = String(assertInstallationId(installationId));
  const expectedPath = `${GITHUB_INSTALLATION_TOKEN_PATH}${canonicalId}/access_tokens`;
  const endpoint = new URL(
    `${GITHUB_INSTALLATION_TOKEN_PATH}${encodeURIComponent(canonicalId)}/access_tokens`,
    GITHUB_API_ORIGIN,
  );
  if (
    endpoint.origin !== GITHUB_API_ORIGIN ||
    endpoint.pathname !== expectedPath ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  )
    throw new GitHubAuthError('configuration', 'GitHub authentication endpoint is invalid');
  return endpoint;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(caller?.reason);
  if (caller?.aborted) controller.abort(caller.reason);
  else caller?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onAbort);
    },
  };
}

export function createGitHubAppJwt(credentials: GitHubAppCredentials, now = new Date()): string {
  const appId = assertAppId(credentials.appId);
  const privateKey = normalizePrivateKey(credentials.privateKey);
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1)
    throw new GitHubAuthError('configuration', 'GitHub authentication clock is invalid');
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(createPrivateKey(privateKey));
    return `${signingInput}.${base64Url(signature)}`;
  } catch (error) {
    throw new GitHubAuthError('configuration', 'GitHub App private key is invalid', error);
  }
}

/**
 * Installation-aware GitHub App credential provider. Tokens are held only in
 * this bounded cache and are never included in errors or returned diagnostics.
 */
export class GitHubAppAuth implements GitHubInstallationTokenProvider {
  public readonly requiresInstallationId = true as const;
  public readonly appId: number;
  private readonly safetyMarginMs: number;
  private readonly requestTimeoutMs: number;
  private readonly clock: () => Date;
  private readonly credentials: GitHubAppCredentials;
  private readonly cache = new Map<number, CachedToken>();
  private readonly pending = new Map<number, Promise<string>>();

  public constructor(credentials: GitHubAppCredentials, options: GitHubAppAuthOptions = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'apiBase'))
      throw new GitHubAuthError('configuration', 'GitHub authentication API origin is fixed');
    this.credentials = {
      appId: assertAppId(credentials.appId),
      privateKey: normalizePrivateKey(credentials.privateKey),
    };
    this.appId = this.credentials.appId;
    this.safetyMarginMs = boundedInteger(
      options.safetyMarginMs,
      DEFAULT_TOKEN_SAFETY_MARGIN_MS,
      86_400_000,
    );
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      120_000,
    );
    this.clock = options.clock ?? (() => new Date());
  }

  private async requestToken(
    installationId: number,
    options?: GitHubMutationOptions,
  ): Promise<string> {
    const id = assertInstallationId(installationId);
    const jwt = createGitHubAppJwt(this.credentials, this.clock());
    const endpoint = installationTokenEndpoint(id);
    const combined = combineSignals(options?.signal, this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: combined.signal,
          redirect: 'error',
        });
      } catch (error) {
        void error;
        if (combined.signal.aborted)
          throw new GitHubAuthError('aborted', 'GitHub authentication request was aborted');
        throw new GitHubAuthError('request', 'GitHub authentication request failed');
      }
      if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299)
        throw new GitHubAuthError(
          'response',
          `GitHub installation authentication failed (${response.status})`,
        );
      let decoded: unknown;
      try {
        decoded = await response.json();
      } catch (error) {
        void error;
        throw new GitHubAuthError('response', 'GitHub authentication response was invalid');
      }
      const result = recordValue(decoded);
      const token = result?.token;
      const expiresAt = result?.expires_at;
      if (
        typeof token !== 'string' ||
        token.trim().length < 1 ||
        token.length > MAX_TOKEN_LENGTH ||
        typeof expiresAt !== 'string'
      )
        throw new GitHubAuthError('response', 'GitHub authentication response was invalid');
      const expiresAtMs = parseRfc3339Timestamp(expiresAt);
      const nowMs = this.clock().getTime();
      if (
        expiresAtMs === undefined ||
        !Number.isFinite(nowMs) ||
        expiresAtMs <= nowMs + this.safetyMarginMs
      )
        throw new GitHubAuthError('response', 'GitHub authentication response expiry was invalid');
      this.cache.set(id, { token, expiresAtMs });
      return token;
    } finally {
      combined.cleanup();
    }
  }

  public getToken(installationId: number, options?: GitHubMutationOptions): Promise<string> {
    const id = assertInstallationId(installationId);
    const now = this.clock().getTime();
    const cached = this.cache.get(id);
    if (cached !== undefined && cached.expiresAtMs - this.safetyMarginMs > now)
      return Promise.resolve(cached.token);
    const inFlight = this.pending.get(id);
    if (inFlight !== undefined) return inFlight;
    const request = this.requestToken(id, options);
    this.pending.set(id, request);
    void request.then(
      () => {
        if (this.pending.get(id) === request) this.pending.delete(id);
      },
      () => {
        if (this.pending.get(id) === request) this.pending.delete(id);
      },
    );
    return request;
  }

  /** Test/operator hook that discards cached installation tokens. */
  public clear(installationId?: number): void {
    if (installationId === undefined) this.cache.clear();
    else this.cache.delete(assertInstallationId(installationId));
  }
}

export function appCredentialsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GitHubAppCredentials | undefined {
  const rawAppId = environment.PATCHPROOF_GITHUB_APP_ID;
  const privateKey = environment.PATCHPROOF_GITHUB_APP_PRIVATE_KEY;
  if (rawAppId === undefined && privateKey === undefined) return undefined;
  const appId = Number(rawAppId);
  if (!Number.isSafeInteger(appId) || appId < 1 || privateKey === undefined)
    throw new GitHubAuthError(
      'configuration',
      'PATCHPROOF_GITHUB_APP_ID and PATCHPROOF_GITHUB_APP_PRIVATE_KEY must be set',
    );
  return { appId, privateKey };
}
