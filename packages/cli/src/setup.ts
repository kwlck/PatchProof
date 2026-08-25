import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '@patchproof/config';
import { isPolicyDeniedRun, runTwoRevisions } from '@patchproof/runner';
import { verifyEvidenceBundle } from '@patchproof/core';
import { hasOption, option, type ParsedArgs } from './args.js';
import { writeEvidenceBundle } from './bundle.js';

const execFileAsync = promisify(execFile);
const SETUP_TIMEOUT_MS = 5_000;

export interface SetupCheck {
  key: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

function jsonOutput(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function probeNode(): SetupCheck {
  const major = Number.parseInt(process.version.slice(1), 10);
  return {
    key: 'node',
    ok: Number.isSafeInteger(major) && major >= 22,
    required: true,
    detail: `${process.version}; PatchProof requires Node.js >=22`,
  };
}

async function probeDocker(): Promise<SetupCheck> {
  try {
    const result = await execFileAsync(
      'docker',
      ['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'],
      { windowsHide: true, timeout: SETUP_TIMEOUT_MS, shell: false, maxBuffer: 64 * 1024 },
    );
    const versions = result.stdout.trim();
    const ok = versions.length > 0 && !versions.endsWith('/');
    return {
      key: 'docker',
      ok,
      required: false,
      detail: ok
        ? `Docker CLI/daemon reachable (${versions}); production runs use it`
        : 'Docker CLI returned no daemon version; production runs cannot start here',
    };
  } catch (error) {
    return {
      key: 'docker',
      ok: false,
      required: false,
      detail: `Docker unavailable; the demo still works via the development local backend (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function probeSqlite(): SetupCheck {
  let database: { exec(sql: string): unknown; close(): void } | undefined;
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require('node:sqlite') as {
      DatabaseSync?: new (filename: string) => { exec(sql: string): unknown; close(): void };
    };
    if (typeof sqlite.DatabaseSync !== 'function')
      throw new Error('DatabaseSync is not exported by node:sqlite');
    database = new sqlite.DatabaseSync(':memory:');
    database.exec('CREATE TABLE setup_probe (value INTEGER)');
    database.close();
    database = undefined;
    return {
      key: 'sqlite',
      ok: true,
      required: false,
      detail: 'node:sqlite opened and closed a probe database',
    };
  } catch (error) {
    return {
      key: 'sqlite',
      ok: false,
      required: false,
      detail: `node:sqlite unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch {
        // The primary diagnostic above already reports the failure.
      }
    }
  }
}

/** Environment probes used by both the interactive wizard and `--check`. */
export async function collectSetupChecks(): Promise<SetupCheck[]> {
  return [probeNode(), await probeDocker(), probeSqlite()];
}

export interface DockerInstallStep {
  command: string;
  args: string[];
}

export interface DockerInstallPlan {
  label: string;
  steps: DockerInstallStep[];
  postInstall: string;
}

export const DOCKER_MANUAL_URL = 'https://docs.docker.com/get-docker/';

/**
 * Official package manager commands only. The plan is offered interactively
 * and always requires explicit confirmation before anything runs.
 */
export function dockerInstallPlan(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): DockerInstallPlan | undefined {
  if (platform === 'win32') {
    return {
      label: 'winget (Docker Desktop)',
      steps: [
        {
          command: 'winget',
          args: [
            'install',
            '--id',
            'Docker.DockerDesktop',
            '-e',
            '--accept-source-agreements',
            '--accept-package-agreements',
          ],
        },
      ],
      postInstall:
        'Launch Docker Desktop once and accept its license. Windows may require signing out and back in before the daemon is reachable.',
    };
  }
  if (platform === 'darwin') {
    return {
      label: 'Homebrew (Docker Desktop)',
      steps: [
        { command: 'brew', args: ['install', '--cask', 'docker'] },
        { command: 'open', args: ['-a', 'Docker'] },
      ],
      postInstall:
        'Docker Desktop finishes setup on first launch; grant the requested permissions.',
    };
  }
  if (platform === 'linux') {
    if (exists('/usr/bin/apt-get')) {
      return {
        label: 'apt (Docker Engine)',
        steps: [
          { command: 'sudo', args: ['apt-get', 'update'] },
          { command: 'sudo', args: ['apt-get', 'install', '-y', 'docker.io'] },
        ],
        postInstall:
          'Enable and start the daemon: sudo systemctl enable --now docker. To run docker without sudo: sudo usermod -aG docker $USER, then sign out and back in.',
      };
    }
    if (exists('/usr/bin/dnf')) {
      return {
        label: 'dnf (moby engine)',
        steps: [{ command: 'sudo', args: ['dnf', 'install', '-y', 'moby-engine'] }],
        postInstall:
          'Enable and start the daemon: sudo systemctl enable --now docker. To run docker without sudo: sudo usermod -aG docker $USER, then sign out and back in.',
      };
    }
    if (exists('/usr/bin/pacman')) {
      return {
        label: 'pacman (Docker Engine)',
        steps: [{ command: 'sudo', args: ['pacman', '-S', '--noconfirm', 'docker'] }],
        postInstall:
          'Enable and start the daemon: sudo systemctl enable --now docker. To run docker without sudo: sudo usermod -aG docker $USER, then sign out and back in.',
      };
    }
  }
  return undefined;
}

function runInstallStep(step: DockerInstallStep): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn(step.command, step.args, {
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.on('error', () => resolveCode(1));
    child.on('close', (code) => resolveCode(code ?? 1));
  });
}

async function offerDockerInstall(checks: SetupCheck[]): Promise<SetupCheck[]> {
  const docker = checks.find((check) => check.key === 'docker');
  if (docker === undefined || docker.ok) return checks;
  const plan = dockerInstallPlan();
  if (plan === undefined) {
    console.log(`Install Docker manually: ${DOCKER_MANUAL_URL}`);
    return checks;
  }
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let confirmed = false;
  try {
    const answer = (
      await rl.question(`Docker is missing. Install it now via ${plan.label}? [y/N] `)
    )
      .trim()
      .toLowerCase();
    confirmed = answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
  if (!confirmed) {
    console.log(`Skipped. Install Docker manually: ${DOCKER_MANUAL_URL}`);
    return checks;
  }
  for (const step of plan.steps) {
    console.log(`> ${step.command} ${step.args.join(' ')}`);
    const code = await runInstallStep(step);
    if (code !== 0) {
      console.log(
        `The ${step.command} step exited with code ${code}. Finish the Docker install manually: ${DOCKER_MANUAL_URL}`,
      );
      return checks;
    }
  }
  console.log(plan.postInstall);
  const refreshed = await collectSetupChecks();
  return checks.map((check) => refreshed.find((item) => item.key === check.key) ?? check);
}

function renderChecks(checks: SetupCheck[]): string {
  return checks
    .map(
      (check) =>
        `${check.ok ? 'OK' : check.required ? 'FAIL' : 'WARN'} ${check.key}: ${check.detail}`,
    )
    .join('\n');
}

/**
 * Self-contained demo fixture. The base revision crashes while parsing the old
 * token, the head revision parses the fixed token, so the trusted scenario
 * demonstrates the exact fail-to-pass transition PatchProof certifies.
 */
export function buildDemoFiles(): Record<string, string> {
  const scenario = [
    'const revision = process.env.PATCHPROOF_REVISION;',
    "if (revision !== 'head') {",
    "  console.error('EXPECTED_BUG malformed token crashes the parser');",
    '  process.exit(1);',
    '}',
    "console.log('parser accepted the fixed token');",
    '',
  ].join('\n');
  const config = [
    'version: 1',
    'name: PatchProof demo',
    'scenario:',
    '  id: parser-demo',
    '  name: Parser rejects the malformed token on base and accepts it on head',
    '  command: [node, scenario.mjs]',
    '  cwd: .',
    '  file: scenario.mjs',
    '  expectedFailure:',
    '    exitCode: 1',
    '    reasonPattern: EXPECTED_BUG',
    'policy:',
    '  # Development-only backend for hosts without Docker.',
    '  backend: local',
    '  allowUnsafeLocal: true',
    '  network: none',
    '  timeoutMs: 30000',
    '  outputBytes: 8192',
    'redaction:',
    '  secrets: []',
    '',
  ].join('\n');
  return {
    'base/scenario.mjs': scenario,
    'head/scenario.mjs': scenario,
    '.patchproof.yml': config,
  };
}

const NEXT_STEPS = [
  'patchproof validate <path/to/.patchproof.yml>',
  'patchproof run <config> --base <dir> --head <dir> --backend docker   (production; needs Docker)',
  'patchproof verify <evidence bundle>',
  'patchproof replay <evidence bundle> --yes --base <dir> --head <dir>',
];

async function runDemo(demoDir: string): Promise<{ exitCode: number; bundlePath?: string }> {
  const files = buildDemoFiles();
  for (const [relativePath, content] of Object.entries(files)) {
    const target = resolve(demoDir, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  const configPath = resolve(demoDir, '.patchproof.yml');
  const result = await loadConfig(configPath);
  const run = await runTwoRevisions({
    config: result.config,
    basePath: resolve(demoDir, 'base'),
    headPath: resolve(demoDir, 'head'),
    backendOverride: 'local',
    allowUnsafeLocal: true,
    trustedConfig: true,
  });
  if (isPolicyDeniedRun(run)) throw new Error(`Demo was denied by policy: ${run.reason}`);
  const outputRoot = resolve(demoDir, 'evidence');
  const built = await writeEvidenceBundle({
    outputPath: outputRoot,
    configResult: result,
    config: result.config,
    run,
    backend: 'local',
    fork: false,
  });
  const verification = await verifyEvidenceBundle(built.bundlePath);
  if (!verification.valid)
    throw new Error(`Demo evidence failed verification: ${verification.errors.join('; ')}`);
  return { exitCode: 0, bundlePath: built.bundlePath };
}

/**
 * One-command onboarding: report the environment, then optionally prove the
 * whole fail-to-pass pipeline with a self-contained demo that needs nothing
 * but this executable.
 */
export async function runSetup(args: ParsedArgs): Promise<number> {
  const json = hasOption(args, 'json');
  const checks = await collectSetupChecks();
  const requiredOk = checks.filter((check) => check.required).every((check) => check.ok);
  if (!requiredOk) {
    if (json) jsonOutput({ ok: false, stage: 'environment', checks });
    else
      console.log(
        `${renderChecks(checks)}\n\nInstall Node.js 22 or newer, then re-run patchproof setup.`,
      );
    return 2;
  }

  const demoDirOption = option(args, 'demo-dir');
  const wantsDemo = hasOption(args, 'demo');
  let interactiveDemo = false;
  let currentChecks = checks;
  if (!wantsDemo && !hasOption(args, 'check') && !json && process.stdin.isTTY) {
    currentChecks = await offerDockerInstall(checks);
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('Run the 30-second demo now? [Y/n] ')).trim().toLowerCase();
      if (answer === '' || answer === 'y' || answer === 'yes') interactiveDemo = true;
    } finally {
      rl.close();
    }
  }
  const dockerHint = currentChecks.some((check) => check.key === 'docker' && !check.ok)
    ? `Docker install: ${DOCKER_MANUAL_URL}`
    : undefined;
  const shouldRunDemo = wantsDemo || (!hasOption(args, 'check') && interactiveDemo);

  if (!shouldRunDemo) {
    if (json)
      jsonOutput({
        ok: true,
        mode: 'check',
        checks: currentChecks,
        ...(dockerHint === undefined ? {} : { dockerInstall: dockerHint }),
      });
    else
      console.log(
        `${renderChecks(currentChecks)}\n\nEnvironment is ready.${dockerHint === undefined ? '' : `\n${dockerHint}`}\nNext: patchproof setup --demo   (proves the full pipeline in ~30 seconds)\n     ${NEXT_STEPS.join('\n     ')}`,
      );
    return 0;
  }

  const demoDir = resolve(typeof demoDirOption === 'string' ? demoDirOption : 'patchproof-demo');
  await rm(demoDir, { recursive: true, force: true });
  if (json) {
    try {
      const demo = await runDemo(demoDir);
      jsonOutput({
        ok: true,
        mode: 'demo',
        checks: currentChecks,
        demoDir,
        ...(demo.bundlePath === undefined ? {} : { bundlePath: demo.bundlePath }),
        outcome: 'PASS',
      });
      return demo.exitCode;
    } catch (error) {
      jsonOutput({
        ok: false,
        mode: 'demo',
        checks: currentChecks,
        demoDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return 2;
    }
  }
  console.log(
    `${renderChecks(currentChecks)}\n\nRunning the self-contained demo (development local backend)...`,
  );
  console.log(`  demo directory: ${demoDir}`);
  const demo = await runDemo(demoDir);
  console.log(
    `\nPASS - the trusted scenario failed on base and passed on head.\nEvidence: ${demo.bundlePath}\n\nNext steps:\n  ${NEXT_STEPS.join('\n  ')}`,
  );
  return demo.exitCode;
}
