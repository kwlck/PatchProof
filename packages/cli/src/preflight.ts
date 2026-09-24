import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertSafeRelativePath, loadConfig, loadTrustedConfig } from '@patchproof/config';
import { exportGitRevision, gitRefOf, isGitRef, type GitRevision } from '@patchproof/runner';
import { hasOption, option, type ParsedArgs } from './args.js';

const exec = promisify(execFile);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Inspect a proposed run without executing the repository scenario. */
export async function runPreflight(args: ParsedArgs): Promise<number> {
  const configPath = args.positional[0];
  const base = option(args, 'base');
  const head = option(args, 'head');
  if (configPath === undefined || typeof base !== 'string' || typeof head !== 'string')
    throw new Error('preflight requires config, --base <dir|git:ref>, and --head <dir|git:ref>');
  const repoOption = option(args, 'git-repo');
  const repo = typeof repoOption === 'string' ? resolve(repoOption) : process.cwd();
  let baseRevision: GitRevision | undefined;
  let headRevision: GitRevision | undefined;
  try {
    baseRevision = isGitRef(base) ? await exportGitRevision(repo, gitRefOf(base)) : undefined;
    headRevision = isGitRef(head) ? await exportGitRevision(repo, gitRefOf(head)) : undefined;
    const basePath = baseRevision?.path ?? resolve(base);
    const headPath = headRevision?.path ?? resolve(head);
    const configAbsolute = isAbsolute(configPath) ? configPath : resolve(repo, configPath);
    const configRelative = relative(repo, configAbsolute);
    if (
      baseRevision !== undefined &&
      (configRelative === '' ||
        configRelative === '..' ||
        configRelative.startsWith(`..${sep}`) ||
        isAbsolute(configRelative))
    )
      throw new Error('Git base configuration must be inside --git-repo');
    const loaded =
      baseRevision === undefined
        ? await loadConfig(configPath)
        : await loadTrustedConfig(join(baseRevision.path, configRelative), baseRevision.path);
    const backendOption = option(args, 'backend');
    if (backendOption !== undefined && backendOption !== 'local' && backendOption !== 'docker')
      throw new Error('preflight --backend must be docker or local');
    const backend = backendOption ?? loaded.config.policy.backend;
    const checks: Check[] = [];
    for (const [name, path] of [
      ['base', basePath],
      ['head', headPath],
    ] as const) {
      try {
        const stat = await lstat(path);
        checks.push({ name, ok: stat.isDirectory() && !stat.isSymbolicLink(), detail: path });
      } catch {
        checks.push({ name, ok: false, detail: `Directory does not exist: ${path}` });
      }
    }
    if (loaded.config.scenario.file !== undefined) {
      const file = assertSafeRelativePath(loaded.config.scenario.file, 'scenario.file');
      try {
        const stat = await lstat(join(basePath, file));
        checks.push({
          name: 'trustedScenario',
          ok: stat.isFile() && !stat.isSymbolicLink(),
          detail: file,
        });
      } catch {
        checks.push({ name: 'trustedScenario', ok: false, detail: `Missing from base: ${file}` });
      }
    }
    if (backend === 'local')
      checks.push({
        name: 'localPolicy',
        ok:
          loaded.config.policy.allowUnsafeLocal &&
          (loaded.config.policy.backend === 'local' || hasOption(args, 'allow-unsafe-local')),
        detail:
          'Local needs policy.allowUnsafeLocal; overriding Docker also needs --allow-unsafe-local',
      });
    else {
      try {
        await exec('docker', ['version', '--format', '{{.Server.Version}}'], {
          timeout: 5_000,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        });
        checks.push({ name: 'docker', ok: true, detail: loaded.config.policy.dockerImage });
      } catch {
        checks.push({ name: 'docker', ok: false, detail: 'Docker daemon unavailable' });
      }
    }
    if (hasOption(args, 'fork'))
      checks.push({
        name: 'forkPolicy',
        ok: loaded.config.policy.allowFork,
        detail: 'policy.allowFork',
      });
    const ok = checks.every((check) => check.ok);
    if (hasOption(args, 'json'))
      process.stdout.write(
        `${JSON.stringify({ ok, backend, checks, diagnostics: loaded.diagnostics })}\n`,
      );
    else
      console.log(
        `${ok ? 'Preflight ready' : 'Preflight blocked'} (${backend})\n${checks.map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`).join('\n')}`,
      );
    return ok ? 0 : 2;
  } finally {
    await headRevision?.cleanup();
    await baseRevision?.cleanup();
  }
}
