import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { classifyOutcome } from './policy.js';
import { evidenceDigest, sha256 } from './canonical.js';
import {
  EVIDENCE_SCHEMA_VERSION,
  type ArtifactReference,
  type CompletenessReport,
  type DependencyLockIdentity,
  type EvidenceBundle,
  type ExecutionEvidence,
  type ExpectedFailure,
  type LogEvidence,
  type PolicySnapshot,
  type SourceSnapshot,
} from './types.js';

const RUN_OUTCOMES = ['PASS', 'FAIL', 'INCONCLUSIVE', 'INFRA_ERROR', 'POLICY_DENIED'] as const;
const COMPLETENESS_CHECKS = [
  'schema',
  'trustedScenario',
  'baseSource',
  'headSource',
  'baseExecution',
  'headExecution',
  'logsPersisted',
  'artifactHashes',
  'cleanup',
] as const;
const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'product',
  'bundleId',
  'createdAt',
  'outcome',
  'verdict',
  'scenario',
  'sources',
  'policy',
  'executions',
  'artifacts',
  'completeness',
  'replay',
  'integrity',
] as const;

export interface VerificationResult {
  valid: boolean;
  schemaSupported: boolean;
  digestValid: boolean;
  artifactsValid: boolean;
  completenessValid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function duplicateJsonKeys(source: string): string[] {
  const stack: Array<Set<string> | null> = [];
  const duplicates: string[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      let lookahead = index;
      while (/\s/u.test(source[lookahead] ?? '')) lookahead += 1;
      const frame = stack[stack.length - 1];
      if (source[lookahead] === ':' && frame instanceof Set) {
        let key: unknown;
        try {
          key = JSON.parse(source.slice(start, index)) as unknown;
        } catch {
          key = undefined;
        }
        if (typeof key === 'string') {
          if (frame.has(key) && duplicates.length < 32) duplicates.push(key);
          frame.add(key);
        }
      }
      continue;
    }
    if (character === '{') stack.push(new Set<string>());
    else if (character === '[') stack.push(null);
    else if (character === '}' || character === ']') stack.pop();
    index += 1;
  }
  return duplicates;
}

function addUnknownKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  errors: string[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} contains unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) errors.push(`${path} is missing required field: ${key}`);
  }
}

function objectValue(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  errors: string[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  addUnknownKeys(value, path, required, optional, errors);
  return value;
}

function stringValue(
  value: unknown,
  path: string,
  errors: string[],
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string`);
    return undefined;
  }
  if (!options.allowEmpty && value.length === 0) errors.push(`${path} must not be empty`);
  if (options.maxLength !== undefined && value.length > options.maxLength)
    errors.push(`${path} exceeds the supported length limit`);
  if (value.includes('\u0000')) errors.push(`${path} must not contain NUL`);
  return value;
}

function optionalStringValue(
  object: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string | undefined {
  if (!(key in object)) return undefined;
  return stringValue(object[key], `${path}.${key}`, errors, options);
}

function booleanValue(value: unknown, path: string, errors: string[]): boolean | undefined {
  if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
  return typeof value === 'boolean' ? value : undefined;
}

function integerValue(
  value: unknown,
  path: string,
  errors: string[],
  options: { min?: number; max?: number } = {},
): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    errors.push(`${path} must be a safe integer`);
    return undefined;
  }
  if (options.min !== undefined && value < options.min)
    errors.push(`${path} must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max)
    errors.push(`${path} must be at most ${options.max}`);
  return value;
}

function arrayValue(value: unknown, path: string, errors: string[]): unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return undefined;
  }
  const result: unknown[] = [];
  for (const item of value) result.push(item);
  return result;
}

function stringArray(
  value: unknown,
  path: string,
  errors: string[],
  options: { allowEmptyItems?: boolean; maxLength?: number } = {},
): string[] | undefined {
  const array = arrayValue(value, path, errors);
  if (array === undefined) return undefined;
  const result: string[] = [];
  for (const [index, item] of array.entries()) {
    const parsed = stringValue(item, `${path}[${index}]`, errors, {
      ...(options.allowEmptyItems === undefined ? {} : { allowEmpty: options.allowEmptyItems }),
      ...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
    });
    if (parsed !== undefined) result.push(parsed);
  }
  return result;
}

function sha256Value(value: unknown, path: string, errors: string[]): string | undefined {
  const parsed = stringValue(value, path, errors);
  if (parsed !== undefined && !/^[0-9a-f]{64}$/iu.test(parsed))
    errors.push(`${path} must be a SHA-256 hex digest`);
  return parsed;
}

function isoTimestamp(value: unknown, path: string, errors: string[]): string | undefined {
  const parsed = stringValue(value, path, errors);
  if (parsed !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed))
    errors.push(`${path} must be an ISO-8601 UTC timestamp with milliseconds`);
  if (parsed !== undefined && Number.isNaN(Date.parse(parsed)))
    errors.push(`${path} must be a valid timestamp`);
  return parsed;
}

function safeRelativePath(value: string, path: string, errors: string[]): boolean {
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    value.length === 0 ||
    normalized.startsWith('/') ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    segments.some((segment) => segment === '..')
  ) {
    errors.push(`${path} must be a safe relative path`);
    return false;
  }
  return true;
}

function safeLocationValue(value: unknown, path: string, errors: string[]): string | undefined {
  const parsed = stringValue(value, path, errors, { maxLength: 4096 });
  if (parsed === undefined) return undefined;
  if (
    /^[A-Za-z]:/u.test(parsed) ||
    parsed.startsWith('~') ||
    parsed.includes('\\') ||
    !/^[A-Za-z0-9._/-]+$/u.test(parsed) ||
    !safeRelativePath(parsed, path, errors)
  )
    errors.push(`${path} must not contain a host filesystem path`);
  return parsed;
}

