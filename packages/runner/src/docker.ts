import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSafeRelativePath } from '@patchproof/config';
import { LocalProcessBackend } from './process.js';
import type { BackendExecution, ExecutionBackend, ExecutionSpec } from './types.js';

export const DEFAULT_DOCKER_PROVISIONING_TIMEOUT_MS = 120_000;
const DOCKER_CLEANUP_TIMEOUT_MS = 5_000;
const DOCKER_CONTROL_OUTPUT_BYTES = 16_384;
// LocalProcessBackend force-kills a launcher at most 750 ms after requesting
// termination. Docker CLI can keep waiting when the container ignores
// SIGTERM, so the hard deadline must allow that bounded kill to settle.
const DOCKER_LAUNCHER_GRACE_MS = 1_000;

export interface DockerCommandOptions {
  containerName?: string;
  cidFile?: string;
  /**
   * Absolute path to a 0600 env file holding scenario variables. When
   * supplied, scenario values travel through `--env-file` instead of
   * per-variable `--env` arguments, keeping them out of host process argv.
   */
  scenarioEnvFile?: string;
}

export interface DockerBackendOptions {
  provisioningTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

function assertSafeBindSource(workspace: string): void {
  if (!isAbsolute(workspace) && !win32.isAbsolute(workspace))
    throw new Error('Docker workspace mount source must be an absolute path');
  if (workspace.includes('\u0000') || /[,\r\n]/u.test(workspace))
    throw new Error('Docker workspace mount source contains an unsafe mount delimiter');
}

function assertContainerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/u.test(name))
    throw new Error('Docker container name is invalid');
}

function assertCidFile(file: string): void {
  if (
    (!isAbsolute(file) && !win32.isAbsolute(file)) ||
    file.includes('\u0000') ||
    /[\r\n]/u.test(file)
  )
    throw new Error('Docker cidfile must be an absolute path without NUL bytes');
}

function assertScenarioEnvFile(file: string): void {
  if (
    (!isAbsolute(file) && !win32.isAbsolute(file)) ||
    file.includes('\u0000') ||
    /[\r\n]/u.test(file)
  )
    throw new Error('Docker scenario env file must be an absolute path without NUL bytes');
}

/**
 * Scenario values are validated (no NUL, CR, or LF) before this point, so
 * each entry is exactly one `KEY=VALUE` line for the Docker env-file parser.
 */
async function writeScenarioEnvFile(
  file: string,
  environment: Record<string, string>,
): Promise<void> {
  const contents = Object.entries(environment)
    .filter(([key]) => key !== 'PATH')
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  await writeFile(file, contents, { encoding: 'utf8', mode: 0o600 });
}

function dockerWorkdir(cwd: string): string {
  if (cwd === '.') return '/workspace';
  const safe = assertSafeRelativePath(cwd, 'scenario.cwd');
  return `/workspace/${safe}`;
}

function validateEnvironment(environment: Record<string, string>): void {
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key === '__proto__')
      throw new Error(`Unsafe Docker environment name: ${key}`);
    if (value.includes('\u0000') || /[\r\n]/u.test(value))
      throw new Error(`Unsafe Docker environment value: ${key}`);
  }
}

/** Only launcher values needed by the host Docker CLI are retained. */
export function dockerLauncherEnvironment(
  environment: Record<string, string> | undefined,
): Record<string, string> {
  const source = environment ?? {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
  };
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => key === 'PATH' || key === 'SystemRoot'),
  );
}

function generatedContainerName(revision: ExecutionSpec['revision']): string {
  return `patchproof-${revision}-${randomUUID().replaceAll('-', '')}`;
}

