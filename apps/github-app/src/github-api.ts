import type {
  CheckRunPayload,
  GitHubMutationOptions,
  GitHubTransport,
  ManagedCheckLookup,
  ManagedCommentLookup,
  PullRequestCommentPayload,
  PullRequestSnapshot,
} from '@patchproof/github';
import { isManagedComment, managedCheckExternalName } from '@patchproof/github';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { GitHubInstallationTokenProvider } from './github-auth.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const GITHUB_PAGE_SIZE = 100;
const MAX_CHECK_PAGES = 20;
const MAX_COMMENT_PAGES = 20;
const GITHUB_API_HOSTNAME = 'api.github.com';
const GITHUB_API_PROTOCOL = 'https:';
const GITHUB_API_PORT = 443;
const GITHUB_USER_AGENT = 'PatchProof/0.1.0';
const MAX_OWNER_LENGTH = 39;
const MAX_REPOSITORY_LENGTH = 100;

type EndpointMethod = 'GET' | 'POST' | 'PATCH';

const endpointBrand = Symbol('GitHubApiEndpoint');
type GitHubApiEndpoint = {
  readonly method: EndpointMethod;
  readonly path: string;
  readonly [endpointBrand]: true;
};

interface RepositorySegments {
  readonly owner: string;
  readonly repository: string;
  readonly encodedOwner: string;
  readonly encodedRepository: string;
}

export interface GitHubDevelopmentTokenProvider {
  readonly requiresInstallationId: false;
  readonly appId?: number;
  getToken(installationId?: number, options?: GitHubMutationOptions): Promise<string>;
}

export type GitHubApiCredentials =
  string | GitHubInstallationTokenProvider | GitHubDevelopmentTokenProvider;

/** Explicitly named adapter retained for local development and offline tests only. */
export class DevelopmentStaticTokenProvider implements GitHubDevelopmentTokenProvider {
  public readonly requiresInstallationId = false as const;

  public constructor(private readonly token: string) {
    if (!token || token.length > 16_384) throw new Error('Development static token is invalid');
  }

  public getToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
}

export class GitHubApiError extends Error {
  public readonly status: number | undefined;

