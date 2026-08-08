import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export interface SourceAdapter {
  materializeRevision(repository: string, sha: string, destination: string): Promise<void>;
}

function assertSourceInput(repository: string, sha: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error('Source repository must be owner/name');
  if (!/^[0-9a-f]{40}$/iu.test(sha))
    throw new Error('Source revision must be a 40-character Git SHA');
}

export class GitHubSourceAdapter implements SourceAdapter {
  public constructor(
    private readonly token: string | undefined,
    private readonly gitTimeoutMs = 120_000,
  ) {}

  public async materializeRevision(
    repository: string,
    sha: string,
    destination: string,
  ): Promise<void> {
    assertSourceInput(repository, sha);
    const root = resolve(destination);
    await mkdir(root, { recursive: true });
    const environment: NodeJS.ProcessEnv = {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.TEMP === undefined ? {} : { TEMP: process.env.TEMP }),
      ...(process.env.TMP === undefined ? {} : { TMP: process.env.TMP }),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      ...(this.token === undefined
        ? {}
        : {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader',
            GIT_CONFIG_VALUE_0: `Authorization: Bearer ${this.token}`,
          }),
    };
    const runGit = async (arguments_: string[]): Promise<string> => {
      const result = await execFileAsync('git', arguments_, {
        env: environment,
        timeout: this.gitTimeoutMs,
        maxBuffer: 1_048_576,
        windowsHide: true,
      });
      return result.stdout;
    };
    try {
      await runGit(['init', '--quiet', root]);
      await runGit(['-C', root, 'remote', 'add', 'origin', `https://github.com/${repository}.git`]);
      await runGit(['-C', root, 'fetch', '--no-tags', '--depth', '1', 'origin', sha]);
      await runGit(['-C', root, 'checkout', '--detach', 'FETCH_HEAD']);
      const actual = (await runGit(['-C', root, 'rev-parse', 'HEAD'])).trim();
      if (actual.toLowerCase() !== sha.toLowerCase())
        throw new Error(`Source checkout resolved to ${actual}, expected ${sha}`);
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
}
