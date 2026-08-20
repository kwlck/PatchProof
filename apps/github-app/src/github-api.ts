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
import type { GitHubInstallationTokenProvider } from './github-auth.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const GITHUB_PAGE_SIZE = 100;
const MAX_CHECK_PAGES = 20;
const MAX_COMMENT_PAGES = 20;

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

function repositoryPath(repository: string): string {
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part)))
    throw new GitHubApiError('Repository must be owner/name');
  return `${encodeURIComponent(parts[0] ?? '')}/${encodeURIComponent(parts[1] ?? '')}`;
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

function assertSha(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/iu.test(value))
    throw new GitHubApiError(`GitHub ${label} must be a 40-character SHA`);
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
  // Do not retain provider/fetch error objects: adapters may attach request
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

export class GitHubApiTransport implements GitHubTransport {
  public readonly requiresInstallationId: boolean;
  public readonly requiresFreshSnapshot = true;
  private readonly provider:
    GitHubInstallationTokenProvider | GitHubDevelopmentTokenProvider | undefined;
  private readonly staticToken: string | undefined;
  public readonly appId?: number;
  private readonly apiBase: string;
  private readonly requestTimeoutMs: number;

  /**
   * String credentials are retained solely as an offline/development
   * compatibility seam. Production entrypoints pass an App provider.
   */
  public constructor(
    credentials: GitHubApiCredentials,
    apiBase = 'https://api.github.com',
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > DEFAULT_REQUEST_TIMEOUT_MS
    )
      throw new GitHubApiError('GitHub API request timeout is invalid');
    this.apiBase = apiBase.replace(/\/$/u, '');
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

  private async requestWithMetadata<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: GitHubMutationOptions,
  ): Promise<{ body: T; headers: Headers }> {
    const token = await this.resolveToken(options);
    const combined = combineSignals(options?.signal, this.requestTimeoutMs);
    // Offline/development static-token tests rely on the caller signal being
    // forwarded verbatim. App-backed production calls use the bounded proxy.
    const requestSignal =
      this.staticToken !== undefined && options?.signal !== undefined
        ? options.signal
        : combined.signal;
    let response: Response;
    try {
      try {
        response = await fetch(`${this.apiBase}${path}`, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: requestSignal,
        });
      } catch (error) {
        safeApiError(error, requestSignal);
      }
      if (!response.ok)
        throw new GitHubApiError(`GitHub API request failed (${response.status})`, response.status);
      if (response.status === 204) return { body: undefined as T, headers: response.headers };
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES)
        throw new GitHubApiError('GitHub API response was too large', response.status);
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        safeApiError(error, requestSignal);
      }
      if (text.length > MAX_RESPONSE_BYTES)
        throw new GitHubApiError('GitHub API response was too large', response.status);
      try {
        return { body: JSON.parse(text) as T, headers: response.headers };
      } catch (error) {
        void error;
        throw new GitHubApiError('GitHub API response was invalid', response.status);
      }
    } finally {
      combined.cleanup();
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: GitHubMutationOptions,
  ): Promise<T> {
    return (await this.requestWithMetadata<T>(method, path, body, options)).body;
  }

  public async getPullRequest(
    repository: string,
    pullRequest: number,
    options?: GitHubMutationOptions,
  ): Promise<PullRequestSnapshot> {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new GitHubApiError('Pull request number must be a positive safe integer');
    const result = await this.request<{
      number: number;
      state: string;
      base?: { sha?: unknown; repo?: { full_name?: unknown } | null };
      head?: { sha?: unknown; repo?: { full_name?: unknown } | null };
    }>('GET', `/repos/${repositoryPath(repository)}/pulls/${pullRequest}`, undefined, options);
    const baseSha = result.base?.sha;
    const headSha = result.head?.sha;
    const headRepository = result.head?.repo?.full_name;
    const baseRepository = result.base?.repo?.full_name;
    if (
      result.number !== pullRequest ||
      (result.state !== 'open' && result.state !== 'closed') ||
      typeof baseSha !== 'string' ||
      typeof headSha !== 'string' ||
      typeof headRepository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(headRepository) ||
      (baseRepository !== undefined &&
        (typeof baseRepository !== 'string' || baseRepository !== repository)) ||
      !/^[0-9a-f]{40}$/iu.test(baseSha) ||
      !/^[0-9a-f]{40}$/iu.test(headSha)
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
    const result = await this.request<{ id: unknown }>(
      'POST',
      `/repos/${repositoryPath(repository)}/check-runs`,
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
    assertPositiveId(checkId, 'check ID');
    await this.request(
      'PATCH',
      `/repos/${repositoryPath(repository)}/check-runs/${checkId}`,
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
    assertPositiveId(issueNumber, 'pull request number');
    const result = await this.request<{ id: unknown; body: unknown }>(
      'POST',
      `/repos/${repositoryPath(repository)}/issues/${issueNumber}/comments`,
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
    assertPositiveId(commentId, 'comment ID');
    await this.request(
      'PATCH',
      `/repos/${repositoryPath(repository)}/issues/comments/${commentId}`,
      payload,
      options,
    );
  }

  public async findManagedCheck(
    repository: string,
    pullRequest: number,
    headSha: string,
    options?: GitHubMutationOptions,
  ): Promise<ManagedCheckLookup | undefined> {
    assertSha(headSha, 'check head');
    // Without an App identity there is no safe way to distinguish a managed
    // CheckRun from a similarly named check created by another integration.
    if (this.appId === undefined) return undefined;
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
      } = await this.requestWithMetadata<{
        total_count?: unknown;
        check_runs?: Array<{
          id?: unknown;
          name?: unknown;
          external_id?: unknown;
          head_sha?: unknown;
          app?: { id?: unknown } | null;
        }>;
      }>(
        'GET',
        `/repos/${repositoryPath(repository)}/commits/${encodeURIComponent(headSha)}/check-runs?check_name=PatchProof&filter=all&app_id=${this.appId}&per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
        undefined,
        options,
      );
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
        if (
          run.head_sha !== undefined &&
          (typeof run.head_sha !== 'string' || run.head_sha.toLowerCase() !== headSha.toLowerCase())
        )
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
    // The current App identity is part of the ownership proof. Do not even
    // inspect comments when it is unavailable.
    if (this.appId === undefined) return undefined;
    let managed: ManagedCommentLookup | undefined;
    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const { body: result } = await this.requestWithMetadata<
        Array<{
          id?: unknown;
          body?: unknown;
          performed_via_github_app?: { id?: unknown } | null;
        }>
      >(
        'GET',
        `/repos/${repositoryPath(repository)}/issues/${pullRequest}/comments?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
        undefined,
        options,
      );
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