  public constructor(message: string, status?: number, cause?: unknown) {
    // Keep client-visible diagnostics generic; never include response bodies or credentials.
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

const SECONDARY_RETRY_DEFAULT_MS = 2_000;
const SECONDARY_RETRY_MAX_MS = 5_000;

/**
 * Non-2xx API failure carrying bounded rate-limit diagnostics. The message
 * includes the request method and path plus retry/ratelimit header values;
 * response bodies and credentials are never retained.
 */
class GitHubApiStatusError extends GitHubApiError {
  public readonly retryAfterMs: number | undefined;

  public constructor(message: string, status: number, retryAfterMs: number | undefined) {
    super(message, status);
    this.name = 'GitHubApiError';
    this.retryAfterMs = retryAfterMs;
  }
}

function rawHeaderValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  const text = Array.isArray(value) ? value.join(', ') : value;
  return text === '' ? undefined : text;
}

function boundedSecondaryRetryMs(status: number, headers: IncomingHttpHeaders): number | undefined {
  const text = rawHeaderValue(headers, 'retry-after');
  if (text === undefined) {
    // A bare 403 is a deterministic authorization failure: replaying it only
    // doubles latency and mislabels the diagnostic. 429 without a header is
    // the one case the default delay covers.
    return status === 429 ? SECONDARY_RETRY_DEFAULT_MS : undefined;
  }
  if (!/^[1-9][0-9]*$/u.test(text)) return undefined;
  const waitMs = Number(text) * 1000;
  return waitMs > SECONDARY_RETRY_MAX_MS ? undefined : waitMs;
}

/**
 * A 403/429 never mutated remote state, so content-creation requests rejected
 * by a secondary rate limit are replayed once after the advised delay.
 * Primary exhaustion (remaining=0) and advised waits beyond the bound fail
 * closed with the diagnostic context attached to the error message.
 */
function statusFailure(
  endpoint: GitHubApiEndpoint,
  status: number,
  headers: IncomingHttpHeaders,
): GitHubApiStatusError {
  const retryAfterText = rawHeaderValue(headers, 'retry-after');
  const remainingText = rawHeaderValue(headers, 'x-ratelimit-remaining');
  const notes: string[] = [];
  if (retryAfterText !== undefined) notes.push(`retry-after=${retryAfterText}s`);
  if (remainingText !== undefined) notes.push(`ratelimit-remaining=${remainingText}`);
  let retryAfterMs: number | undefined;
  if ((status === 403 || status === 429) && endpoint.method === 'POST' && remainingText !== '0') {
    retryAfterMs = boundedSecondaryRetryMs(status, headers);
    if (retryAfterMs !== undefined) notes.push('replaying once after the advised delay');
    else if (retryAfterText !== undefined) notes.push('advised wait exceeds the replay bound');
    else notes.push('not replayed');
  }
  const suffix = notes.length === 0 ? '' : ` [${notes.join(', ')}]`;
  return new GitHubApiStatusError(
    `GitHub API request failed (${status}) for ${endpoint.method} ${endpoint.path}${suffix}`,
    status,
    retryAfterMs,
  );
}

async function boundedWait(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('The GitHub API request was aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/u;
const ROUTE_REPOSITORY = '/repos/[A-Za-z0-9-]{1,39}/[A-Za-z0-9_.-]{1,100}';
const ROUTE_ID = '[1-9][0-9]*';
const ROUTE_SHA = '[0-9a-f]{40}';

function repositorySegments(repository: string): RepositorySegments {
  if (typeof repository !== 'string') throw new GitHubApiError('Repository must be owner/name');
  const separator = repository.indexOf('/');
  if (
    separator < 1 ||
    separator !== repository.lastIndexOf('/') ||
    separator === repository.length - 1
  )
    throw new GitHubApiError('Repository must be owner/name');
  const owner = repository.slice(0, separator);
  const repositoryName = repository.slice(separator + 1);
  if (
    owner.length > MAX_OWNER_LENGTH ||
    !OWNER_PATTERN.test(owner) ||
    repositoryName.length > MAX_REPOSITORY_LENGTH ||
    !REPOSITORY_PATTERN.test(repositoryName) ||
    repositoryName === '.' ||
    repositoryName === '..'
  )
    throw new GitHubApiError('Repository must be owner/name');
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepository = encodeURIComponent(repositoryName);
  if (encodedOwner !== owner || encodedRepository !== repositoryName)
    throw new GitHubApiError('Repository must be owner/name');
  return { owner, repository: repositoryName, encodedOwner, encodedRepository };
}

function isRepositoryIdentity(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    repositorySegments(value);
    return true;
  } catch {
    return false;
  }
}

function assertInstallationId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new GitHubApiError('GitHub installation identity is required');
}

function assertPositiveId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new GitHubApiError(`GitHub returned an invalid ${label}`);
  return value;
}

function positiveIdSegment(value: unknown, label: string): string {
  return String(assertPositiveId(value, label));
}

function pageSegment(value: number, max: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new GitHubApiError(`GitHub ${label} page is invalid`);
  return String(value);
}

function assertSha(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value))
    throw new GitHubApiError(`GitHub ${label} must be a 40-character SHA`);
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function canonicalQuery(values: readonly [key: string, value: string][], expected: string): string {
  const query = new URLSearchParams();
  for (const [key, value] of values) query.set(key, value);
  const serialized = query.toString();
  if (serialized !== expected || serialized.includes('#') || serialized.includes('?'))
    throw new GitHubApiError('GitHub API query is invalid');
  return serialized;
}

function makeEndpoint(method: EndpointMethod, path: string, grammar: RegExp): GitHubApiEndpoint {
  if (
    !grammar.test(path) ||
    !path.startsWith('/repos/') ||
    path.includes('\\') ||
    path.includes('%') ||
    path.includes('#') ||
    path.includes('://') ||
    path.includes('@') ||
    hasControlCharacter(path)
  )
    throw new GitHubApiError('GitHub API endpoint is invalid');
  return Object.freeze({ method, path, [endpointBrand]: true }) as GitHubApiEndpoint;
}

