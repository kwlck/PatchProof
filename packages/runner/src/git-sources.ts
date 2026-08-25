import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

export interface GitRevision {
  path: string;
  ref: string;
  cleanup(): Promise<void>;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await exec('git', ['-C', repoPath, ...args], {
    windowsHide: true,
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout;
}

/**
 * Materializes a git revision into a scratch directory via a detached
 * worktree, so checking a fix needs zero manual folder juggling:
 * `--base git:HEAD --head .` is the whole story.
 */
export async function exportGitRevision(
  repoPath: string,
  ref: string,
  scratchHint = 'patchproof-rev-',
): Promise<GitRevision> {
  const resolvedRepo = repoPath;
  try {
    await git(resolvedRepo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    throw new Error(
      `git revision '${ref}' does not resolve in ${resolvedRepo}; pass a commit, branch, tag, or git:HEAD~1 style ref`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), scratchHint));
  try {
    await git(resolvedRepo, ['worktree', 'add', '--detach', dir, ref]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(
      `git worktree for '${ref}' failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
  }
  return {
    path: dir,
    ref,
    cleanup: async () => {
      await git(resolvedRepo, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
      await git(resolvedRepo, ['worktree', 'prune']).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** True when the value selects a git revision (`git:HEAD`, `git:main`, `git:<sha>`). */
export function isGitRef(value: string): boolean {
  return value.startsWith('git:') && value.length > 4;
}

export function gitRefOf(value: string): string {
  return value.slice(4);
}
