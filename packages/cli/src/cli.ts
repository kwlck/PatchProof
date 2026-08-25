import { existsSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyOutcomeGuarded,
  PatternDeadlineExceededError,
  PatternWorkerCrashedError,
  verifyEvidenceBundle,
  type EvidenceBundle,
} from '@patchproof/core';
import {
  ConfigValidationError,
  formatDiagnostics,
  loadConfig,
  loadTrustedConfig,
  type PatchProofConfig,
} from '@patchproof/config';
import { isPolicyDeniedRun, runTwoRevisions, sourceIdentity } from '@patchproof/runner';
import { outcomeExitCode, renderMarkdownReport, renderTerminalReport } from '@patchproof/report';
import { hasOption, option, parseArgs, type ParsedArgs } from './args.js';
import { writeEvidenceBundle } from './bundle.js';
import { runSetup } from './setup.js';

const execFileAsync = promisify(execFile);
const DOCTOR_TIMEOUT_MS = 5_000;

interface DoctorCheck {
  ok: boolean;
  required: boolean;
  detail: string;
}

const HELP = `PatchProof - replayable evidence for pull-request bug fixes

Quick start: patchproof setup --demo proves the full pipeline in about 30 seconds.

Usage:
  patchproof init [directory]
  patchproof validate <.patchproof.yml> [--json]
  patchproof run <.patchproof.yml> --base <dir> --head <dir> [options]
  patchproof verify <patchproof.evidence.json> [--json]
  patchproof replay <patchproof.evidence.json> [--yes] [--backend docker|local] [--base <dir> --head <dir>]
  patchproof doctor [--json]
  patchproof setup [--check | --demo] [--demo-dir <dir>] [--json]

Setup options:
  --check                   Report the environment without running the demo
  --demo                    Run the self-contained fail-to-pass demo (~30 seconds)
  --demo-dir <dir>          Demo workspace location (default: ./patchproof-demo)

Run options:
  --output <dir|file>       Evidence output location (default: ./work/patchproof-run)
  --backend <docker|local>  Override backend; local requires --allow-unsafe-local
  --allow-unsafe-local      Explicitly allow the development local-process backend
  --fork                    Apply fork policy and report POLICY_DENIED when disallowed
  --trusted-base <dir>      Trusted base checkout containing the executable config/scenario
  --json                    Emit machine-readable result

Exit codes: 0 PASS/valid, 1 FAIL, 2 inconclusive/invalid, 3 policy denied, 4 infrastructure error.
Docker is the production default. The local backend is unsafe and never implied by configuration.
`;