export function buildDockerCommand(
  spec: ExecutionSpec,
  options: DockerCommandOptions = {},
): string[] {
  assertSafeBindSource(spec.workspace);
  if (spec.policy.network === 'allowlist')
    throw new Error(
      'Docker host allowlists require an operator-provided network adapter; refusing unenforced egress',
    );
  if (spec.command.length === 0 || spec.command[0] === undefined)
    throw new Error('Docker scenario command is empty');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/u.test(spec.policy.dockerImage))
    throw new Error('Docker image must be a bounded image reference and must not begin with -');
  validateEnvironment(spec.environment);
  const scenarioEnvironment = Object.entries(spec.environment)
    // PATH is supplied as a fixed container value. A repository must not
    // smuggle a host executable search path into the container.
    .filter(([key]) => key !== 'PATH');
  if (options.scenarioEnvFile === undefined && scenarioEnvironment.length > 0)
    throw new Error(
      'Docker scenario environment requires a scenarioEnvFile so values never enter host argv',
    );
  if (options.scenarioEnvFile !== undefined) assertScenarioEnvFile(options.scenarioEnvFile);
  const containerName = options.containerName ?? generatedContainerName(spec.revision);
  assertContainerName(containerName);
  if (options.cidFile !== undefined) assertCidFile(options.cidFile);
  const scenarioEnvironmentArgs =
    options.scenarioEnvFile === undefined
      ? []
      : // Values live in a private state file rather than argv, where they
        // would be readable host-wide through /proc or process listings.
        ['--env-file', options.scenarioEnvFile];
  const args = [
    'run',
    '--pull',
    'never',
    '--name',
    containerName,
    ...(options.cidFile === undefined ? [] : ['--cidfile', options.cidFile]),
    '--network',
    'none',
    '--user',
    '65532:65532',
    ...(spec.policy.readOnlyRoot ? ['--read-only'] : []),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--cpus',
    String(spec.policy.cpuCount),
    // memory-swap equal to memory disables swap so the ceiling is exact.
    '--memory',
    `${spec.policy.memoryMb}m`,
    '--memory-swap',
    `${spec.policy.memoryMb}m`,
    '--pids-limit',
    String(spec.policy.pids),
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--env',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...scenarioEnvironmentArgs,
    '--mount',
    `type=bind,src=${spec.workspace},dst=/workspace,readonly`,
    '--mount',
    'type=tmpfs,dst=/scratch,tmpfs-size=67108864',
    '--workdir',
    dockerWorkdir(spec.cwd),
    spec.policy.dockerImage,
    ...spec.command,
  ];
  return ['docker', ...args];
}

function launcherSpec(
  spec: ExecutionSpec,
  command: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): ExecutionSpec {
  const { signal: _ignoredSignal, ...withoutSignal } = spec;
  void _ignoredSignal;
  const launcherEnvironment = dockerLauncherEnvironment(spec.launcherEnvironment);
  return {
    ...withoutSignal,
    workspace: process.cwd(),
    cwd: '.',
    command,
    // Scenario values are already explicit --env arguments in command. They
    // never enter the host process environment used to launch Docker.
    environment: {},
    launcherEnvironment,
    timeoutMs,
    outputBytes: DOCKER_CONTROL_OUTPUT_BYTES,
    ...(signal === undefined ? {} : { signal }),
  };
}

function controlDetail(result: BackendExecution): string {
  const detail = (result.error ?? result.stderr.trim()) || result.stdout.trim();
  return detail.length > 0 ? `: ${detail.slice(0, 2_000)}` : '';
}