function validateExpectedFailure(
  value: unknown,
  path: string,
  errors: string[],
): ExpectedFailure | undefined {
  const object = objectValue(value, path, ['exitCode'], ['reasonPattern', 'reasonClass'], errors);
  if (object === undefined) return undefined;
  const exitCode = integerValue(object.exitCode, `${path}.exitCode`, errors, { min: 1, max: 255 });
  const reasonPattern = optionalStringValue(object, 'reasonPattern', path, errors, {
    maxLength: 4096,
  });
  const reasonClass = optionalStringValue(object, 'reasonClass', path, errors, { maxLength: 4096 });
  for (const [name, expression] of [
    ['reasonPattern', reasonPattern],
    ['reasonClass', reasonClass],
  ] as const) {
    if (expression === undefined) continue;
    try {
      new RegExp(expression, 'm');
    } catch {
      errors.push(`${path}.${name} must be a valid regular expression`);
    }
  }
  if (exitCode === undefined) return undefined;
  return {
    exitCode,
    ...(reasonPattern === undefined ? {} : { reasonPattern }),
    ...(reasonClass === undefined ? {} : { reasonClass }),
  };
}

function validateScenario(
  value: unknown,
  errors: string[],
): EvidenceBundle['scenario'] | undefined {
  const path = 'scenario';
  const object = objectValue(
    value,
    path,
    ['id', 'name', 'command', 'cwd', 'trustedSource', 'expectedFailure', 'sha256'],
    ['file'],
    errors,
  );
  if (object === undefined) return undefined;
  const id = stringValue(object.id, `${path}.id`, errors, { maxLength: 256 });
  const name = stringValue(object.name, `${path}.name`, errors, { maxLength: 512 });
  const command = stringArray(object.command, `${path}.command`, errors, { maxLength: 4096 });
  const cwd = stringValue(object.cwd, `${path}.cwd`, errors);
  const trustedSource = stringValue(object.trustedSource, `${path}.trustedSource`, errors);
  const file = optionalStringValue(object, 'file', path, errors);
  const scenarioSha = sha256Value(object.sha256, `${path}.sha256`, errors);
  const expectedFailure = validateExpectedFailure(
    object.expectedFailure,
    `${path}.expectedFailure`,
    errors,
  );
  if (command !== undefined && command.length === 0)
    errors.push(`${path}.command must not be empty`);
  if (trustedSource !== 'base') errors.push('scenario.trustedSource must be base');
  if (cwd !== undefined) safeRelativePath(cwd, `${path}.cwd`, errors);
  if (file !== undefined) safeRelativePath(file, `${path}.file`, errors);
  if (
    id === undefined ||
    name === undefined ||
    command === undefined ||
    cwd === undefined ||
    expectedFailure === undefined ||
    scenarioSha === undefined
  )
    return undefined;
  return {
    id,
    name,
    command,
    cwd,
    trustedSource: 'base',
    ...(file === undefined ? {} : { file }),
    expectedFailure,
    sha256: scenarioSha,
  };
}

function validateSource(
  value: unknown,
  revision: 'base' | 'head',
  errors: string[],
): SourceSnapshot | undefined {
  const path = `sources.${revision}`;
  const object = objectValue(
    value,
    path,
    ['revision', 'ref', 'sha256', 'kind', 'location'],
    [],
    errors,
  );
  if (object === undefined) return undefined;
  const parsedRevision = stringValue(object.revision, `${path}.revision`, errors);
  const ref = stringValue(object.ref, `${path}.ref`, errors, { maxLength: 1024 });
  const hash = stringValue(object.sha256, `${path}.sha256`, errors);
  const kind = stringValue(object.kind, `${path}.kind`, errors);
  const location = safeLocationValue(object.location, `${path}.location`, errors);
  if (parsedRevision !== revision) errors.push(`${path}.revision must be ${revision}`);
  if (kind !== 'git-commit' && kind !== 'directory-tree')
    errors.push(`${path}.kind must be git-commit or directory-tree`);
  if (hash !== undefined) {
    if (kind === 'git-commit' && !/^[0-9a-f]{40}$/iu.test(hash))
      errors.push(`${path}.sha256 must be a commit SHA for git-commit sources`);
    if (kind === 'directory-tree' && !/^[0-9a-f]{64}$/iu.test(hash))
      errors.push(`${path}.sha256 must be a tree SHA-256 for directory-tree sources`);
  }
  if (kind === 'git-commit' && ref !== undefined && !/^[0-9a-f]{40}$/iu.test(ref))
    errors.push(`${path}.ref must be a commit SHA for git-commit sources`);
  if (
    kind === 'directory-tree' &&
    ref !== undefined &&
    (!/^[A-Za-z0-9._/-]+$/u.test(ref) || !safeRelativePath(ref, `${path}.ref`, errors))
  )
    errors.push(`${path}.ref must be a stable relative source label`);
  if (
    kind === 'git-commit' &&
    ref !== undefined &&
    hash !== undefined &&
    ref.toLowerCase() !== hash.toLowerCase()
  )
    errors.push(`${path}.ref and sha256 must identify the same commit`);
  if (
    location === undefined ||
    parsedRevision === undefined ||
    ref === undefined ||
    hash === undefined ||
    kind === undefined
  )
    return undefined;
  return { revision, ref, sha256: hash, kind: kind as SourceSnapshot['kind'], location };
}

