import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { assertSafeRelativePath } from '@patchproof/config';
import { dockerLauncherEnvironment } from './docker.js';
import { LocalProcessBackend } from './process.js';
import { isAllowedEgressHost, isDigestPinnedImage } from './policy.js';
import type { BackendExecution, ExecutionBackend, ExecutionSpec } from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_CONTROL_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const PROXY_HOST = 'patchproof-egress';
const PROXY_PORT = 3128;
const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;
const PROXY_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

function generatedName(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function controlEnvironment(spec: ExecutionSpec): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dockerLauncherEnvironment(spec.launcherEnvironment)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

async function dockerControl(
  spec: ExecutionSpec,
  args: string[],
  timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
  respectSignal = true,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('docker', args, {
      windowsHide: true,
      shell: false,
      timeout: Math.max(1, timeoutMs),
      maxBuffer: 4 * 1024 * 1024,
      env: controlEnvironment(spec),
      ...(respectSignal && spec.signal !== undefined ? { signal: spec.signal } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(`docker ${args[0] ?? 'command'} failed: ${detail}`);
  }
}

async function provisionImage(spec: ExecutionSpec, image: string): Promise<void> {
  const timeoutMs = spec.provisioningTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  try {
    await dockerControl(spec, ['image', 'inspect', image], timeoutMs);
    return;
  } catch {
    await dockerControl(spec, ['pull', image], timeoutMs);
  }
}

function validateWorkspace(workspace: string): void {
  if (!isAbsolute(workspace) && !win32.isAbsolute(workspace))
    throw new Error('Docker workspace mount source must be absolute');
  if (workspace.includes('\u0000') || /[,\r\n]/u.test(workspace))
    throw new Error('Docker workspace mount source contains an unsafe delimiter');
}

function validateEnvironment(environment: Record<string, string>): void {
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      throw new Error(`Unsafe Docker environment name: ${key}`);
    if (value.includes('\u0000') || /[\r\n]/u.test(value))
      throw new Error(`Unsafe Docker environment value: ${key}`);
  }
}

function dockerWorkdir(cwd: string): string {
  if (cwd === '.') return '/workspace';
  return `/workspace/${assertSafeRelativePath(cwd, 'scenario.cwd')}`;
}

async function writeScenarioEnvironment(
  path: string,
  environment: Record<string, string>,
): Promise<void> {
  validateEnvironment(environment);
  const contents = Object.entries(environment)
    .filter(([key]) => key !== 'PATH' && !PROXY_ENV_KEYS.has(key))
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

/**
 * Squid performs both hostname and resolved-destination checks. Exact dstdomain
 * entries prevent wildcard expansion; dst denies private/link-local/loopback
 * address ranges after DNS resolution, which closes the DNS-rebinding/SSRF path.
 */
export function renderSquidAllowlist(hosts: readonly string[]): string {
  if (hosts.length === 0 || hosts.some((host) => !isAllowedEgressHost(host)))
    throw new Error('Egress allowlist contains an invalid public DNS host');
  const unique = [...new Set(hosts)].sort();
  return [
    `http_port ${PROXY_PORT}`,
    'visible_hostname patchproof-egress',
    'acl Safe_ports port 80 443',
    'acl SSL_ports port 443',
    'acl CONNECT method CONNECT',
    `acl allowed_domains dstdomain ${unique.join(' ')}`,
    'acl blocked_v4 dst 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4',
    'acl blocked_v6 dst ::/128 ::1/128 fc00::/7 fe80::/10 2001:db8::/32 ff00::/8',
    'http_access deny !Safe_ports',
    'http_access deny CONNECT !SSL_ports',
    'http_access deny blocked_v4',
    'http_access deny blocked_v6',
    'http_access allow allowed_domains',
    'http_access deny all',
    'cache deny all',
    'access_log none',
    'cache_log /dev/null',
    'cache_store_log none',
    'pid_filename none',
    'coredump_dir /tmp',
    '',
  ].join('\n');
}

function infrastructureExecution(
  startedAt: string,
  started: number,
  error: string,
): BackendExecution {
  return {
    exitCode: null,
    timedOut: false,
    startedAt,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutSizeBytes: 0,
    stderrSizeBytes: 0,
    error,
  };
}

function scenarioCommand(
  spec: ExecutionSpec,
  networkName: string,
  containerName: string,
  envFile: string,
): string[] {
  validateWorkspace(spec.workspace);
  return [
    'docker',
    'run',
    '--pull',
    'never',
    '--name',
    containerName,
    '--network',
    networkName,
    '--user',
    '65532:65532',
    ...(spec.policy.readOnlyRoot ? ['--read-only'] : []),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--cpus',
    String(spec.policy.cpuCount),
    '--memory',
    `${spec.policy.memoryMb}m`,
    '--memory-swap',
    `${spec.policy.memoryMb}m`,
    '--pids-limit',
    String(spec.policy.pids),
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--env-file',
    envFile,
    '--env',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--env',
    `HTTP_PROXY=${PROXY_URL}`,
    '--env',
    `HTTPS_PROXY=${PROXY_URL}`,
    '--env',
    `http_proxy=${PROXY_URL}`,
    '--env',
    `https_proxy=${PROXY_URL}`,
    '--env',
    'ALL_PROXY=',
    '--env',
    'all_proxy=',
    '--env',
    'NO_PROXY=',
    '--env',
    'no_proxy=',
    '--mount',
    `type=bind,src=${spec.workspace},dst=/workspace,readonly`,
    '--mount',
    'type=tmpfs,dst=/scratch,tmpfs-size=67108864',
    '--workdir',
    dockerWorkdir(spec.cwd),
    spec.policy.dockerImage,
    ...spec.command,
  ];
}

async function removeResource(spec: ExecutionSpec, args: string[]): Promise<string | undefined> {
  try {
    await dockerControl(spec, args, CLEANUP_TIMEOUT_MS, false);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Enforcing egress backend: the scenario joins only a fresh --internal Docker
 * network. A separately pinned Squid container is dual-homed to that internal
 * network and Docker's bridge; HTTP(S) proxy variables point the scenario at
 * it. Direct internet routing therefore does not exist for scenario code.
 */
export class AllowlistDockerBackend implements ExecutionBackend {
  public readonly kind = 'docker' as const;

  public constructor(
    private readonly processBackend: ExecutionBackend = new LocalProcessBackend({
      includeScenarioEnvironment: false,
    }),
  ) {}

  public async run(spec: ExecutionSpec): Promise<BackendExecution> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    if (spec.policy.network !== 'allowlist')
      return infrastructureExecution(
        startedAt,
        started,
        'Allowlist backend requires network: allowlist',
      );
    if (spec.egressProxyImage === undefined || !isDigestPinnedImage(spec.egressProxyImage))
      return infrastructureExecution(
        startedAt,
        started,
        'Allowlist backend requires a digest-pinned operator egress proxy image',
      );
    if (spec.command.length === 0)
      return infrastructureExecution(startedAt, started, 'Docker scenario command is empty');

    let stateRoot: string;
    try {
      stateRoot = await mkdtemp(join(tmpdir(), 'patchproof-egress-'));
    } catch (error) {
      return infrastructureExecution(
        startedAt,
        started,
        `Docker allowlist state setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const networkName = generatedName('pp-net');
    const proxyName = generatedName('pp-proxy');
    const scenarioName = generatedName(`pp-${spec.revision}`);
    const envFile = join(stateRoot, 'scenario.env');
    const squidConfig = join(stateRoot, 'squid.conf');
    let networkCreated = false;
    let proxyCreated = false;
    let result = infrastructureExecution(
      startedAt,
      started,
      'Docker allowlist execution did not start',
    );
    const cleanupErrors: string[] = [];

    try {
      if (spec.signal?.aborted) {
        result = {
          ...infrastructureExecution(startedAt, started, 'Execution cancelled'),
          cancelled: true,
        };
      } else {
        await writeScenarioEnvironment(envFile, spec.environment);
        await writeFile(squidConfig, renderSquidAllowlist(spec.policy.allowedHosts), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        await Promise.all([
          provisionImage(spec, spec.policy.dockerImage),
          provisionImage(spec, spec.egressProxyImage),
        ]);

        await dockerControl(spec, ['network', 'create', '--internal', networkName]);
        networkCreated = true;
        await dockerControl(spec, [
          'run',
          '--detach',
          '--pull',
          'never',
          '--name',
          proxyName,
          '--network',
          'bridge',
          '--read-only',
          '--security-opt',
          'no-new-privileges:true',
          '--pids-limit',
          '128',
          '--memory',
          '256m',
          '--memory-swap',
          '256m',
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,size=16m',
          '--tmpfs',
          '/run:rw,noexec,nosuid,size=8m',
          '--tmpfs',
          '/var/log/squid:rw,noexec,nosuid,size=16m',
          '--tmpfs',
          '/var/spool/squid:rw,noexec,nosuid,size=32m',
          '--mount',
          `type=bind,src=${squidConfig},dst=/etc/squid/squid.conf,readonly`,
          spec.egressProxyImage,
        ]);
        proxyCreated = true;
        await dockerControl(spec, [
          'network',
          'connect',
          '--alias',
          PROXY_HOST,
          networkName,
          proxyName,
        ]);
        const proxyState = await dockerControl(spec, [
          'inspect',
          '--format',
          '{{.State.Running}}',
          proxyName,
        ]);
        if (proxyState.stdout.trim() !== 'true')
          throw new Error('Egress proxy exited during startup');

        const command = scenarioCommand(spec, networkName, scenarioName, envFile);
        const scenario = await this.processBackend.run({
          ...spec,
          workspace: process.cwd(),
          cwd: '.',
          command,
          environment: {},
          launcherEnvironment: controlEnvironment(spec),
        });
        result = {
          ...scenario,
          startedAt,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
        };
      }
    } catch (error) {
      result = infrastructureExecution(
        startedAt,
        started,
        `Docker allowlist infrastructure failure: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (spec.signal?.aborted) result.cancelled = true;
    } finally {
      const scenarioCleanup = await removeResource(spec, ['container', 'rm', '-f', scenarioName]);
      if (scenarioCleanup !== undefined && !scenarioCleanup.includes('No such container'))
        cleanupErrors.push(scenarioCleanup);
      if (proxyCreated) {
        const proxyCleanup = await removeResource(spec, ['container', 'rm', '-f', proxyName]);
        if (proxyCleanup !== undefined) cleanupErrors.push(proxyCleanup);
      }
      if (networkCreated) {
        const networkCleanup = await removeResource(spec, ['network', 'rm', networkName]);
        if (networkCleanup !== undefined) cleanupErrors.push(networkCleanup);
      }
      await rm(stateRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    if (cleanupErrors.length > 0) {
      result.exitCode = null;
      result.error = `${result.error === undefined ? '' : `${result.error}; `}INFRA_ERROR: allowlist cleanup failed: ${cleanupErrors.join('; ')}`;
    }
    return {
      ...result,
      startedAt,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }
}