function hardRun(
  processBackend: ExecutionBackend,
  spec: ExecutionSpec,
  timeoutMs: number,
  label: string,
): Promise<BackendExecution> {
  const bounded = Math.max(1, timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} exceeded hard deadline of ${bounded} ms`));
    }, bounded);
    Promise.resolve()
      .then(() => processBackend.run(spec))
      .then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
}

function infrastructureExecution(
  startedAt: string,
  started: number,
  error: string,
  output: Partial<BackendExecution> = {},
): BackendExecution {
  return {
    exitCode: null,
    timedOut: false,
    startedAt,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    stdout: output.stdout ?? '',
    stderr: output.stderr ?? '',
    stdoutTruncated: output.stdoutTruncated ?? false,
    stderrTruncated: output.stderrTruncated ?? false,
    stdoutSizeBytes: output.stdoutSizeBytes ?? 0,
    stderrSizeBytes: output.stderrSizeBytes ?? 0,
    ...(output.cancelled === true ? { cancelled: true } : {}),
    ...(output.outputLimitHit === true ? { outputLimitHit: true } : {}),
    error,
  };
}

function hasControlFailure(result: BackendExecution): boolean {
  return result.exitCode !== 0 || result.error !== undefined || result.timedOut;
}

async function readContainerId(cidFile: string): Promise<string | undefined> {
  try {
    const value = (await readFile(cidFile, 'utf8')).trim();
    return /^[0-9a-f]{12,64}$/iu.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

interface CleanupReport {
  verified: boolean;
  detail?: string;
}

/**
 * Stop, kill, remove, and then verify by exact name. Every control operation
 * is bounded and errors are retained for an INFRA_ERROR result.
 */
async function cleanupContainer(
  processBackend: ExecutionBackend,
  spec: ExecutionSpec,
  name: string,
  timeoutMs: number,
): Promise<CleanupReport> {
  const deadline = performance.now() + timeoutMs;
  const control = async (command: string[]): Promise<BackendExecution> => {
    const remaining = Math.max(1, Math.min(timeoutMs, Math.round(deadline - performance.now())));
    return hardRun(
      processBackend,
      launcherSpec(spec, command, remaining),
      remaining,
      `Docker cleanup control ${command.slice(1).join(' ')}`,
    );
  };
  let firstFailure: string | undefined;
  for (const command of [
    ['docker', 'container', 'stop', '--time', '2', name],
    ['docker', 'container', 'kill', name],
    ['docker', 'container', 'rm', '-f', name],
  ]) {
    try {
      const result = await control(command);
      // `stop` and `kill` naturally return non-zero when a container has
      // already exited. The final exact-name verification is authoritative.
      if (result.timedOut && firstFailure === undefined)
        firstFailure = `Docker cleanup command timed out${controlDetail(result)}`;
    } catch (error) {
      if (firstFailure === undefined)
        firstFailure = `Docker cleanup command failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  let verify: BackendExecution;
  try {
    verify = await control([
      'docker',
      'container',
      'ls',
      '--all',
      '--filter',
      `name=^/${name}$`,
      '--format',
      '{{.Names}}',
    ]);
  } catch (error) {
    return {
      verified: false,
      detail:
        firstFailure ??
        `Docker cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (hasControlFailure(verify))
    return {
      verified: false,
      detail: firstFailure ?? `Docker cleanup verification failed${controlDetail(verify)}`,
    };
  const residual = verify.stdout
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter((item) => item === name);
  return residual.length === 0 && firstFailure === undefined
    ? { verified: true }
    : residual.length === 0
      ? {
          verified: false,
          detail: firstFailure ?? 'Docker cleanup control command failed',
        }
      : {
          verified: false,
          detail: `${firstFailure === undefined ? '' : `${firstFailure}; `}Docker container ${name} remained after forced removal`,
        };
}

/** Docker is the production boundary. The local backend is never selected here. */
export class DockerBackend implements ExecutionBackend {
  public readonly kind = 'docker' as const;

  private readonly provisioningTimeoutMs: number;

  private readonly cleanupTimeoutMs: number;

  public constructor(
    private readonly processBackend: ExecutionBackend = new LocalProcessBackend({
      includeScenarioEnvironment: false,
    }),
    options: DockerBackendOptions = {},
  ) {
    this.provisioningTimeoutMs = Math.max(
      1,
      options.provisioningTimeoutMs ?? DEFAULT_DOCKER_PROVISIONING_TIMEOUT_MS,
    );
    this.cleanupTimeoutMs = Math.max(1, options.cleanupTimeoutMs ?? DOCKER_CLEANUP_TIMEOUT_MS);
  }

  private async provisionImage(
    spec: ExecutionSpec,
    launcherEnvironment: Record<string, string>,
  ): Promise<string | undefined> {
    const provisioningTimeout = spec.provisioningTimeoutMs ?? this.provisioningTimeoutMs;
    const deadline = performance.now() + provisioningTimeout;
    const controlSpec = (command: string[]): ExecutionSpec => {
      const base = launcherSpec(
        spec,
        command,
        Math.max(1, Math.min(provisioningTimeout, Math.round(deadline - performance.now()))),
        spec.signal,
      );
      return { ...base, launcherEnvironment };
    };
    let inspect: BackendExecution;
    try {
      const command = ['docker', 'image', 'inspect', spec.policy.dockerImage];
      const remaining = Math.max(
        1,
        Math.min(provisioningTimeout, Math.round(deadline - performance.now())),
      );
      inspect = await hardRun(
        this.processBackend,
        controlSpec(command),
        remaining,
        `Docker provisioning control ${command.slice(1).join(' ')}`,
      );
    } catch (error) {
      return `Docker image inspect failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (inspect.signal !== undefined || inspect.timedOut)
      return `Docker image inspect exceeded the ${provisioningTimeout} ms provisioning timeout${controlDetail(inspect)}`;
    if (inspect.exitCode === null || inspect.error !== undefined)
      return `Docker image inspect failed${controlDetail(inspect)}`;
    if (inspect.exitCode === 0 && inspect.error === undefined) return undefined;
    let pull: BackendExecution;
    try {
      const command = ['docker', 'pull', spec.policy.dockerImage];
      const remaining = Math.max(
        1,
        Math.min(provisioningTimeout, Math.round(deadline - performance.now())),
      );
      pull = await hardRun(
        this.processBackend,
        controlSpec(command),
        remaining,
        `Docker provisioning control ${command.slice(1).join(' ')}`,
      );
    } catch (error) {
      return `Docker image pull failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (pull.timedOut)
      return `Docker image pull exceeded the ${provisioningTimeout} ms provisioning timeout${controlDetail(pull)}`;
    if (pull.exitCode !== 0 || pull.error !== undefined)
      return `Docker image pull failed${controlDetail(pull)}`;
    return undefined;
  }

  public async run(spec: ExecutionSpec): Promise<BackendExecution> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    if (spec.policy.network === 'allowlist')
      return infrastructureExecution(
        startedAt,
        started,
        'Docker host allowlists require an operator-provided network adapter; refusing unenforced egress',
      );
    const launcherEnvironment = dockerLauncherEnvironment(spec.launcherEnvironment);
    let stateRoot: string | undefined;
    let name: string | undefined;
    let cidFile: string | undefined;
    try {
      if (spec.signal?.aborted)
        return infrastructureExecution(startedAt, started, 'Execution cancelled', {
          cancelled: true,
        });
      stateRoot = await mkdtemp(join(tmpdir(), 'patchproof-docker-state-'));
      name = generatedContainerName(spec.revision);
      assertContainerName(name);
      cidFile = join(stateRoot, 'container.cid');
      validateEnvironment(spec.environment);
      const scenarioEnvFile = join(stateRoot, 'scenario.env');
      await writeScenarioEnvFile(scenarioEnvFile, spec.environment);
      const provisioningError = await this.provisionImage(spec, launcherEnvironment);
      if (provisioningError !== undefined)
        return infrastructureExecution(
          startedAt,
          started,
          provisioningError,
          spec.signal?.aborted ? { cancelled: true } : {},
        );
      const command = buildDockerCommand(spec, {
        containerName: name,
        cidFile,
        scenarioEnvFile,
      });
      let runResult: BackendExecution;
      try {
        runResult = await hardRun(
          this.processBackend,
          {
            ...spec,
            workspace: process.cwd(),
            cwd: '.',
            command,
            environment: {},
            launcherEnvironment,
          },
          Math.max(1, spec.timeoutMs + DOCKER_LAUNCHER_GRACE_MS),
          'Docker scenario launcher',
        );
      } catch (error) {
        runResult = infrastructureExecution(
          startedAt,
          started,
          `Docker scenario launcher failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const containerId = await readContainerId(cidFile);
      const reservedDockerFailure =
        runResult.exitCode === 125 && containerId === undefined && !runResult.timedOut;
      const startupFailure =
        !runResult.timedOut && containerId === undefined && runResult.error === undefined;
      if (reservedDockerFailure || startupFailure) {
        runResult = {
          ...runResult,
          exitCode: null,
          error: `Docker scenario control failure${controlDetail(runResult)}`,
        };
      }
      const cleanup = await cleanupContainer(
        this.processBackend,
        spec,
        name,
        this.cleanupTimeoutMs,
      );
      if (!cleanup.verified) {
        runResult = {
          ...runResult,
          exitCode: null,
          error: `${runResult.error === undefined ? '' : `${runResult.error}; `}INFRA_ERROR: ${cleanup.detail ?? 'Docker container cleanup could not be verified'}`,
        };
      }
      return {
        ...runResult,
        startedAt,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      };
    } catch (error) {
      return infrastructureExecution(
        startedAt,
        started,
        `Docker runner infrastructure failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (stateRoot !== undefined) {
        try {
          await rm(stateRoot, { recursive: true, force: true });
        } catch {
          // The container verification above is authoritative. A transient
          // host temp-state cleanup error must not mask the execution result.
        }
      }
    }
  }
}