function validatePolicy(value: unknown, errors: string[]): PolicySnapshot | undefined {
  const path = 'policy';
  const object = objectValue(
    value,
    path,
    [
      'backend',
      'network',
      'allowedHosts',
      'unsafeLocalProcess',
      'fork',
      'trustedConfigRevision',
      'limits',
    ],
    ['denialReason'],
    errors,
  );
  if (object === undefined) return undefined;
  const backend = stringValue(object.backend, `${path}.backend`, errors);
  const network = stringValue(object.network, `${path}.network`, errors);
  const allowedHosts = stringArray(object.allowedHosts, `${path}.allowedHosts`, errors, {
    maxLength: 253,
  });
  const unsafeLocalProcess = booleanValue(
    object.unsafeLocalProcess,
    `${path}.unsafeLocalProcess`,
    errors,
  );
  const fork = booleanValue(object.fork, `${path}.fork`, errors);
  const trustedConfigRevision = stringValue(
    object.trustedConfigRevision,
    `${path}.trustedConfigRevision`,
    errors,
  );
  const denialReason = optionalStringValue(object, 'denialReason', path, errors, {
    maxLength: 2048,
  });
  const limitsObject = objectValue(
    object.limits,
    `${path}.limits`,
    ['timeoutMs', 'outputBytes', 'memoryMb', 'cpuCount', 'pids'],
    [],
    errors,
  );
  const limits =
    limitsObject === undefined
      ? undefined
      : {
          timeoutMs: integerValue(limitsObject.timeoutMs, `${path}.limits.timeoutMs`, errors, {
            min: 1,
            max: 86_400_000,
          }),
          outputBytes: integerValue(
            limitsObject.outputBytes,
            `${path}.limits.outputBytes`,
            errors,
            { min: 1, max: 1_073_741_824 },
          ),
          memoryMb: integerValue(limitsObject.memoryMb, `${path}.limits.memoryMb`, errors, {
            min: 1,
            max: 1_048_576,
          }),
          cpuCount: integerValue(limitsObject.cpuCount, `${path}.limits.cpuCount`, errors, {
            min: 1,
            max: 256,
          }),
          pids: integerValue(limitsObject.pids, `${path}.limits.pids`, errors, {
            min: 1,
            max: 1_000_000,
          }),
        };
  if (backend !== 'docker' && backend !== 'local') errors.push(`${path}.backend is unsupported`);
  if (network !== 'none' && network !== 'allowlist') errors.push(`${path}.network is unsupported`);
  if (trustedConfigRevision !== 'base') errors.push(`${path}.trustedConfigRevision must be base`);
  if (allowedHosts !== undefined && new Set(allowedHosts).size !== allowedHosts.length)
    errors.push(`${path}.allowedHosts must not contain duplicates`);
  if (
    backend === undefined ||
    network === undefined ||
    allowedHosts === undefined ||
    unsafeLocalProcess === undefined ||
    fork === undefined ||
    trustedConfigRevision === undefined ||
    limits === undefined ||
    Object.values(limits).some((item) => item === undefined)
  )
    return undefined;
  return {
    backend: backend as PolicySnapshot['backend'],
    network: network as PolicySnapshot['network'],
    allowedHosts,
    unsafeLocalProcess,
    fork,
    trustedConfigRevision: 'base',
    ...(denialReason === undefined ? {} : { denialReason }),
    limits: limits as PolicySnapshot['limits'],
  };
}

