import { canonicalize, sha256 } from '@patchproof/core';
import { parse as parseYaml } from 'yaml';
import type { ConfigDiagnostic, PatchProofConfig } from './types.js';
import { assertSafeRelativePath } from './paths.js';

const ROOT_KEYS = new Set(['version', 'name', 'scenario', 'policy', 'redaction']);
const SCENARIO_KEYS = new Set([
  'id',
  'name',
  'command',
  'cwd',
  'file',
  'expectedFailure',
  'environment',
]);
const EXPECTED_KEYS = new Set(['exitCode', 'reasonPattern', 'reasonClass']);
const POLICY_KEYS = new Set([
  'backend',
  'allowUnsafeLocal',
  'allowFork',
  'network',
  'allowedHosts',
  'timeoutMs',
  'outputBytes',
  'memoryMb',
  'cpuCount',
  'pids',
  'dockerImage',
  'readOnlyRoot',
]);
const REDACTION_KEYS = new Set(['secrets']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
  fallback: string,
  maxLength?: number,
): string {
  if (typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000')) {
    if (maxLength !== undefined && value.length > maxLength)
      diagnostics.push({
        level: 'error',
        path,
        message: `Value must be at most ${maxLength} characters`,
      });
    return value;
  }
  diagnostics.push({ level: 'error', path, message: 'Expected a non-empty string' });
  return fallback;
}

function integer(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max)
    return value;
  diagnostics.push({
    level: 'error',
    path,
    message: `Expected a safe integer between ${min} and ${max}`,
  });
  return fallback;
}

function bool(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
  fallback: boolean,
): boolean {
  if (typeof value === 'boolean') return value;
  diagnostics.push({ level: 'error', path, message: 'Expected true or false' });
  return fallback;
}

function stringArray(value: unknown, path: string, diagnostics: ConfigDiagnostic[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    diagnostics.push({ level: 'error', path, message: 'Expected an array of strings' });
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function relativePath(
  value: string,
  path: string,
  diagnostics: ConfigDiagnostic[],
  fallback: string,
): string {
  try {
    return assertSafeRelativePath(value, path);
  } catch {
    diagnostics.push({
      level: 'error',
      path,
      message: 'Expected a safe non-empty relative path without traversal',
    });
    return fallback;
  }
}

function regularExpression(
  value: unknown,
  path: string,
  diagnostics: ConfigDiagnostic[],
  maxLength = 4096,
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = text(value, path, diagnostics, '', maxLength);
  try {
    new RegExp(parsed, 'm');
  } catch {
    diagnostics.push({ level: 'error', path, message: 'Expected a valid regular expression' });
  }
  return parsed;
}

function environment(value: unknown, diagnostics: ConfigDiagnostic[]): Record<string, string> {
  if (!isRecord(value)) {
    diagnostics.push({
      level: 'error',
      path: 'scenario.environment',
      message: 'Expected a mapping of environment names to strings',
    });
    return {};
  }
  const entries: [string, string][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (
      key.length === 0 ||
      key.includes('\u0000') ||
      typeof item !== 'string' ||
      item.includes('\u0000')
    ) {
      diagnostics.push({
        level: 'error',
        path: `scenario.environment.${key || '<empty>'}`,
        message: 'Environment names must be non-empty strings without NUL bytes',
      });
      continue;
    }
    entries.push([key, item]);
  }
  if (entries.length > 128)
    diagnostics.push({
      level: 'error',
      path: 'scenario.environment',
      message: 'At most 128 scenario environment variables are supported',
    });
  for (const [key, item] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    )
      diagnostics.push({
        level: 'error',
        path: `scenario.environment.${key}`,
        message: 'Environment names must match POSIX variable syntax',
      });
    if (item.length > 16_384)
      diagnostics.push({
        level: 'error',
        path: `scenario.environment.${key}`,
        message: 'Environment values must be at most 16384 characters',
      });
  }
  return Object.fromEntries(entries);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  diagnostics: ConfigDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      diagnostics.push({
        level: 'warning',
        path: `${path}.${key}`,
        message: 'Unknown key is ignored',
      });
  }
}

