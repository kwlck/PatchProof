import { LocalProcessBackend } from './process.js';
import { isAbsolute, win32 } from 'node:path';
import type { BackendExecution, ExecutionBackend, ExecutionSpec } from './types.js';

function assertSafeBindSource(workspace: string): void {
  if (!isAbsolute(workspace) && !win32.isAbsolute(workspace))
    throw new Error('Docker workspace mount source must be an absolute path');
  if (workspace.includes('\u0000') || /[,\r\n]/u.test(workspace))
    throw new Error('Docker workspace mount source contains an unsafe mount delimiter');
}

export function buildDockerCommand(spec: ExecutionSpec): string[] {
  assertSafeBindSource(spec.workspace);
  if (spec.policy.network === 'allowlist')
    throw new Error(
      'Docker host allowlists require an operator-provided network adapter; refusing unenforced egress',
    );
  const scenarioEnvironment = Object.entries(spec.environment)
    .filter(([key]) => key !== 'PATH')
    .flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const args = [
    'run',
    '--rm',
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
    '--memory',
    `${spec.policy.memoryMb}m`,
    '--pids-limit',
    String(spec.policy.pids),
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--env',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...scenarioEnvironment,
    '--mount',
    `type=bind,src=${spec.workspace},dst=/workspace,readonly`,
    '--mount',
    'type=tmpfs,dst=/scratch,tmpfs-size=67108864',
    '--workdir',
    '/workspace',
    spec.policy.dockerImage,
    ...spec.command,
  ];
  return ['docker', ...args];
}

/** Docker is the production boundary. The local backend is never selected here. */
export class DockerBackend implements ExecutionBackend {
  public readonly kind = 'docker' as const;

  public constructor(
    private readonly processBackend: ExecutionBackend = new LocalProcessBackend(),
  ) {}

  public async run(spec: ExecutionSpec): Promise<BackendExecution> {
    if (spec.policy.network === 'allowlist') {
      return {
        exitCode: null,
        timedOut: false,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutSizeBytes: 0,
        stderrSizeBytes: 0,
        error:
          'Docker host allowlists require an operator-provided network adapter; refusing unenforced egress',
      };
    }
    return this.processBackend.run({
      ...spec,
      workspace: process.cwd(),
      cwd: '.',
      launcherEnvironment: {
        PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      },
      command: buildDockerCommand(spec),
    });
  }
}