function validateEnvironment(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  if (Object.keys(value).length > 128) errors.push(`${path} contains too many variables`);
  for (const [key, item] of Object.entries(value)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    )
      errors.push(`${path}.${key} is not a safe environment name`);
    const parsed = stringValue(item, `${path}.${key}`, errors, { maxLength: 16_384 });
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

function validateLauncherEnvironment(
  value: unknown,
  path: string,
  errors: string[],
): ExecutionEvidence['launcherEnvironment'] | undefined {
  const object = objectValue(value, path, ['omitted', 'keys', 'sha256'], [], errors);
  if (object === undefined) return undefined;
  const omitted = booleanValue(object.omitted, `${path}.omitted`, errors);
  const keys = stringArray(object.keys, `${path}.keys`, errors, { maxLength: 256 });
  const hash = sha256Value(object.sha256, `${path}.sha256`, errors);
  if (omitted !== true) errors.push(`${path}.omitted must be true`);
  if (keys !== undefined) {
    if (new Set(keys).size !== keys.length) errors.push(`${path}.keys must not contain duplicates`);
    if (
      keys.some(
        (key, index) => index > 0 && keys[index - 1] !== undefined && keys[index - 1]! > key,
      )
    )
      errors.push(`${path}.keys must be sorted`);
    if (
      keys.some(
        (key) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
          key === '__proto__' ||
          key === 'constructor' ||
          key === 'prototype',
      )
    )
      errors.push(`${path}.keys contains an unsafe environment name`);
  }
  if (omitted !== true || keys === undefined || hash === undefined) return undefined;
  return { omitted: true, keys, sha256: hash };
}

function validateToolchain(
  value: unknown,
  path: string,
  errors: string[],
): ExecutionEvidence['toolchain'] | undefined {
  const object = objectValue(
    value,
    path,
    ['node', 'platform', 'arch', 'runner', 'dependencyLock'],
    ['containerImage'],
    errors,
  );
  if (object === undefined) return undefined;
  const node = stringValue(object.node, `${path}.node`, errors, { maxLength: 512 });
  const platform = stringValue(object.platform, `${path}.platform`, errors, { maxLength: 128 });
  const arch = stringValue(object.arch, `${path}.arch`, errors, { maxLength: 128 });
  const runner = stringValue(object.runner, `${path}.runner`, errors, { maxLength: 512 });
  const containerImage = optionalStringValue(object, 'containerImage', path, errors, {
    maxLength: 256,
  });
  const dependencyLockObject = objectValue(
    object.dependencyLock,
    `${path}.dependencyLock`,
    ['status'],
    ['file', 'sha256'],
    errors,
  );
  const dependencyLockStatus =
    dependencyLockObject === undefined
      ? undefined
      : stringValue(dependencyLockObject.status, `${path}.dependencyLock.status`, errors);
  const dependencyLockFile =
    dependencyLockObject === undefined
      ? undefined
      : optionalStringValue(dependencyLockObject, 'file', `${path}.dependencyLock`, errors, {
          maxLength: 128,
        });
  const dependencyLockSha256 =
    dependencyLockObject === undefined
      ? undefined
      : dependencyLockObject.sha256 === undefined
        ? undefined
        : sha256Value(dependencyLockObject.sha256, `${path}.dependencyLock.sha256`, errors);
  const knownLockfiles = new Set([
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'npm-shrinkwrap.json',
  ]);
  if (dependencyLockStatus !== 'present' && dependencyLockStatus !== 'not-detected')
    errors.push(`${path}.dependencyLock.status is unsupported`);
  if (dependencyLockFile !== undefined && !knownLockfiles.has(dependencyLockFile))
    errors.push(`${path}.dependencyLock.file is not a supported lockfile name`);
  if (dependencyLockStatus === 'present') {
    if (dependencyLockFile === undefined)
      errors.push(`${path}.dependencyLock.file is required when status is present`);
    if (dependencyLockSha256 === undefined)
      errors.push(`${path}.dependencyLock.sha256 is required when status is present`);
  }
  if (dependencyLockStatus === 'not-detected') {
    if (dependencyLockFile !== undefined)
      errors.push(`${path}.dependencyLock.file must be omitted when status is not-detected`);
    if (dependencyLockSha256 !== undefined)
      errors.push(`${path}.dependencyLock.sha256 must be omitted when status is not-detected`);
  }
  if (containerImage !== undefined && platform !== 'container')
    errors.push(`${path}.platform must be container when containerImage is recorded`);
  if (containerImage !== undefined && arch !== 'container')
    errors.push(`${path}.arch must be container when containerImage is recorded`);
  if (
    containerImage !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/u.test(containerImage)
  )
    errors.push(`${path}.containerImage is not a safe Docker image reference`);
  if (
    node === undefined ||
    platform === undefined ||
    arch === undefined ||
    runner === undefined ||
    dependencyLockObject === undefined ||
    dependencyLockStatus === undefined ||
    (dependencyLockStatus === 'present' &&
      (dependencyLockFile === undefined || dependencyLockSha256 === undefined))
  )
    return undefined;
  const dependencyLock: DependencyLockIdentity =
    dependencyLockStatus === 'present'
      ? { status: 'present', file: dependencyLockFile!, sha256: dependencyLockSha256! }
      : { status: 'not-detected' };
  return {
    node,
    platform,
    arch,
    runner,
    dependencyLock,
    ...(containerImage === undefined ? {} : { containerImage }),
  };
}

function validateLog(value: unknown, path: string, errors: string[]): LogEvidence | undefined {
  const object = objectValue(
    value,
    path,
    ['artifactId', 'preview', 'truncated', 'sizeBytes'],
    [],
    errors,
  );
  if (object === undefined) return undefined;
  const artifactId = stringValue(object.artifactId, `${path}.artifactId`, errors, {
    maxLength: 512,
  });
  const preview = stringValue(object.preview, `${path}.preview`, errors, {
    allowEmpty: true,
    maxLength: 8192,
  });
  const truncated = booleanValue(object.truncated, `${path}.truncated`, errors);
  const sizeBytes = integerValue(object.sizeBytes, `${path}.sizeBytes`, errors, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (artifactId !== undefined && !/^[A-Za-z0-9._-]+$/u.test(artifactId))
    errors.push(`${path}.artifactId is unsafe`);
  if (
    artifactId === undefined ||
    preview === undefined ||
    truncated === undefined ||
    sizeBytes === undefined
  )
    return undefined;
  return { artifactId, preview, truncated, sizeBytes };
}

function validateExecution(
  value: unknown,
  revision: 'base' | 'head',
  errors: string[],
): ExecutionEvidence | undefined {
  const path = `executions.${revision}`;
  const object = objectValue(
    value,
    path,
    [
      'revision',
      'command',
      'cwd',
      'environment',
      'launcherEnvironment',
      'toolchain',
      'exitCode',
      'timedOut',
      'startedAt',
      'durationMs',
      'stdout',
      'stderr',
    ],
    ['signal', 'error'],
    errors,
  );
  if (object === undefined) return undefined;
  const parsedRevision = stringValue(object.revision, `${path}.revision`, errors);
  const command = stringArray(object.command, `${path}.command`, errors, { maxLength: 4096 });
  const cwd = stringValue(object.cwd, `${path}.cwd`, errors);
  const environment = validateEnvironment(object.environment, `${path}.environment`, errors);
  const launcherEnvironment = validateLauncherEnvironment(
    object.launcherEnvironment,
    `${path}.launcherEnvironment`,
    errors,
  );
  const toolchain = validateToolchain(object.toolchain, `${path}.toolchain`, errors);
  const exitCode =
    object.exitCode === null
      ? null
      : integerValue(object.exitCode, `${path}.exitCode`, errors, { min: 0, max: 255 });
  const signal = optionalStringValue(object, 'signal', path, errors, { maxLength: 64 });
  const timedOut = booleanValue(object.timedOut, `${path}.timedOut`, errors);
  const startedAt = isoTimestamp(object.startedAt, `${path}.startedAt`, errors);
  const durationMs = integerValue(object.durationMs, `${path}.durationMs`, errors, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const stdout = validateLog(object.stdout, `${path}.stdout`, errors);
  const stderr = validateLog(object.stderr, `${path}.stderr`, errors);
  const error = optionalStringValue(object, 'error', path, errors, { maxLength: 4096 });
  if (command !== undefined && command.length === 0)
    errors.push(`${path}.command must not be empty`);
  if (command !== undefined && command.length > 128)
    errors.push(`${path}.command contains too many argv items`);
  if (command !== undefined && command[0] === '')
    errors.push(`${path}.command[0] must not be empty`);
  if (parsedRevision !== revision) errors.push(`${path}.revision must be ${revision}`);
  if (cwd !== undefined) safeRelativePath(cwd, `${path}.cwd`, errors);
  if (signal !== undefined && !/^SIG[A-Z0-9]+$/u.test(signal))
    errors.push(`${path}.signal must be a signal name`);
  if (exitCode === null && error === undefined)
    errors.push(`${path}.error is required when exitCode is null`);
  if (
    parsedRevision === undefined ||
    command === undefined ||
    cwd === undefined ||
    environment === undefined ||
    launcherEnvironment === undefined ||
    toolchain === undefined ||
    exitCode === undefined ||
    timedOut === undefined ||
    startedAt === undefined ||
    durationMs === undefined ||
    stdout === undefined ||
    stderr === undefined
  )
    return undefined;
  return {
    revision,
    command,
    cwd,
    environment,
    launcherEnvironment,
    toolchain,
    exitCode,
    ...(signal === undefined ? {} : { signal }),
    timedOut,
    startedAt,
    durationMs,
    stdout,
    stderr,
    ...(error === undefined ? {} : { error }),
  };
}

function validateArtifacts(value: unknown, errors: string[]): ArtifactReference[] | undefined {
  const array = arrayValue(value, 'artifacts', errors);
  if (array === undefined) return undefined;
  const result: ArtifactReference[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [index, item] of array.entries()) {
    const path = `artifacts[${index}]`;
    const object = objectValue(
      item,
      path,
      ['id', 'relativePath', 'sha256', 'sizeBytes', 'mediaType'],
      [],
      errors,
    );
    if (object === undefined) continue;
    const id = stringValue(object.id, `${path}.id`, errors, { maxLength: 512 });
    const relativePath = stringValue(object.relativePath, `${path}.relativePath`, errors, {
      maxLength: 1024,
    });
    const hash = sha256Value(object.sha256, `${path}.sha256`, errors);
    const sizeBytes = integerValue(object.sizeBytes, `${path}.sizeBytes`, errors, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    });
    const mediaType = stringValue(object.mediaType, `${path}.mediaType`, errors);
    if (id !== undefined && !/^[A-Za-z0-9._-]+$/u.test(id)) errors.push(`${path}.id is unsafe`);
    if (id !== undefined && ids.has(id)) errors.push(`${path}.id is duplicated`);
    if (id !== undefined) ids.add(id);
    if (relativePath !== undefined) {
      safeRelativePath(relativePath, `${path}.relativePath`, errors);
      const normalizedPath = relativePath.replaceAll('\\', '/');
      if (
        normalizedPath !== relativePath ||
        normalizedPath.split('/').some((segment) => segment.length === 0 || segment === '.')
      )
        errors.push(`${path}.relativePath must use canonical slash-separated segments`);
      if (!relativePath.replaceAll('\\', '/').startsWith('artifacts/'))
        errors.push(`${path}.relativePath must be under artifacts/`);
      if (paths.has(relativePath)) errors.push(`${path}.relativePath is duplicated`);
      paths.add(relativePath);
    }
    if (
      mediaType !== 'text/plain' &&
      mediaType !== 'application/json' &&
      mediaType !== 'application/octet-stream'
    )
      errors.push(`${path}.mediaType is unsupported`);
    if (
      id === undefined ||
      relativePath === undefined ||
      hash === undefined ||
      sizeBytes === undefined ||
      mediaType === undefined
    )
      continue;
    result.push({
      id,
      relativePath,
      sha256: hash,
      sizeBytes,
      mediaType: mediaType as ArtifactReference['mediaType'],
    });
  }
  return result;
}

function validateCompleteness(value: unknown, errors: string[]): CompletenessReport | undefined {
  const object = objectValue(value, 'completeness', ['complete', 'checks', 'missing'], [], errors);
  if (object === undefined) return undefined;
  const complete = booleanValue(object.complete, 'completeness.complete', errors);
  const checksObject = objectValue(
    object.checks,
    'completeness.checks',
    COMPLETENESS_CHECKS,
    [],
    errors,
  );
  const checks: Record<string, boolean> = {};
  if (checksObject !== undefined) {
    for (const name of COMPLETENESS_CHECKS) {
      const parsed = booleanValue(checksObject[name], `completeness.checks.${name}`, errors);
      if (parsed !== undefined) checks[name] = parsed;
    }
  }
  const missing = stringArray(object.missing, 'completeness.missing', errors, { maxLength: 128 });
  if (missing !== undefined) {
    if (new Set(missing).size !== missing.length)
      errors.push('completeness.missing must not contain duplicates');
    const expected = COMPLETENESS_CHECKS.filter((name) => checks[name] === false);
    if (JSON.stringify(missing) !== JSON.stringify(expected))
      errors.push('completeness.missing does not match failed checks');
  }
  const allChecks = COMPLETENESS_CHECKS.every((name) => checks[name] === true);
  if (complete !== allChecks)
    errors.push('completeness.complete must equal the conjunction of checks');
  if (checks.schema !== true)
    errors.push('completeness.checks.schema must be true for a supported bundle');
  if (complete === undefined || missing === undefined || checksObject === undefined)
    return undefined;
  return { complete, checks, missing };
}

function validateReplay(value: unknown, errors: string[]): EvidenceBundle['replay'] | undefined {
  const object = objectValue(
    value,
    'replay',
    [
      'supported',
      'baseLocation',
      'headLocation',
      'requiresExplicitConfirmation',
      'recordedEnvironment',
    ],
    [],
    errors,
  );
  if (object === undefined) return undefined;
  const supported = booleanValue(object.supported, 'replay.supported', errors);
  const baseLocation = safeLocationValue(object.baseLocation, 'replay.baseLocation', errors);
  const headLocation = safeLocationValue(object.headLocation, 'replay.headLocation', errors);
  const confirmation = booleanValue(
    object.requiresExplicitConfirmation,
    'replay.requiresExplicitConfirmation',
    errors,
  );
  const environmentObject = objectValue(
    object.recordedEnvironment,
    'replay.recordedEnvironment',
    ['node', 'platform', 'arch'],
    [],
    errors,
  );
  const node =
    environmentObject === undefined
      ? undefined
      : stringValue(environmentObject.node, 'replay.recordedEnvironment.node', errors, {
          maxLength: 512,
        });
  const platform =
    environmentObject === undefined
      ? undefined
      : stringValue(environmentObject.platform, 'replay.recordedEnvironment.platform', errors, {
          maxLength: 128,
        });
  const arch =
    environmentObject === undefined
      ? undefined
      : stringValue(environmentObject.arch, 'replay.recordedEnvironment.arch', errors, {
          maxLength: 128,
        });
  if (confirmation !== true) errors.push('replay.requiresExplicitConfirmation must be true');
  if (
    supported === undefined ||
    baseLocation === undefined ||
    headLocation === undefined ||
    confirmation !== true ||
    node === undefined ||
    platform === undefined ||
    arch === undefined
  )
    return undefined;
  return {
    supported,
    baseLocation,
    headLocation,
    requiresExplicitConfirmation: true,
    recordedEnvironment: { node, platform, arch },
  };
}

function validateIntegrity(
  value: unknown,
  errors: string[],
): EvidenceBundle['integrity'] | undefined {
  const object = objectValue(
    value,
    'integrity',
    ['algorithm', 'canonicalSha256', 'signer'],
    [],
    errors,
  );
  if (object === undefined) return undefined;
  const algorithm = stringValue(object.algorithm, 'integrity.algorithm', errors);
  const canonicalSha256 = sha256Value(object.canonicalSha256, 'integrity.canonicalSha256', errors);
  if (algorithm !== 'sha256') errors.push('integrity.algorithm must be sha256');
  if (object.signer !== null)
    errors.push('integrity.signer must be null because hashes are not signer identity');
  if (algorithm !== 'sha256' || canonicalSha256 === undefined || object.signer !== null)
    return undefined;
  return { algorithm: 'sha256', canonicalSha256, signer: null };
}

function validateBundleShape(value: unknown, errors: string[]): EvidenceBundle | undefined {
  const root = objectValue(value, 'bundle', TOP_LEVEL_KEYS, [], errors);
  if (root === undefined) return undefined;
  if (root.schemaVersion !== EVIDENCE_SCHEMA_VERSION)
    errors.push(`Unsupported schemaVersion: ${String(root.schemaVersion)}`);
  const product = objectValue(root.product, 'product', ['name', 'version'], [], errors);
  const productName =
    product === undefined ? undefined : stringValue(product.name, 'product.name', errors);
  const productVersion =
    product === undefined
      ? undefined
      : stringValue(product.version, 'product.version', errors, { maxLength: 128 });
  if (productName !== 'PatchProof') errors.push('product.name must be PatchProof');
  if (
    productVersion !== undefined &&
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(productVersion)
  )
    errors.push('product.version must be a release version');
  const bundleId = stringValue(root.bundleId, 'bundleId', errors);
  if (
    bundleId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(bundleId)
  )
    errors.push('bundleId must be a UUID');
  const createdAt = isoTimestamp(root.createdAt, 'createdAt', errors);
  const outcome = stringValue(root.outcome, 'outcome', errors);
  const verdict = stringValue(root.verdict, 'verdict', errors, { maxLength: 4096 });
  const scenario = validateScenario(root.scenario, errors);
  const sourcesObject = objectValue(root.sources, 'sources', ['base', 'head'], [], errors);
  const baseSource =
    sourcesObject === undefined ? undefined : validateSource(sourcesObject.base, 'base', errors);
  const headSource =
    sourcesObject === undefined ? undefined : validateSource(sourcesObject.head, 'head', errors);
  const policy = validatePolicy(root.policy, errors);
  const executionsObject = objectValue(root.executions, 'executions', ['base', 'head'], [], errors);
  const baseExecution =
    executionsObject === undefined
      ? undefined
      : validateExecution(executionsObject.base, 'base', errors);
  const headExecution =
    executionsObject === undefined
      ? undefined
      : validateExecution(executionsObject.head, 'head', errors);
  const artifacts = validateArtifacts(root.artifacts, errors);
  const completeness = validateCompleteness(root.completeness, errors);
  const replay = validateReplay(root.replay, errors);
  const integrity = validateIntegrity(root.integrity, errors);
  if (!RUN_OUTCOMES.includes(outcome as (typeof RUN_OUTCOMES)[number]))
    errors.push('outcome is unsupported');
  if (
    root.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    productName !== 'PatchProof' ||
    productVersion === undefined ||
    bundleId === undefined ||
    createdAt === undefined ||
    outcome === undefined ||
    verdict === undefined ||
    scenario === undefined ||
    baseSource === undefined ||
    headSource === undefined ||
    policy === undefined ||
    baseExecution === undefined ||
    headExecution === undefined ||
    artifacts === undefined ||
    completeness === undefined ||
    replay === undefined ||
    integrity === undefined
  )
    return undefined;
  return {
    schemaVersion: 1,
    product: { name: 'PatchProof', version: productVersion },
    bundleId,
    createdAt,
    outcome: outcome as EvidenceBundle['outcome'],
    verdict,
    scenario,
    sources: { base: baseSource, head: headSource },
    policy,
    executions: { base: baseExecution, head: headExecution },
    artifacts,
    completeness,
    replay,
    integrity,
  };
}

async function safeArtifactPath(
  root: string,
  artifact: ArtifactReference,
): Promise<string | undefined> {
  if (isAbsolute(artifact.relativePath) || win32.isAbsolute(artifact.relativePath))
    return undefined;
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, artifact.relativePath);
  const rel = relative(rootReal, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  let cursor = rootReal;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) return undefined;
    } catch {
      return candidate;
    }
  }
  try {
    const candidateReal = await realpath(candidate);
    const realRel = relative(rootReal, candidateReal);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return undefined;
    return candidateReal;
  } catch {
    return candidate;
  }
}

