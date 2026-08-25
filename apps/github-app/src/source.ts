import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { GitHubInstallationTokenProvider } from './github-auth.js';
import type { GitHubDevelopmentTokenProvider } from './github-api.js';

const execFileAsync = promisify(execFile);

export interface SourceAdapter {
  materializeRevision(
    repository: string,
    sha: string,
    destination: string,
    options?: { installationId?: number; signal?: AbortSignal },
  ): Promise<void>;
}

function assertSourceInput(repository: string, sha: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error('Source repository must be owner/name');
  if (!/^[0-9a-f]{40}$/iu.test(sha))
    throw new Error('Source revision must be a 40-character Git SHA');
}

export class GitHubSourceAdapter implements SourceAdapter {
  public constructor(
    private readonly credentials:
      string | GitHubInstallationTokenProvider | GitHubDevelopmentTokenProvider,
    private readonly gitTimeoutMs = 120_000,
  ) {}

  public async materializeRevision(
    repository: string,
    sha: string,
    destination: string,
    options: { installationId?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    assertSourceInput(repository, sha);
    const root = resolve(destination);
    let token: string;
    if (typeof this.credentials === 'string') token = this.credentials;
    else {
      if (this.credentials.requiresInstallationId && options.installationId === undefined)
        throw new Error('GitHub installation identity is required for source access');
      try {
        if (this.credentials.requiresInstallationId) {
          const installationId = options.installationId;
          if (installationId === undefined)
            throw new Error('GitHub installation identity is required for source access');
          token = await this.credentials.getToken(installationId, options);
        } else token = await this.credentials.getToken(options.installationId, options);
      } catch {
        // Providers must not be able to inject a credential-bearing diagnostic
        // into the Git/source error path.
        throw new Error('GitHub source credential unavailable');
      }
    }
    if (!token || token.length > 16_384) throw new Error('GitHub source credential is invalid');
    const authorization = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString(
      'base64',
    )}`;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const environment: NodeJS.ProcessEnv = {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.TEMP === undefined ? {} : { TEMP: process.env.TEMP }),
      ...(process.env.TMP === undefined ? {} : { TMP: process.env.TMP }),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const runGit = async (arguments_: string[], authenticated = false): Promise<string> => {
      const gitArguments =
        authenticated && token.length > 0
          ? ['--config-env=http.extraHeader=GIT_AUTH_HEADER', ...arguments_]
          : arguments_;
      const result = await execFileAsync('git', gitArguments, {
        // Git reads the header from a child-only environment variable. The
        // credential therefore never appears in argv/process listings, while
        // execFile still preserves argv boundary safety (no shell involved).
        // GitHub's Git transport authenticates installation tokens through the
        // basic scheme with the x-access-token user name, matching what the
        // official checkout action sends.
        env: authenticated ? { ...environment, GIT_AUTH_HEADER: authorization } : environment,
        timeout: this.gitTimeoutMs,
        maxBuffer: 1_048_576,
        shell: false,
        windowsHide: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return result.stdout;
    };
    try {
      await runGit(['init', '--quiet', root]);
      await runGit(['-C', root, 'remote', 'add', 'origin', `https://github.com/${repository}.git`]);
      await runGit(['-C', root, 'fetch', '--no-tags', '--depth', '1', 'origin', sha], true);
      await runGit(['-C', root, 'checkout', '--detach', 'FETCH_HEAD']);
      const actual = (await runGit(['-C', root, 'rev-parse', 'HEAD'])).trim();
      if (actual.toLowerCase() !== sha.toLowerCase())
        throw new Error(`Source checkout resolved to ${actual}, expected ${sha}`);
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : 'GitHub source fetch failed';
      // Scrub both wire forms of the credential: the raw token and the basic
      // header value a proxy or git error handler could echo.
      throw new Error(
        message
          .replaceAll(authorization, '[credential omitted]')
          .replaceAll(token, '[credential omitted]'),
      );
    }
  }
}