function assertEndpoint(value: unknown): GitHubApiEndpoint {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Object.isFrozen(value) ||
    !Object.prototype.hasOwnProperty.call(value, endpointBrand)
  )
    throw new GitHubApiError('GitHub API endpoint is invalid');
  const endpoint = value as GitHubApiEndpoint;
  if (
    endpoint[endpointBrand] !== true ||
    (endpoint.method !== 'GET' && endpoint.method !== 'POST' && endpoint.method !== 'PATCH') ||
    typeof endpoint.path !== 'string'
  )
    throw new GitHubApiError('GitHub API endpoint is invalid');
  return endpoint;
}

function pullRequestEndpoint(
  repository: RepositorySegments,
  pullRequest: number,
): GitHubApiEndpoint {
  const id = positiveIdSegment(pullRequest, 'pull request number');
  const path = `/repos/${repository.encodedOwner}/${repository.encodedRepository}/pulls/${id}`;
  return makeEndpoint('GET', path, new RegExp(`^${ROUTE_REPOSITORY}/pulls/${ROUTE_ID}$`, 'u'));
}

function createCheckEndpoint(repository: RepositorySegments): GitHubApiEndpoint {
  const path = `/repos/${repository.encodedOwner}/${repository.encodedRepository}/check-runs`;
  return makeEndpoint('POST', path, new RegExp(`^${ROUTE_REPOSITORY}/check-runs$`, 'u'));
}

function updateCheckEndpoint(repository: RepositorySegments, checkId: number): GitHubApiEndpoint {
  const id = positiveIdSegment(checkId, 'check ID');
  const path = `/repos/${repository.encodedOwner}/${repository.encodedRepository}/check-runs/${id}`;
  return makeEndpoint(
    'PATCH',
    path,
    new RegExp(`^${ROUTE_REPOSITORY}/check-runs/${ROUTE_ID}$`, 'u'),
  );
}

function createCommentEndpoint(
  repository: RepositorySegments,
  issueNumber: number,
): GitHubApiEndpoint {
  const id = positiveIdSegment(issueNumber, 'pull request number');
  const path = `/repos/${repository.encodedOwner}/${repository.encodedRepository}/issues/${id}/comments`;
  return makeEndpoint(
    'POST',
    path,
    new RegExp(`^${ROUTE_REPOSITORY}/issues/${ROUTE_ID}/comments$`, 'u'),
  );
}

function updateCommentEndpoint(
  repository: RepositorySegments,
  commentId: number,
): GitHubApiEndpoint {
  const id = positiveIdSegment(commentId, 'comment ID');
  const path = `/repos/${repository.encodedOwner}/${repository.encodedRepository}/issues/comments/${id}`;
  return makeEndpoint(
    'PATCH',
    path,
    new RegExp(`^${ROUTE_REPOSITORY}/issues/comments/${ROUTE_ID}$`, 'u'),
  );
}

function commitChecksEndpoint(
  repository: RepositorySegments,
  headSha: string,
  appId: number,
  page: number,
): GitHubApiEndpoint {
  assertSha(headSha, 'check head');
  const appIdValue = positiveIdSegment(appId, 'GitHub App ID');
  const pageValue = pageSegment(page, MAX_CHECK_PAGES, 'check reconciliation');
  const query = canonicalQuery(
    [
      ['check_name', 'PatchProof'],
      ['filter', 'all'],
      ['app_id', appIdValue],
      ['per_page', String(GITHUB_PAGE_SIZE)],
      ['page', pageValue],
    ],
    `check_name=PatchProof&filter=all&app_id=${appIdValue}&per_page=${GITHUB_PAGE_SIZE}&page=${pageValue}`,
  );
  const path = `/repos/${repository.encodedOwner}/${repository.encodedRepository}/commits/${headSha}/check-runs?${query}`;
  return makeEndpoint(
    'GET',
    path,
    new RegExp(
      `^${ROUTE_REPOSITORY}/commits/${ROUTE_SHA}/check-runs\\?check_name=PatchProof&filter=all&app_id=${ROUTE_ID}&per_page=${GITHUB_PAGE_SIZE}&page=${ROUTE_ID}$`,
      'u',
    ),
  );
}