function logOutput(
  log: LogEvidence,
  artifactBytes: Map<string, Buffer>,
  artifactMediaTypes: Map<string, string>,
  path: string,
  errors: string[],
): string | undefined {
  const bytes = artifactBytes.get(log.artifactId);
  if (bytes === undefined) {
    errors.push(`${path} references an unknown artifact`);
    return undefined;
  }
  if (artifactMediaTypes.get(log.artifactId) !== 'text/plain') {
    errors.push(`${path} must reference a text/plain artifact`);
    return undefined;
  }
  const actualSize = bytes.byteLength;
  if (!log.truncated && log.sizeBytes !== actualSize)
    errors.push(`${path}.sizeBytes must equal its untruncated artifact size`);
  if (log.truncated && log.sizeBytes < actualSize)
    errors.push(`${path}.sizeBytes cannot be smaller than its stored artifact`);
  const text = bytes.toString('utf8');
  const expectedPreview =
    text.length > 2_000 ? `${text.slice(0, 2_000)}\n[preview truncated]` : text;
  if (log.preview !== expectedPreview) errors.push(`${path}.preview does not match its artifact`);
  return text;
}

function verifyCrossReferences(bundle: EvidenceBundle, errors: string[]): void {
  const ids = new Set(bundle.artifacts.map((artifact) => artifact.id));
  const references = [
    ['executions.base.stdout', bundle.executions.base.stdout.artifactId],
    ['executions.base.stderr', bundle.executions.base.stderr.artifactId],
    ['executions.head.stdout', bundle.executions.head.stdout.artifactId],
    ['executions.head.stderr', bundle.executions.head.stderr.artifactId],
  ] as const;
  const seen = new Set<string>();
  for (const [path, id] of references) {
    if (!ids.has(id)) errors.push(`${path} references missing artifact ${id}`);
    if (seen.has(id)) errors.push(`${path} duplicates an artifact reference: ${id}`);
    seen.add(id);
  }
  for (const artifact of bundle.artifacts) {
    if (!seen.has(artifact.id))
      errors.push(`Artifact is not referenced by an execution log: ${artifact.id}`);
  }
}

