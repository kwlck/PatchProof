import type { CheckRunPayload, PullRequestCommentPayload } from './format.js';

export interface PullRequestSnapshot {
  number: number;
  baseSha: string;
  headSha: string;
  headRepository: string;
  fork: boolean;
  state: 'open' | 'closed';
}

export interface GitHubTransport {
  getPullRequest(repository: string, pullRequest: number): Promise<PullRequestSnapshot>;
  createCheck(
    repository: string,
    headSha: string,
    payload: CheckRunPayload,
  ): Promise<{ id: number }>;
  updateCheck(repository: string, checkId: number, payload: CheckRunPayload): Promise<void>;
  createComment(
    repository: string,
    issueNumber: number,
    payload: PullRequestCommentPayload,
  ): Promise<{ id: number; body: string }>;
  updateComment(
    repository: string,
    commentId: number,
    payload: PullRequestCommentPayload,
  ): Promise<void>;
}

export interface ManagedStateStore {
  getDelivery(deliveryId: string): Promise<boolean>;
  markDelivery(deliveryId: string): Promise<void>;
  getRun(
    repository: string,
    pullRequest: number,
  ): Promise<{ checkId?: number; commentId?: number } | undefined>;
  putRun(
    repository: string,
    pullRequest: number,
    value: { checkId?: number; commentId?: number },
  ): Promise<void>;
}

export class MemoryStateStore implements ManagedStateStore {
  private readonly deliveries = new Set<string>();
  private readonly runs = new Map<string, { checkId?: number; commentId?: number }>();

  public getDelivery(deliveryId: string): Promise<boolean> {
    return Promise.resolve(this.deliveries.has(deliveryId));
  }

  public markDelivery(deliveryId: string): Promise<void> {
    this.deliveries.add(deliveryId);
    return Promise.resolve();
  }

  public getRun(
    repository: string,
    pullRequest: number,
  ): Promise<{ checkId?: number; commentId?: number } | undefined> {
    return Promise.resolve(this.runs.get(`${repository}#${pullRequest}`));
  }

  public putRun(
    repository: string,
    pullRequest: number,
    value: { checkId?: number; commentId?: number },
  ): Promise<void> {
    this.runs.set(`${repository}#${pullRequest}`, value);
    return Promise.resolve();
  }
}
