import { createPrivateKey, createSign } from 'node:crypto';
import type { GitHubMutationOptions } from '@patchproof/github';

const DEFAULT_TOKEN_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PRIVATE_KEY_BYTES = 128 * 1024;

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
  apiBase?: string;
  safetyMarginMs?: number;
  requestTimeoutMs?: number;
  clock?: () => Date;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

interface TokenResponse {
  token: unknown;
  expires_at: unknown;
}

function assertInstallationId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new GitHubAuthError('configuration', 'GitHub installation identity is invalid');
  return value;
}

export function parseInstallationId(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return undefined;
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
  private readonly apiBase: string;
  private readonly safetyMarginMs: number;
  private readonly requestTimeoutMs: number;
  private readonly clock: () => Date;
  private readonly credentials: GitHubAppCredentials;
  private readonly cache = new Map<number, CachedToken>();
  private readonly pending = new Map<number, Promise<string>>();

  public constructor(credentials: GitHubAppCredentials, options: GitHubAppAuthOptions = {}) {
    this.credentials = {
      appId: assertAppId(credentials.appId),
      privateKey: normalizePrivateKey(credentials.privateKey),
    };
    this.appId = this.credentials.appId;
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/u, '');
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
    const combined = combineSignals(options?.signal, this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(`${this.apiBase}/app/installations/${id}/access_tokens`, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: combined.signal,
        });
      } catch (error) {
        void error;
        if (combined.signal.aborted)
          throw new GitHubAuthError('aborted', 'GitHub authentication request was aborted');
        throw new GitHubAuthError('request', 'GitHub authentication request failed');
      }
      if (!response.ok)
        throw new GitHubAuthError(
          'response',
          `GitHub installation authentication failed (${response.status})`,
        );
      let result: TokenResponse;
      try {
        result = (await response.json()) as TokenResponse;
      } catch (error) {
        void error;
        throw new GitHubAuthError('response', 'GitHub authentication response was invalid');
      }
      const token = result.token;
      const expiresAt = result.expires_at;
      if (
        typeof token !== 'string' ||
        token.length < 1 ||
        token.length > 16_384 ||
        typeof expiresAt !== 'string'
      )
        throw new GitHubAuthError('response', 'GitHub authentication response was invalid');
      const expiresAtMs = Date.parse(expiresAt);
      const nowMs = this.clock().getTime();
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs)
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