function verifyScenarioIdentity(bundle: EvidenceBundle, errors: string[]): void {
  const revisions = ['base', 'head'] as const;
  for (const revision of revisions) {
    const execution = bundle.executions[revision];
    if (JSON.stringify(execution.command) !== JSON.stringify(bundle.scenario.command))
      errors.push(`executions.${revision}.command must match scenario.command`);
    if (execution.cwd !== bundle.scenario.cwd)
      errors.push(`executions.${revision}.cwd must match scenario.cwd`);
    if (execution.environment.PATCHPROOF_REVISION !== revision)
      errors.push(`executions.${revision}.environment.PATCHPROOF_REVISION must be ${revision}`);
  }

  const baseEnvironment = bundle.executions.base.environment;
  const headEnvironment = bundle.executions.head.environment;
  const baseKeys = Object.keys(baseEnvironment).sort();
  const headKeys = Object.keys(headEnvironment).sort();
  if (JSON.stringify(baseKeys) !== JSON.stringify(headKeys))
    errors.push('executions.base and executions.head environment keys must match');
  for (const key of new Set([...baseKeys, ...headKeys])) {
    if (key === 'PATCHPROOF_REVISION') continue;
    if (baseEnvironment[key] !== headEnvironment[key])
      errors.push(`executions.base and executions.head environment.${key} must match`);
  }
  if (bundle.policy.backend === 'docker') {
    const baseImage = bundle.executions.base.toolchain.containerImage;
    const headImage = bundle.executions.head.toolchain.containerImage;
    if (baseImage === undefined || headImage === undefined)
      errors.push('Docker executions must record containerImage for both revisions');
    else if (baseImage !== headImage)
      errors.push('Docker executions must use the same containerImage');
  }
}