function issueCommentsEndpoint(
  repository: RepositorySegments,
  pullRequest: number,
  page: number,
): GitHubApiEndpoint {
  const id = positiveIdSegment(pullRequest, 'pull request number');
  const pageValue = pageSegment(page, MAX_COMMENT_PAGES, 'comment reconciliation');
  const query = canonicalQuery(
    [
      ['per_page', String(GITHUB_PAGE_SIZE)],
      ['page', pageValue],
    ],
    `per_page=${GITHUB_PAGE_SIZE}&page=${pageValue}`,
  );
  const path = `/repos/${repository.encodedOwner}/${repository.encodedRepository}/issues/${id}/comments?${query}`;
  return makeEndpoint(
    'GET',
    path,
    new RegExp(
      `^${ROUTE_REPOSITORY}/issues/${ROUTE_ID}/comments\\?per_page=${GITHUB_PAGE_SIZE}&page=${ROUTE_ID}$`,
      'u',
    ),
  );
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

function safeApiError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw new DOMException('The GitHub API request was aborted', 'AbortError');
  void error;
  // Do not retain provider/transport error objects: adapters may attach request
  // headers or other credential-bearing diagnostics to them.
  throw new GitHubApiError('GitHub API request failed');
}

function checkPayloadForApi(payload: CheckRunPayload): Record<string, unknown> {
  const { externalName, ...rest } = payload;
  return externalName === undefined ? rest : { ...rest, external_id: externalName };
}