function command(value: unknown, diagnostics: ConfigDiagnostic[]): string[] {
  const parts = stringArray(value, 'scenario.command', diagnostics);
  if (parts.length === 0)
    diagnostics.push({
      level: 'error',
      path: 'scenario.command',
      message: 'Provide at least the executable argv[0]',
    });
  if (parts.some((part) => part.includes('\u0000')))
    diagnostics.push({
      level: 'error',
      path: 'scenario.command',
      message: 'Arguments must not contain NUL bytes',
    });
  if (parts.length > 128)
    diagnostics.push({
      level: 'error',
      path: 'scenario.command',
      message: 'A scenario command may contain at most 128 argv items',
    });
  for (const [index, part] of parts.entries()) {
    if (part.length > 4096)
      diagnostics.push({
        level: 'error',
        path: `scenario.command[${index}]`,
        message: 'Command arguments must be at most 4096 characters',
      });
  }
  if (parts[0] === '')
    diagnostics.push({
      level: 'error',
      path: 'scenario.command[0]',
      message: 'The executable argv[0] must not be empty',
    });
  return parts;
}

export function validateConfigValue(value: unknown): {
  config?: PatchProofConfig;
  diagnostics: ConfigDiagnostic[];
} {
  const diagnostics: ConfigDiagnostic[] = [];
  if (!isRecord(value))
    return {
      diagnostics: [{ level: 'error', path: '$', message: 'Configuration must be a YAML object' }],
    };
  unknownKeys(value, ROOT_KEYS, '$', diagnostics);
  if (value.version !== 1)
    diagnostics.push({
      level: 'error',
      path: 'version',
      message: 'PatchProof requires explicit version: 1',
    });
  const scenarioValue = isRecord(value.scenario) ? value.scenario : {};
  const policyValue = isRecord(value.policy) ? value.policy : {};
  const redactionValue = isRecord(value.redaction) ? value.redaction : {};
  unknownKeys(scenarioValue, SCENARIO_KEYS, 'scenario', diagnostics);
  unknownKeys(policyValue, POLICY_KEYS, 'policy', diagnostics);
  unknownKeys(redactionValue, REDACTION_KEYS, 'redaction', diagnostics);
  const expectedValue = isRecord(scenarioValue.expectedFailure)
    ? scenarioValue.expectedFailure
    : {};
  unknownKeys(expectedValue, EXPECTED_KEYS, 'scenario.expectedFailure', diagnostics);
  const backend =
    policyValue.backend === 'local' || policyValue.backend === 'docker'
      ? policyValue.backend
      : 'docker';
  if (policyValue.backend !== undefined && policyValue.backend !== backend)
    diagnostics.push({ level: 'error', path: 'policy.backend', message: 'Use docker or local' });
  const network = policyValue.network === 'allowlist' ? 'allowlist' : 'none';
  if (
    policyValue.network !== undefined &&
    policyValue.network !== 'none' &&
    policyValue.network !== 'allowlist'
  )
    diagnostics.push({ level: 'error', path: 'policy.network', message: 'Use none or allowlist' });
  const allowedHosts = stringArray(
    policyValue.allowedHosts ?? [],
    'policy.allowedHosts',
    diagnostics,
  );
  if (new Set(allowedHosts).size !== allowedHosts.length)
    diagnostics.push({
      level: 'error',
      path: 'policy.allowedHosts',
      message: 'Allowed hosts must not contain duplicates',
    });
  for (const [index, host] of allowedHosts.entries()) {
    if (host.length > 253)
      diagnostics.push({
        level: 'error',
        path: `policy.allowedHosts[${index}]`,
        message: 'Allowed hosts must be at most 253 characters',
      });
  }
  if (network === 'allowlist' && allowedHosts.length === 0)
    diagnostics.push({
      level: 'error',
      path: 'policy.allowedHosts',
      message: 'An allowlist must contain at least one host',
    });
  const secrets = stringArray(redactionValue.secrets ?? [], 'redaction.secrets', diagnostics);
  const reasonPattern = regularExpression(
    expectedValue.reasonPattern,
    'scenario.expectedFailure.reasonPattern',
    diagnostics,
  );
  const reasonClass = regularExpression(
    expectedValue.reasonClass,
    'scenario.expectedFailure.reasonClass',
    diagnostics,
  );
  const config: PatchProofConfig = {
    version: 1,
    name: text(value.name, 'name', diagnostics, 'PatchProof scenario', 512),
    scenario: {
      id: text(scenarioValue.id, 'scenario.id', diagnostics, 'scenario', 256),
      name: text(scenarioValue.name, 'scenario.name', diagnostics, 'Configured scenario', 512),
      command: command(scenarioValue.command, diagnostics),
      cwd: relativePath(
        text(scenarioValue.cwd ?? '.', 'scenario.cwd', diagnostics, '.'),
        'scenario.cwd',
        diagnostics,
        '.',
      ),
      ...(scenarioValue.file === undefined
        ? {}
        : {
            file: relativePath(
              text(scenarioValue.file, 'scenario.file', diagnostics, ''),
              'scenario.file',
              diagnostics,
              'scenario.mjs',
            ),
          }),
      expectedFailure: {
        exitCode: integer(
          expectedValue.exitCode,
          'scenario.expectedFailure.exitCode',
          diagnostics,
          1,
          1,
          255,
        ),
        ...(reasonPattern === undefined ? {} : { reasonPattern }),
        ...(reasonClass === undefined ? {} : { reasonClass }),
      },
      environment: environment(scenarioValue.environment ?? {}, diagnostics),
    },
    policy: {
      backend,
      allowUnsafeLocal: bool(
        policyValue.allowUnsafeLocal ?? false,
        'policy.allowUnsafeLocal',
        diagnostics,
        false,
      ),
      allowFork: bool(policyValue.allowFork ?? false, 'policy.allowFork', diagnostics, false),
      network,
      allowedHosts,
      timeoutMs: integer(
        policyValue.timeoutMs ?? 30_000,
        'policy.timeoutMs',
        diagnostics,
        30_000,
        100,
        86_400_000,
      ),
      outputBytes: integer(
        policyValue.outputBytes ?? 65_536,
        'policy.outputBytes',
        diagnostics,
        65_536,
        1024,
        1_073_741_824,
      ),
      memoryMb: integer(
        policyValue.memoryMb ?? 512,
        'policy.memoryMb',
        diagnostics,
        512,
        64,
        1_048_576,
      ),
      cpuCount: integer(policyValue.cpuCount ?? 1, 'policy.cpuCount', diagnostics, 1, 1, 256),
      pids: integer(policyValue.pids ?? 128, 'policy.pids', diagnostics, 128, 16, 1_000_000),
      dockerImage: (() => {
        const image = text(
          policyValue.dockerImage ?? 'node:24-bookworm-slim',
          'policy.dockerImage',
          diagnostics,
          'node:24-bookworm-slim',
          256,
        );
        if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/u.test(image))
          diagnostics.push({
            level: 'error',
            path: 'policy.dockerImage',
            message: 'Docker image must be a bounded image reference and must not begin with -',
          });
        return image;
      })(),
      readOnlyRoot: bool(
        policyValue.readOnlyRoot ?? true,
        'policy.readOnlyRoot',
        diagnostics,
        true,
      ),
    },
    redaction: { secrets },
  };
  if (config.policy.backend === 'local' && !config.policy.allowUnsafeLocal)
    diagnostics.push({
      level: 'warning',
      path: 'policy',
      message:
        'Local backend is denied unless allowUnsafeLocal is explicitly true and the CLI receives --allow-unsafe-local',
    });
  if (config.policy.network === 'allowlist' && config.policy.backend === 'local')
    diagnostics.push({
      level: 'warning',
      path: 'policy.network',
      message:
        'Local development cannot enforce network allowlists; use Docker for production enforcement',
    });
  return diagnostics.some((diagnostic) => diagnostic.level === 'error')
    ? { diagnostics }
    : { config, diagnostics };
}

export function parseConfigText(textValue: string): {
  config?: PatchProofConfig;
  diagnostics: ConfigDiagnostic[];
  sha256: string;
} {
  const diagnostics: ConfigDiagnostic[] = [];
  let value: unknown;
  try {
    value = parseYaml(textValue, { prettyErrors: true }) as unknown;
  } catch (error) {
    diagnostics.push({
      level: 'error',
      path: '$',
      message: `YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { diagnostics, sha256: sha256(textValue) };
  }
  const validated = validateConfigValue(value);
  return { ...validated, sha256: sha256(canonicalize(value)) };
}