function jsonOutput(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printError(error: unknown, json: boolean): number {
  const message = error instanceof Error ? error.message : String(error);
  if (json) jsonOutput({ ok: false, error: message });
  else console.error(`PatchProof error: ${message}`);
  // Host-side infrastructure failures are tagged by the runner so CI can
  // distinguish them from inconclusive input (documented exit code 4).
  return message.startsWith('INFRA_ERROR:') ? 4 : 2;
}

async function initCommand(args: ParsedArgs): Promise<number> {
  const root = resolve(args.positional[0] ?? process.cwd());
  await mkdir(root, { recursive: true });
  const target = resolve(root, '.patchproof.yml');
  if (existsSync(target)) throw new Error(`${target} already exists; refusing to overwrite`);
  await writeFile(
    target,
    `version: 1\nname: Reproduction scenario\nscenario:\n  id: bug-reproduction\n  name: Reproduce the claimed bug\n  command: [node, scenario.mjs]\n  cwd: .\n  file: scenario.mjs\n  expectedFailure:\n    exitCode: 1\npolicy:\n  backend: docker\n  network: none\nredaction:\n  secrets: []\n`,
    'utf8',
  );
  console.log(`Created ${target}`);
  console.log('Next steps:');
  console.log('  1. Create the scenario file the config runs (scenario.mjs next to the config).');
  console.log('     It must reproduce the claimed bug: on the unfixed base it exits with code 1.');
  console.log(`  2. patchproof validate ${args.positional[0] ?? '.patchproof.yml'}`);
  console.log(
    `  3. patchproof run ${args.positional[0] ?? '.patchproof.yml'} --base <base-dir> --head <head-dir>`,
  );
  return 0;
}

async function validateCommand(args: ParsedArgs): Promise<number> {
  const configPath = args.positional[0];
  if (configPath === undefined) throw new Error('validate requires a .patchproof.yml path');
  try {
    const result = await loadConfig(configPath);
    if (hasOption(args, 'json'))
      jsonOutput({
        ok: true,
        version: result.config.version,
        sha256: result.sha256,
        diagnostics: result.diagnostics,
      });
    else {
      console.log(`Valid PatchProof configuration (version ${result.config.version})`);
      if (result.diagnostics.length > 0) console.log(formatDiagnostics(result.diagnostics));
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      if (hasOption(args, 'json')) jsonOutput({ ok: false, diagnostics: error.diagnostics });
      else console.error(formatDiagnostics(error.diagnostics));
      return 2;
    }
    throw error;
  }
}

async function runCommand(args: ParsedArgs): Promise<number> {
  const configPath = args.positional[0];
  const base = option(args, 'base');
  const head = option(args, 'head');
  if (configPath === undefined || typeof base !== 'string' || typeof head !== 'string')
    throw new Error('run requires config, --base <dir>, and --head <dir>');
  const trustedBase = option(args, 'trusted-base');
  if (hasOption(args, 'fork') && typeof trustedBase !== 'string')
    throw new Error(
      'Fork runs require --trusted-base <dir>; head configuration is never trusted by default',
    );
  const result =
    typeof trustedBase === 'string'
      ? await loadTrustedConfig(configPath, trustedBase)
      : await loadConfig(configPath);
  const backendValue = option(args, 'backend');
  if (backendValue !== undefined && backendValue !== 'docker' && backendValue !== 'local')
    throw new Error('--backend must be docker or local');
  const backend =
    backendValue === 'docker' || backendValue === 'local'
      ? backendValue
      : result.config.policy.backend;
  const run = await runTwoRevisions({
    config: result.config,
    basePath: base,
    headPath: head,
    backendOverride: backend,
    allowUnsafeLocal: hasOption(args, 'allow-unsafe-local'),
    fork: hasOption(args, 'fork'),
    trustedConfig: true,
  });
  const deniedSources = isPolicyDeniedRun(run)
    ? await Promise.all([sourceIdentity(base, 'base'), sourceIdentity(head, 'head')])
    : undefined;
  const output = option(args, 'output');
  const built = await writeEvidenceBundle({
    outputPath: typeof output === 'string' ? output : resolve('work', 'patchproof-run'),
    configResult: result,
    config: result.config,
    run,
    backend,
    fork: hasOption(args, 'fork'),
    ...(deniedSources === undefined
      ? {}
      : {
          baseSource: { revision: 'base' as const, ...deniedSources[0], location: base },
          headSource: { revision: 'head' as const, ...deniedSources[1], location: head },
        }),
  });
  if (hasOption(args, 'json'))
    jsonOutput({
      ok: true,
      outcome: built.bundle.outcome,
      bundlePath: built.bundlePath,
      integrity: built.bundle.integrity.canonicalSha256,
      report: renderMarkdownReport(built.bundle),
    });
  else console.log(`${renderTerminalReport(built.bundle)}\n\n${built.bundlePath}`);
  return outcomeExitCode(built.bundle.outcome);
}

async function verifyCommand(args: ParsedArgs): Promise<number> {
  const bundlePath = args.positional[0];
  if (bundlePath === undefined) throw new Error('verify requires an evidence bundle path');
  const result = await verifyEvidenceBundle(bundlePath);
  if (hasOption(args, 'json')) jsonOutput(result);
  else
    console.log(
      `${result.valid ? 'VALID' : 'INVALID'} evidence bundle\n${result.errors.map((error) => `- ${error}`).join('\n')}`,
    );
  return result.valid ? 0 : 2;
}

function configFromEvidence(bundle: EvidenceBundle): PatchProofConfig {
  const environment = Object.fromEntries(
    Object.entries(bundle.executions.base.environment).filter(
      ([key]) => key !== 'CI' && key !== 'PATCHPROOF_REVISION',
    ),
  );
  return {
    version: 1,
    name: bundle.scenario.name,
    scenario: {
      id: bundle.scenario.id,
      name: bundle.scenario.name,
      command: [...bundle.scenario.command],
      cwd: bundle.scenario.cwd,
      ...(bundle.scenario.file === undefined ? {} : { file: bundle.scenario.file }),
      expectedFailure: { ...bundle.scenario.expectedFailure },
      environment,
    },
    policy: {
      backend: bundle.policy.backend,
      allowUnsafeLocal: bundle.policy.unsafeLocalProcess,
      allowFork: bundle.policy.fork,
      network: bundle.policy.network,
      allowedHosts: [...bundle.policy.allowedHosts],
      timeoutMs: bundle.policy.limits.timeoutMs,
      outputBytes: bundle.policy.limits.outputBytes,
      memoryMb: bundle.policy.limits.memoryMb,
      cpuCount: bundle.policy.limits.cpuCount,
      pids: bundle.policy.limits.pids,
      dockerImage: bundle.executions.base.toolchain.containerImage ?? 'node:24-bookworm-slim',
      readOnlyRoot: true,
    },
    redaction: { secrets: [] },
  };
}

function doctorCheck(ok: boolean, required: boolean, detail: string): DoctorCheck {
  return { ok, required, detail };
}

function nodeMajorVersion(): number {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  return Number.isSafeInteger(major) ? major : 0;
}

interface PnpmInvocation {
  executable: string;
  args: string[];
  label: string;
}

async function pnpmInvocations(): Promise<PnpmInvocation[]> {
  if (process.platform !== 'win32')
    return [{ executable: 'pnpm', args: ['--version'], label: 'pnpm' }];
  const paths: string[] = [];
  try {
    const located = await execFileAsync('where.exe', ['pnpm'], {
      windowsHide: true,
      timeout: DOCTOR_TIMEOUT_MS,
      shell: false,
      maxBuffer: 64 * 1024,
    });
    for (const path of located.stdout.split(/\r?\n/u).map((item) => item.trim()))
      if (path.length > 0 && !paths.includes(path)) paths.push(path);
  } catch {
    // Continue with the PATH candidates below.
  }
  const invocations: PnpmInvocation[] = [];
  for (const launcher of paths) {
    const extension = extname(launcher).toLowerCase();
    if (extension === '.cmd' || extension === '.bat') {
      // Windows cannot execute a .cmd file through execFile with shell:false.
      // Resolve the Node and pnpm module targets from the shim instead of
      // invoking cmd.exe (which would reintroduce command interpolation).
      try {
        const source = await readFile(launcher, 'utf8');
        const tokens = [...source.matchAll(/"([^"]+)"/gu)]
          .map((match) => match[1])
          .filter((item): item is string => item !== undefined);
        const expand = (token: string): string =>
          resolve(dirname(launcher), token.replaceAll('%~dp0', ''));
        const nodeToken = tokens.find((token) => /(?:^|[\\/])node(?:\.exe)?$/iu.test(token));
        const pnpmToken = tokens.find((token) => /pnpm\.(?:c|m)js$/iu.test(token));
        if (nodeToken !== undefined && pnpmToken !== undefined) {
          const nodeExecutable = expand(nodeToken);
          const pnpmScript = expand(pnpmToken);
          await access(nodeExecutable);
          await access(pnpmScript);
          invocations.push({
            executable: nodeExecutable,
            args: [pnpmScript, '--version'],
            label: launcher,
          });
        }
      } catch {
        // A non-standard shim is handled by the next candidate.
      }
    } else {
      invocations.push({ executable: launcher, args: ['--version'], label: launcher });
    }
  }
  if (invocations.length === 0)
    invocations.push({ executable: 'pnpm.exe', args: ['--version'], label: 'pnpm.exe' });
  return invocations;
}

async function probePnpm(): Promise<DoctorCheck> {
  const required = '11.16.0';
  const failures: string[] = [];
  for (const invocation of await pnpmInvocations()) {
    try {
      const result = await execFileAsync(invocation.executable, invocation.args, {
        cwd: tmpdir(),
        windowsHide: true,
        timeout: DOCTOR_TIMEOUT_MS,
        shell: false,
        maxBuffer: 64 * 1024,
      });
      const version = result.stdout
        .trim()
        .split(/\s+/u)
        .find((item) => /^\d+\.\d+\.\d+$/u.test(item));
      if (version === undefined) {
        failures.push(`${invocation.label} returned no semantic version`);
        continue;
      }
      return doctorCheck(
        version === required,
        true,
        `${invocation.label} reports ${version}; required exact pnpm@${required}`,
      );
    } catch (error) {
      failures.push(
        `${invocation.label}: ${
          error instanceof Error
            ? `${error.message}${'code' in error ? ` (code ${String(error.code)})` : ''}${'stderr' in error && typeof error.stderr === 'string' && error.stderr.length > 0 ? ` stderr: ${error.stderr.trim()}` : ''}`
            : String(error)
        }`,
      );
    }
  }
  return doctorCheck(
    false,
    true,
    `pnpm executable/version probe failed: ${failures.join('; ') || 'not found'}; required exact pnpm@${required}`,
  );
}

function probeSqlite(): DoctorCheck {
  let database: { exec(sql: string): unknown; close(): void } | undefined;
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require('node:sqlite') as {
      DatabaseSync?: new (filename: string) => {
        exec(sql: string): unknown;
        close(): void;
      };
    };
    if (typeof sqlite.DatabaseSync !== 'function')
      throw new Error('DatabaseSync is not exported by node:sqlite');
    database = new sqlite.DatabaseSync(':memory:');
    database.exec('CREATE TABLE doctor_probe (value INTEGER)');
    database.exec('INSERT INTO doctor_probe (value) VALUES (1)');
    database.close();
    database = undefined;
    return doctorCheck(
      true,
      true,
      'node:sqlite DatabaseSync opened, wrote, and closed an in-memory database',
    );
  } catch (error) {
    return doctorCheck(
      false,
      true,
      `node:sqlite open/close probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (database !== undefined) {
      // A secondary close failure must not mask the probe diagnostic above.
      try {
        database.close();
      } catch {
        // Ignore; the primary result already reports the failure.
      }
      database = undefined;
    }
  }
}

async function replayCommand(args: ParsedArgs): Promise<number> {
  const bundlePath = args.positional[0];
  if (bundlePath === undefined) throw new Error('replay requires an evidence bundle path');
  const verified = await verifyEvidenceBundle(bundlePath);
  if (!verified.valid)
    throw new Error(`Refusing to replay unverifiable evidence: ${verified.errors.join('; ')}`);
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as EvidenceBundle;
  const baseOverride = option(args, 'base');
  const headOverride = option(args, 'head');
  if (baseOverride !== undefined && typeof baseOverride !== 'string')
    throw new Error('replay --base requires a directory path');
  if (headOverride !== undefined && typeof headOverride !== 'string')
    throw new Error('replay --head requires a directory path');
  const backendOption = option(args, 'backend');
  if (backendOption !== undefined && backendOption !== 'local' && backendOption !== 'docker')
    throw new Error('replay --backend must be docker or local');
  const backend =
    backendOption === 'local' || backendOption === 'docker' ? backendOption : bundle.policy.backend;
  const currentEnvironment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const deviations: string[] = [];
  if (bundle.replay.recordedEnvironment.node !== currentEnvironment.node)
    deviations.push(
      `Node changed from ${bundle.replay.recordedEnvironment.node} to ${currentEnvironment.node}`,
    );
  if (bundle.replay.recordedEnvironment.platform !== currentEnvironment.platform)
    deviations.push(
      `Platform changed from ${bundle.replay.recordedEnvironment.platform} to ${currentEnvironment.platform}`,
    );
  if (bundle.replay.recordedEnvironment.arch !== currentEnvironment.arch)
    deviations.push(
      `Architecture changed from ${bundle.replay.recordedEnvironment.arch} to ${currentEnvironment.arch}`,
    );
  if (backend !== bundle.policy.backend)
    deviations.push(`Runner backend changed from ${bundle.policy.backend} to ${backend}`);
  const plan = {
    bundle: bundle.bundleId,
    recordedOutcome: bundle.outcome,
    base: typeof baseOverride === 'string' ? baseOverride : bundle.sources.base.location,
    head: typeof headOverride === 'string' ? headOverride : bundle.sources.head.location,
    recordedNode: bundle.replay.recordedEnvironment.node,
    currentEnvironment,
    recordedBackend: bundle.policy.backend,
    currentBackend: backend,
    deviations,
  };
  if (!hasOption(args, 'yes')) {
    if (hasOption(args, 'json')) jsonOutput({ ok: true, confirmationRequired: true, plan });
    else
      console.log(
        `Replay plan (not executed)\n${JSON.stringify(plan, null, 2)}\n\nRe-run with --yes after reviewing the paths and deviations.`,
      );
    return 0;
  }
  if (typeof baseOverride !== 'string' || typeof headOverride !== 'string')
    throw new Error(
      'replay --yes requires --base <dir> and --head <dir>; bundles store stable source labels instead of host paths',
    );
  const config = configFromEvidence(bundle);
  const run = await runTwoRevisions({
    config,
    basePath: baseOverride,
    headPath: headOverride,
    backendOverride: backend,
    allowUnsafeLocal: hasOption(args, 'allow-unsafe-local'),
    fork: bundle.policy.fork,
    trustedConfig: true,
  });
  if (isPolicyDeniedRun(run)) {
    if (hasOption(args, 'json'))
      jsonOutput({ ok: false, plan, outcome: 'POLICY_DENIED', reason: run.reason });
    else console.log(`Replay denied: ${run.reason}`);
    return 3;
  }
  let classification;
  try {
    classification = await classifyOutcomeGuarded({
      base: {
        exitCode: run.base.execution.exitCode,
        timedOut: run.base.execution.timedOut,
        ...(run.base.execution.error === undefined ? {} : { error: run.base.execution.error }),
        output: `${run.base.execution.stdout}\n${run.base.execution.stderr}`,
      },
      head: {
        exitCode: run.head.execution.exitCode,
        timedOut: run.head.execution.timedOut,
        ...(run.head.execution.error === undefined ? {} : { error: run.head.execution.error }),
        output: `${run.head.execution.stdout}\n${run.head.execution.stderr}`,
      },
      expectedFailure: config.scenario.expectedFailure,
      complete: true,
    });
  } catch (error) {
    const deadline = error instanceof PatternDeadlineExceededError;
    if (!deadline && !(error instanceof PatternWorkerCrashedError)) throw error;
    const reason = deadline
      ? 'Regular-expression evaluation exceeded its deadline during replay'
      : 'Regular-expression evaluation failed during replay';
    if (hasOption(args, 'json')) jsonOutput({ ok: false, plan, outcome: 'INCONCLUSIVE', reason });
    else console.log(`Replay inconclusive: ${reason}`);
    return 2;
  }
  if (hasOption(args, 'json'))
    jsonOutput({
      ok: true,
      plan,
      replayOutcome: classification.outcome,
      reason: classification.reason,
    });
  else
    console.log(
      `Replay executed\n${JSON.stringify({ ...plan, replayOutcome: classification.outcome, reason: classification.reason }, null, 2)}`,
    );
  return outcomeExitCode(classification.outcome);
}

async function doctorCommand(args: ParsedArgs): Promise<number> {
  const packageManager = 'pnpm@11.16.0';
  const node = nodeMajorVersion();
  const checks: Record<string, DoctorCheck> = {
    node: doctorCheck(
      node >= 22,
      true,
      `${process.version}; supported Node.js is >=22.0.0 (detected major ${node})`,
    ),
    pnpm: await probePnpm(),
    sqlite: probeSqlite(),
  };
  try {
    const docker = await execFileAsync(
      'docker',
      ['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'],
      {
        windowsHide: true,
        timeout: DOCTOR_TIMEOUT_MS,
        shell: false,
        maxBuffer: 64 * 1024,
      },
    );
    const versions = docker.stdout.trim();
    checks.docker = doctorCheck(
      versions.length > 0 && !versions.endsWith('/'),
      false,
      versions.length > 0
        ? `Docker CLI/daemon reachable (${versions})`
        : 'Docker CLI returned no daemon version; production Docker runs cannot start here',
    );
  } catch (error) {
    checks.docker = doctorCheck(
      false,
      false,
      `Docker CLI/daemon unavailable (warning for local development): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const requiredChecks = Object.values(checks).filter((item) => item.required);
  const requiredOk = requiredChecks.every((item) => item.ok);
  const output = {
    ok: requiredOk,
    requiredOk,
    packageManager,
    checks,
    note: 'Docker is required for production runs but is a warning for local development; corepack enable is intentionally not run because this project does not mutate global Node installation paths',
  };
  if (hasOption(args, 'json')) jsonOutput(output);
  else
    console.log(
      Object.entries(output.checks)
        .map(
          ([key, value]) =>
            `${value.ok ? 'OK' : value.required ? 'FAIL' : 'WARN'} ${key}: ${value.detail}`,
        )
        .join('\n'),
    );
  return requiredOk ? 0 : 2;
}

/** Every option each command accepts; anything else is a typo and must fail loudly. */
const KNOWN_OPTIONS: Record<string, readonly string[]> = Object.freeze({
  init: [],
  validate: ['json', 'help'],
  run: [
    'output',
    'backend',
    'base',
    'head',
    'allow-unsafe-local',
    'fork',
    'trusted-base',
    'json',
    'help',
  ],
  verify: ['json', 'help'],
  replay: ['yes', 'backend', 'base', 'head', 'allow-unsafe-local', 'json', 'help'],
  doctor: ['json', 'help'],
  setup: ['check', 'demo', 'demo-dir', 'json', 'help'],
});

function assertKnownOptions(args: ParsedArgs): void {
  const known = KNOWN_OPTIONS[args.command];
  if (known === undefined) return;
  for (const name of args.options.keys()) {
    if (!known.includes(name)) {
      throw new Error(
        `Unknown option --${name} for ${args.command}. Available options: ${known
          .map((item) => `--${item}`)
          .join(', ')}`,
      );
    }
  }
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    if (args.command === 'help' || args.command === '--help' || hasOption(args, 'help')) {
      console.log(HELP);
      return 0;
    }
    assertKnownOptions(args);
    if (args.command === 'init') return await initCommand(args);
    if (args.command === 'validate') return await validateCommand(args);
    if (args.command === 'run') return await runCommand(args);
    if (args.command === 'verify') return await verifyCommand(args);
    if (args.command === 'replay') return await replayCommand(args);
    if (args.command === 'doctor') return await doctorCommand(args);
    if (args.command === 'setup') return await runSetup(args);
    throw new Error(`Unknown command: ${args.command}`);
  } catch (error) {
    return printError(error, hasOption(args, 'json'));
  }
}