function hasNextLink(headers: Headers): boolean {
  const link = headers.get('link');
  return link !== null && /(?:^|,)\s*<[^>]+>\s*;\s*rel\s*=\s*["']?next["']?/iu.test(link);
}

function headersFromResponse(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function responseBody(response: IncomingMessage, status: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(
        error instanceof Error ? error : new GitHubApiError('GitHub API response failed', status),
      );
    };
    response.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        fail(new GitHubApiError('GitHub API response was too large', status));
        response.destroy();
        return;
      }
      chunks.push(buffer);
    });
    response.once('error', fail);
    response.once('aborted', () =>
      fail(new GitHubApiError('GitHub API response was aborted', status)),
    );
    response.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export class GitHubApiTransport implements GitHubTransport {
  public readonly requiresInstallationId: boolean;
  public readonly requiresFreshSnapshot = true;
  private readonly provider:
    GitHubInstallationTokenProvider | GitHubDevelopmentTokenProvider | undefined;
  private readonly staticToken: string | undefined;
  public readonly appId?: number;
  private readonly requestTimeoutMs: number;

  /**
   * String credentials are retained solely as an offline/development
   * compatibility seam. Production entrypoints pass an App provider.
   */
  public constructor(
    credentials: GitHubApiCredentials,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > DEFAULT_REQUEST_TIMEOUT_MS
    )
      throw new GitHubApiError('GitHub API request timeout is invalid');
    if (typeof credentials === 'string') {
      if (!credentials || credentials.length > 16_384)
        throw new GitHubApiError('Development static token is invalid');
      this.staticToken = credentials;
      this.requiresInstallationId = false;
    } else {
      this.provider = credentials;
      if (credentials.appId !== undefined) {
        this.appId = assertPositiveId(credentials.appId, 'GitHub App ID');
      }
      this.requiresInstallationId = credentials.requiresInstallationId === true;
    }
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private async resolveToken(options?: GitHubMutationOptions): Promise<string> {
    if (this.staticToken !== undefined) return this.staticToken;
    const installationId = options?.installationId;
    if (this.provider === undefined) throw new GitHubApiError('GitHub credentials are unavailable');
    try {
      if (this.provider.requiresInstallationId) {
        if (installationId === undefined)
          throw new GitHubApiError('GitHub installation identity is required');
        assertInstallationId(installationId);
        return await this.provider.getToken(installationId, options);
      }
      return await this.provider.getToken(installationId, options);
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      void error;
      throw new GitHubApiError('GitHub authentication failed');
    }
  }

  async #requestWithMetadata<T>(
    endpoint: GitHubApiEndpoint,
    body?: unknown,
    options?: GitHubMutationOptions,
  ): Promise<{ body: T; headers: Headers }> {
    const safeEndpoint = assertEndpoint(endpoint);
    const token = await this.resolveToken(options);
    const combined = combineSignals(options?.signal, this.requestTimeoutMs);
    // Offline/development static-token tests rely on the caller signal being
    // forwarded verbatim. App-backed production calls use the bounded proxy.
    const requestSignal =
      this.staticToken !== undefined && options?.signal !== undefined
        ? options.signal
        : combined.signal;
    try {
      try {
        return await this.#attempt<T>(safeEndpoint, body, token, requestSignal);
      } catch (error) {
        if (!(error instanceof GitHubApiStatusError) || error.retryAfterMs === undefined)
          throw error;
        await boundedWait(error.retryAfterMs, requestSignal);
        return await this.#attempt<T>(safeEndpoint, body, token, requestSignal);
      }
    } finally {
      combined.cleanup();
    }
  }

  async #attempt<T>(
    endpoint: GitHubApiEndpoint,
    body: unknown,
    token: string,
    signal: AbortSignal,
  ): Promise<{ body: T; headers: Headers }> {
    let requestBody: string | undefined;
    try {
      requestBody = body === undefined ? undefined : JSON.stringify(body);
    } catch (error) {
      safeApiError(error, signal);
    }
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = https.request(
        {
          protocol: GITHUB_API_PROTOCOL,
          hostname: GITHUB_API_HOSTNAME,
          port: GITHUB_API_PORT,
          servername: GITHUB_API_HOSTNAME,
          method: endpoint.method,
          path: endpoint.path,
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': GITHUB_USER_AGENT,
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(requestBody === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          signal,
        },
        resolve,
      );
      request.once('error', reject);
      if (requestBody !== undefined) request.write(requestBody);
      request.end();
    }).catch((error: unknown) => safeApiError(error, signal));
    const status = response.statusCode;
    if (status === undefined) {
      response.destroy();
      throw new GitHubApiError('GitHub API request failed');
    }
    if (!Number.isInteger(status) || status < 200 || status > 299) {
      response.destroy();
      throw statusFailure(endpoint, status, response.headers ?? {});
    }
    const headers = headersFromResponse(response);
    if (status === 204) {
      response.resume();
      return { body: undefined as T, headers };
    }
    const contentLength = headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw new GitHubApiError('GitHub API response was too large', status);
    }
    let text: string;
    try {
      text = await responseBody(response, status);
    } catch (error) {
      if (signal.aborted) safeApiError(error, signal);
      if (error instanceof GitHubApiError) throw error;
      safeApiError(error, signal);
    }
    try {
      return { body: JSON.parse(text) as T, headers };
    } catch (error) {
      void error;
      throw new GitHubApiError('GitHub API response was invalid', status);
    }
  }

  async #request<T>(
    endpoint: GitHubApiEndpoint,
    body?: unknown,
    options?: GitHubMutationOptions,
  ): Promise<T> {
    return (await this.#requestWithMetadata<T>(endpoint, body, options)).body;
  }

  public async getPullRequest(
    repository: string,
    pullRequest: number,
    options?: GitHubMutationOptions,
  ): Promise<PullRequestSnapshot> {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new GitHubApiError('Pull request number must be a positive safe integer');
    const repositoryValue = repositorySegments(repository);
    const result = await this.#request<{
      number: number;
      state: string;
      base?: { sha?: unknown; repo?: { full_name?: unknown } | null };
      head?: { sha?: unknown; repo?: { full_name?: unknown } | null };
    }>(pullRequestEndpoint(repositoryValue, pullRequest), undefined, options);
    const baseSha = result.base?.sha;
    const headSha = result.head?.sha;
    const headRepository = result.head?.repo?.full_name;
    const baseRepository = result.base?.repo?.full_name;
    if (
      result.number !== pullRequest ||
      (result.state !== 'open' && result.state !== 'closed') ||
      typeof baseSha !== 'string' ||
      typeof headSha !== 'string' ||
      !isRepositoryIdentity(headRepository) ||
      (baseRepository !== undefined &&
        (!isRepositoryIdentity(baseRepository) || baseRepository !== repository)) ||
      !isSha(baseSha) ||
      !isSha(headSha)
    )
      throw new GitHubApiError('GitHub returned invalid pull request refs');
    return {
      number: result.number,
      state: result.state,
      baseSha,
      headSha,
      headRepository,
      fork: headRepository !== repository,
      ...(baseRepository === undefined ? {} : { repository: baseRepository }),
    };
  }

  public async createCheck(
    repository: string,
    headSha: string,
    payload: CheckRunPayload,
    options?: GitHubMutationOptions,
  ): Promise<{ id: number }> {
    assertSha(headSha, 'check head');
    const repositoryValue = repositorySegments(repository);
    const result = await this.#request<{ id: unknown }>(
      createCheckEndpoint(repositoryValue),
      { ...checkPayloadForApi(payload), head_sha: headSha },
      options,
    );
    return { id: assertPositiveId(result.id, 'check ID') };
  }

  public async updateCheck(
    repository: string,
    checkId: number,
    payload: CheckRunPayload,
    options?: GitHubMutationOptions,
  ): Promise<void> {
    const repositoryValue = repositorySegments(repository);
    await this.#request(
      updateCheckEndpoint(repositoryValue, checkId),
      checkPayloadForApi(payload),
      options,
    );
  }

  public async createComment(
    repository: string,
    issueNumber: number,
    payload: PullRequestCommentPayload,
    options?: GitHubMutationOptions,
  ): Promise<{ id: number; body: string }> {
    const repositoryValue = repositorySegments(repository);
    const result = await this.#request<{ id: unknown; body: unknown }>(
      createCommentEndpoint(repositoryValue, issueNumber),
      payload,
      options,
    );
    if (typeof result.body !== 'string')
      throw new GitHubApiError('GitHub returned an invalid comment');
    return { id: assertPositiveId(result.id, 'comment ID'), body: result.body };
  }

  public async updateComment(
    repository: string,
    commentId: number,
    payload: PullRequestCommentPayload,
    options?: GitHubMutationOptions,
  ): Promise<void> {
    const repositoryValue = repositorySegments(repository);
    await this.#request(updateCommentEndpoint(repositoryValue, commentId), payload, options);
  }

  public async findManagedCheck(
    repository: string,
    pullRequest: number,
    headSha: string,
    options?: GitHubMutationOptions,
  ): Promise<ManagedCheckLookup | undefined> {
    assertSha(headSha, 'check head');
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new GitHubApiError('Pull request number must be a positive safe integer');
    // Without an App identity there is no safe way to distinguish a managed
    // CheckRun from a similarly named check created by another integration.
    if (this.appId === undefined) return undefined;
    const repositoryValue = repositorySegments(repository);
    const expected = managedCheckExternalName(repository, pullRequest, headSha);
    let scanned = 0;
    for (let page = 1; page <= MAX_CHECK_PAGES; page += 1) {
      const pageResponse: {
        body: {
          total_count?: unknown;
          check_runs?: Array<{
            id?: unknown;
            name?: unknown;
            external_id?: unknown;
            head_sha?: unknown;
            app?: { id?: unknown } | null;
          }>;
        };
        headers: Headers;
      } = await this.#requestWithMetadata<{
        total_count?: unknown;
        check_runs?: Array<{
          id?: unknown;
          name?: unknown;
          external_id?: unknown;
          head_sha?: unknown;
          app?: { id?: unknown } | null;
        }>;
      }>(commitChecksEndpoint(repositoryValue, headSha, this.appId, page), undefined, options);
      const result = pageResponse.body;
      const headers = pageResponse.headers;
      if (typeof result !== 'object' || result === null || Array.isArray(result))
        throw new GitHubApiError('GitHub returned an invalid check response');
      if (result.check_runs !== undefined && !Array.isArray(result.check_runs))
        throw new GitHubApiError('GitHub returned an invalid check response');
      const checkRuns = result.check_runs ?? [];
      if (checkRuns.length > GITHUB_PAGE_SIZE)
        throw new GitHubApiError('GitHub returned an invalid check response');
      const totalCount = result.total_count;
      if (
        totalCount !== undefined &&
        (typeof totalCount !== 'number' || !Number.isSafeInteger(totalCount) || totalCount < 0)
      )
        throw new GitHubApiError('GitHub returned an invalid check response');
      scanned += checkRuns.length;
      for (const run of checkRuns) {
        if (typeof run !== 'object' || run === null || Array.isArray(run))
          throw new GitHubApiError('GitHub returned an invalid check response');
        if (run.name !== 'PatchProof' || run.external_id !== expected || run.app?.id !== this.appId)
          continue;
        if (run.head_sha !== undefined && (!isSha(run.head_sha) || run.head_sha !== headSha))
          throw new GitHubApiError('GitHub returned an invalid check identity');
        const id = assertPositiveId(run.id, 'check ID');
        return { id, ...(typeof run.head_sha === 'string' ? { headSha: run.head_sha } : {}) };
      }
      if (totalCount !== undefined) {
        if (scanned >= totalCount) return undefined;
        if (hasNextLink(headers) || checkRuns.length === GITHUB_PAGE_SIZE) continue;
        // A short page before total_count was exhausted is an incomplete
        // response. Failing closed prevents a duplicate Check creation.
        throw new GitHubApiError('GitHub check reconciliation was incomplete');
      }
      if (hasNextLink(headers)) continue;
      if (checkRuns.length < GITHUB_PAGE_SIZE) return undefined;
      // A full page without total_count or a Link continuation is ambiguous;
      // do not create another managed Check after an incomplete scan.
      throw new GitHubApiError('GitHub check reconciliation was incomplete');
    }
    throw new GitHubApiError('GitHub check reconciliation exceeded its page bound');
  }

  public async findManagedComment(
    repository: string,
    pullRequest: number,
    options?: GitHubMutationOptions,
  ): Promise<ManagedCommentLookup | undefined> {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new GitHubApiError('Pull request number must be a positive safe integer');
    const repositoryValue = repositorySegments(repository);
    // The current App identity is part of the ownership proof. Do not even
    // inspect comments when it is unavailable.
    if (this.appId === undefined) return undefined;
    let managed: ManagedCommentLookup | undefined;
    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const { body: result } = await this.#requestWithMetadata<
        Array<{
          id?: unknown;
          body?: unknown;
          performed_via_github_app?: { id?: unknown } | null;
        }>
      >(issueCommentsEndpoint(repositoryValue, pullRequest, page), undefined, options);
      if (!Array.isArray(result))
        throw new GitHubApiError('GitHub returned an invalid comment response');
      if (result.length > GITHUB_PAGE_SIZE)
        throw new GitHubApiError('GitHub returned an invalid comment response');
      for (let index = result.length - 1; index >= 0; index -= 1) {
        const comment = result[index];
        if (
          comment === undefined ||
          typeof comment !== 'object' ||
          comment === null ||
          Array.isArray(comment) ||
          typeof comment.body !== 'string' ||
          !isManagedComment(comment.body) ||
          comment.performed_via_github_app?.id !== this.appId
        )
          continue;
        managed = { id: assertPositiveId(comment.id, 'comment ID'), body: comment.body };
        break;
      }
      // GitHub returns fewer than the requested page size on the final page.
      // The hard page bound protects reconciliation from an untrusted/misbehaving API.
      if (result.length < GITHUB_PAGE_SIZE) break;
      if (page === MAX_COMMENT_PAGES)
        throw new GitHubApiError('GitHub comment reconciliation was incomplete');
    }
    return managed;
  }
}
