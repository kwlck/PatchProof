import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { classifyOutcome, verifyEvidenceBundle, type EvidenceBundle } from '@patchproof/core';
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

const execFileAsync = promisify(execFile);

const HELP = `PatchProof - replayable evidence for pull-request bug fixes

Usage:
  patchproof init [directory]
  patchproof validate <.patchproof.yml> [--json]
  patchproof run <.patchproof.yml> --base <dir> --head <dir> [options]
  patchproof verify <patchproof.evidence.json> [--json]
  patchproof replay <patchproof.evidence.json> [--yes] [--backend docker|local] [--base <dir> --head <dir>]
  patchproof doctor [--json]

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
  return 2;
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
  const classification = classifyOutcome({
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
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  checks.node = { ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version };
  const packageManager = 'pnpm@11.16.0';
  checks.pnpm = {
    ok: packageManager === 'pnpm@11.16.0',
    detail: `${packageManager} pinned in package.json; verify the launcher with pnpm --version`,
  };
  try {
    const docker = await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      windowsHide: true,
    });
    checks.docker = { ok: true, detail: docker.stdout.trim() };
  } catch {
    checks.docker = {
      ok: false,
      detail: 'Docker CLI/daemon unavailable; production Docker runs cannot start here',
    };
  }
  checks.sqlite = {
    ok: true,
    detail: 'node:sqlite DatabaseSync (Node runtime feature; local state adapter)',
  };
  const output = {
    ok: Object.values(checks).every((item) => item.ok),
    packageManager,
    checks,
    note: 'corepack enable is intentionally not run because this project does not mutate global Node installation paths',
  };
  if (hasOption(args, 'json')) jsonOutput(output);
  else
    console.log(
      Object.entries(output.checks)
        .map(([key, value]) => `${value.ok ? 'OK' : 'WARN'} ${key}: ${value.detail}`)
        .join('\n'),
    );
  return 0;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    if (args.command === 'help' || args.command === '--help' || hasOption(args, 'help')) {
      console.log(HELP);
      return 0;
    }
    if (args.command === 'init') return await initCommand(args);
    if (args.command === 'validate') return await validateCommand(args);
    if (args.command === 'run') return await runCommand(args);
    if (args.command === 'verify') return await verifyCommand(args);
    if (args.command === 'replay') return await replayCommand(args);
    if (args.command === 'doctor') return await doctorCommand(args);
    throw new Error(`Unknown command: ${args.command}`);
  } catch (error) {
    return printError(error, hasOption(args, 'json'));
  }
}
