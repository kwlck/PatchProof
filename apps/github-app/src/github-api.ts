import type {
  CheckRunPayload,
  GitHubTransport,
  PullRequestSnapshot,
  PullRequestCommentPayload,
} from '@patchproof/github';

function repositoryPath(repository: string): string {
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part)))
    throw new Error('Repository must be owner/name');
  return `${encodeURIComponent(parts[0] ?? '')}/${encodeURIComponent(parts[1] ?? '')}`;
}

export class GitHubApiTransport implements GitHubTransport {
  public constructor(
    private readonly token: string,
    private readonly apiBase = 'https://api.github.com',
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} returned ${response.status}`);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  public async getPullRequest(
    repository: string,
    pullRequest: number,
  ): Promise<PullRequestSnapshot> {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new Error('Pull request number must be a positive safe integer');
    const result = await this.request<{
      number: number;
      state: string;
      base?: { sha?: unknown };
      head?: { sha?: unknown; repo?: { full_name?: unknown } | null };
    }>('GET', `/repos/${repositoryPath(repository)}/pulls/${pullRequest}`);
    const baseSha = result.base?.sha;
    const headSha = result.head?.sha;
    const headRepository = result.head?.repo?.full_name;
    if (
      result.number !== pullRequest ||
      (result.state !== 'open' && result.state !== 'closed') ||
      typeof baseSha !== 'string' ||
      typeof headSha !== 'string' ||
      typeof headRepository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(headRepository) ||
      !/^[0-9a-f]{40}$/iu.test(baseSha) ||
      !/^[0-9a-f]{40}$/iu.test(headSha)
    )
      throw new Error('GitHub returned invalid pull request refs');
    return {
      number: result.number,
      state: result.state,
      baseSha,
      headSha,
      headRepository,
      fork: headRepository !== repository,
    };
  }

  public async createCheck(
    repository: string,
    headSha: string,
    payload: CheckRunPayload,
  ): Promise<{ id: number }> {
    const result = await this.request<{ id: number }>(
      'POST',
      `/repos/${repositoryPath(repository)}/check-runs`,
      { ...payload, head_sha: headSha },
    );
    return { id: result.id };
  }

  public async updateCheck(
    repository: string,
    checkId: number,
    payload: CheckRunPayload,
  ): Promise<void> {
    await this.request(
      'PATCH',
      `/repos/${repositoryPath(repository)}/check-runs/${checkId}`,
      payload,
    );
  }

  public async createComment(
    repository: string,
    issueNumber: number,
    payload: PullRequestCommentPayload,
  ): Promise<{ id: number; body: string }> {
    const result = await this.request<{ id: number; body: string }>(
      'POST',
      `/repos/${repositoryPath(repository)}/issues/${issueNumber}/comments`,
      payload,
    );
    return { id: result.id, body: result.body };
  }

  public async updateComment(
    repository: string,
    commentId: number,
    payload: PullRequestCommentPayload,
  ): Promise<void> {
    await this.request(
      'PATCH',
      `/repos/${repositoryPath(repository)}/issues/comments/${commentId}`,
      payload,
    );
  }
}