function verifyPolicyDeniedPath(bundle: EvidenceBundle, errors: string[]): void {
  if (bundle.outcome !== 'POLICY_DENIED') {
    if (bundle.policy.denialReason !== undefined)
      errors.push('policy.denialReason is only valid for POLICY_DENIED bundles');
    return;
  }
  if (bundle.policy.denialReason === undefined)
    errors.push('POLICY_DENIED bundles require policy.denialReason');
  if (bundle.completeness.complete)
    errors.push('POLICY_DENIED bundles must not claim complete executions');
  if (
    !bundle.completeness.missing.includes('baseExecution') ||
    !bundle.completeness.missing.includes('headExecution')
  )
    errors.push('POLICY_DENIED bundles must identify both missing executions');
  for (const revision of ['base', 'head'] as const) {
    const execution = bundle.executions[revision];
    if (execution.exitCode !== null || execution.timedOut || execution.error === undefined)
      errors.push(`POLICY_DENIED ${revision} execution must be an explicit non-execution record`);
    if (
      bundle.policy.denialReason !== undefined &&
      execution.error !== undefined &&
      !execution.error.includes(bundle.policy.denialReason)
    )
      errors.push(`POLICY_DENIED ${revision} execution does not record the policy reason`);
  }
}

export async function verifyEvidenceBundle(bundlePath: string): Promise<VerificationResult> {
  const errors: string[] = [];
  let source: string;
  try {
    source = await readFile(bundlePath, 'utf8');
  } catch (error) {
    return {
      valid: false,
      schemaSupported: false,
      digestValid: false,
      artifactsValid: false,
      completenessValid: false,
      errors: [
        `Cannot read evidence JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  for (const key of duplicateJsonKeys(source))
    errors.push(`Evidence JSON contains a duplicate object key: ${JSON.stringify(key)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    return {
      valid: false,
      schemaSupported: false,
      digestValid: false,
      artifactsValid: false,
      completenessValid: false,
      errors: [
        ...errors,
        `Cannot parse evidence JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const schemaSupported = isRecord(parsed) && parsed.schemaVersion === EVIDENCE_SCHEMA_VERSION;
  const bundle = validateBundleShape(parsed, errors);
  if (bundle === undefined || !schemaSupported) {
    return {
      valid: false,
      schemaSupported,
      digestValid: false,
      artifactsValid: false,
      completenessValid: false,
      errors,
    };
  }

  let digestValid = false;
  try {
    digestValid =
      evidenceDigest(bundle as unknown as { integrity: unknown; [key: string]: unknown }) ===
      bundle.integrity.canonicalSha256;
  } catch (error) {
    errors.push(
      `Cannot calculate canonical digest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!digestValid) errors.push('Canonical SHA-256 digest does not match');

  let artifactsValid = true;
  const artifactBytes = new Map<string, Buffer>();
  const artifactMediaTypes = new Map<string, string>();
  let root: string;
  try {
    root = dirname(await realpath(bundlePath));
  } catch (error) {
    return {
      valid: false,
      schemaSupported: true,
      digestValid,
      artifactsValid: false,
      completenessValid: false,
      errors: [
        ...errors,
        `Cannot resolve evidence root: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  for (const artifact of bundle.artifacts) {
    const artifactPath = await safeArtifactPath(root, artifact);
    if (artifactPath === undefined) {
      artifactsValid = false;
      errors.push(`Unsafe artifact path: ${artifact.relativePath}`);
      continue;
    }
    try {
      if ((await lstat(artifactPath)).isSymbolicLink()) {
        artifactsValid = false;
        errors.push(`Symbolic-link artifacts are not accepted: ${artifact.relativePath}`);
        continue;
      }
      const bytes = await readFile(artifactPath);
      if (bytes.byteLength !== artifact.sizeBytes) {
        artifactsValid = false;
        errors.push(`Artifact size mismatch: ${artifact.relativePath}`);
      }
      if (sha256(bytes) !== artifact.sha256) {
        artifactsValid = false;
        errors.push(`Artifact SHA-256 mismatch: ${artifact.relativePath}`);
      }
      artifactBytes.set(artifact.id, bytes);
      artifactMediaTypes.set(artifact.id, artifact.mediaType);
    } catch (error) {
      artifactsValid = false;
      errors.push(
        `Missing artifact ${artifact.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  verifyCrossReferences(bundle, errors);
  verifyScenarioIdentity(bundle, errors);
  const baseStdout = logOutput(
    bundle.executions.base.stdout,
    artifactBytes,
    artifactMediaTypes,
    'executions.base.stdout',
    errors,
  );
  const baseStderr = logOutput(
    bundle.executions.base.stderr,
    artifactBytes,
    artifactMediaTypes,
    'executions.base.stderr',
    errors,
  );
  const headStdout = logOutput(
    bundle.executions.head.stdout,
    artifactBytes,
    artifactMediaTypes,
    'executions.head.stdout',
    errors,
  );
  const headStderr = logOutput(
    bundle.executions.head.stderr,
    artifactBytes,
    artifactMediaTypes,
    'executions.head.stderr',
    errors,
  );
  verifyPolicyDeniedPath(bundle, errors);

  if (
    baseStdout !== undefined &&
    baseStderr !== undefined &&
    headStdout !== undefined &&
    headStderr !== undefined
  ) {
    const classification = classifyOutcome({
      base: {
        exitCode: bundle.executions.base.exitCode,
        timedOut: bundle.executions.base.timedOut,
        ...(bundle.executions.base.error === undefined
          ? {}
          : { error: bundle.executions.base.error }),
        output: `${baseStdout}\n${baseStderr}`,
      },
      head: {
        exitCode: bundle.executions.head.exitCode,
        timedOut: bundle.executions.head.timedOut,
        ...(bundle.executions.head.error === undefined
          ? {}
          : { error: bundle.executions.head.error }),
        output: `${headStdout}\n${headStderr}`,
      },
      expectedFailure: bundle.scenario.expectedFailure,
      ...(bundle.policy.denialReason === undefined
        ? {}
        : { policyDenied: bundle.policy.denialReason }),
      complete: bundle.completeness.complete,
    });
    if (classification.outcome !== bundle.outcome)
      errors.push(
        `Outcome does not match executions and policy: expected ${classification.outcome}, found ${bundle.outcome}`,
      );
    if (classification.verdict !== bundle.verdict)
      errors.push('Verdict does not match the deterministic outcome classification');
  }

  const completenessValid = errors.every((error) => !error.startsWith('completeness.'));
  return {
    valid: errors.length === 0 && digestValid && artifactsValid && completenessValid,
    schemaSupported: true,
    digestValid,
    artifactsValid,
    completenessValid,
    errors,
  };
}

export function createIntegrity(
  bundle: Omit<EvidenceBundle, 'integrity'>,
): EvidenceBundle['integrity'] {
  const withoutIntegrity = {
    ...bundle,
    integrity: { algorithm: 'sha256', canonicalSha256: null, signer: null },
  };
  return { algorithm: 'sha256', canonicalSha256: evidenceDigest(withoutIntegrity), signer: null };
}
