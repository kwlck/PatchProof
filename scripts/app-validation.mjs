import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

export const VALIDATION_ENV_NAMES = Object.freeze([
  'PATCHPROOF_VALIDATION_APP_PRIVATE_KEY',
  'PATCHPROOF_VALIDATION_WEBHOOK_SECRET',
  'APP_ID',
  'INSTALLATION_ID',
  'REPOSITORY',
  'PR_NUMBER',
  'BASE_REF',
  'BASE_SHA',
  'HEAD_SHA',
  'PATCHPROOF_SHA',
]);

export const VALIDATION_SUMMARY_NAME = 'patchproof-app-validation-summary.json';
export const VALIDATION_EXIT_CODES = Object.freeze({
  success: 0,
  preflight: 2,
  validation: 1,
});

const MAX_PRIVATE_KEY_BYTES = 128 * 1024;
const MAX_WEBHOOK_SECRET_LENGTH = 16 * 1024;
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const ID_PATTERN = /^[1-9][0-9]*$/u;
const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu;
const REPOSITORY_PATTERN = /^[a-z0-9_.-]{1,100}$/iu;
const IMAGE_TAG_PATTERN = /^patchproof-app-validation-probe-[0-9a-f]{32}$/u;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/iu;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RECONCILIATION_PAGE_SIZE = 100;
const MAX_RECONCILIATION_PAGES = 20;
const VALIDATION_MUTATION_METHODS = Object.freeze([
  'createCheck',
  'updateCheck',
  'createComment',
  'updateComment',
]);

/**
 * Errors from this module are intentionally bounded and never carry provider
 * responses, private keys, installation tokens, or command output.
 */
export class AppValidationError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppValidationError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new AppValidationError(code, message, cause);
}

function hasControlCharacters(value, allowLineBreaks = false) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      (code === 0x7f || (code <= 0x1f && !(allowLineBreaks && (code === 0x0a || code === 0x0d))))
    )
      return true;
  }
  return false;
}

function requiredEnvironmentValue(environment, name, allowLineBreaks = false) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0)
    fail('preflight', `Required validation environment value is missing: ${name}`);
  if (hasControlCharacters(value, allowLineBreaks))
    fail('preflight', `Validation environment value is invalid: ${name}`);
  return value;
}

function canonicalPositiveId(raw, name) {
  if (!ID_PATTERN.test(raw)) fail('preflight', `Validation identity is invalid: ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== raw)
    fail('preflight', `Validation identity is not canonical: ${name}`);
  return value;
}

export function canonicalRepository(raw) {
  if (typeof raw !== 'string' || hasControlCharacters(raw))
    fail('preflight', 'Validation repository identity is invalid');
  const separator = raw.indexOf('/');
  if (
    separator < 1 ||
    separator !== raw.lastIndexOf('/') ||
    separator === raw.length - 1 ||
    !OWNER_PATTERN.test(raw.slice(0, separator)) ||
    !REPOSITORY_PATTERN.test(raw.slice(separator + 1))
  )
    fail('preflight', 'Validation repository identity is invalid');
  // Preserve GitHub's displayed owner/repository casing. GitHub treats names
  // case-insensitively, but the production transport deliberately compares
  // the API's full_name exactly before accepting a snapshot.
  return raw;
}

export function canonicalSha(raw, name) {
  if (typeof raw !== 'string' || !SHA_PATTERN.test(raw))
    fail('preflight', `Validation SHA is invalid: ${name}`);
  return raw.toLowerCase();
}

function canonicalRef(raw) {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > 255 ||
    hasControlCharacters(raw) ||
    raw.includes('..') ||
    raw.includes('@{') ||
    raw.includes('\\') ||
    raw.includes('//') ||
    raw.startsWith('/') ||
    raw.endsWith('/') ||
    raw.endsWith('.') ||
    raw.endsWith(' ') ||
    /[~^:?*\[]/u.test(raw)
  )
    fail('preflight', 'Validation base ref is invalid');
  return raw;
}

function normalizePrivateKey(raw) {
  const value = raw.replaceAll('\\n', '\n').trim();
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PRIVATE_KEY_BYTES ||
    hasControlCharacters(value, true) ||
    !/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----$/u.test(value)
  )
    fail('preflight', 'Validation App private key is invalid');
  return value;
}

function canonicalRunnerTemp(environment) {
  const value = environment.RUNNER_TEMP;
  if (value === undefined) return resolve(tmpdir());
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    hasControlCharacters(value) ||
    !isAbsolute(value)
  )
    fail('preflight', 'Runner temporary directory is invalid');
  const resolved = resolve(value);
  if (!isAbsolute(resolved)) fail('preflight', 'Runner temporary directory is invalid');
  return resolved;
}

/**
 * Parse and canonicalize the fixed protected-workflow identity contract.  No
 * filesystem, network, Docker, or GitHub operation is performed here.
 */
export function parseValidationEnvironment(environment = process.env) {
  const privateKey = normalizePrivateKey(
    requiredEnvironmentValue(environment, 'PATCHPROOF_VALIDATION_APP_PRIVATE_KEY', true),
  );
  const webhookSecret = requiredEnvironmentValue(
    environment,
    'PATCHPROOF_VALIDATION_WEBHOOK_SECRET',
  );
  if (
    webhookSecret.length < 16 ||
    webhookSecret.length > MAX_WEBHOOK_SECRET_LENGTH ||
    hasControlCharacters(webhookSecret)
  )
    fail('preflight', 'Validation webhook secret is invalid');
  const appId = canonicalPositiveId(requiredEnvironmentValue(environment, 'APP_ID'), 'APP_ID');
  const installationId = canonicalPositiveId(
    requiredEnvironmentValue(environment, 'INSTALLATION_ID'),
    'INSTALLATION_ID',
  );
  const pullRequest = canonicalPositiveId(
    requiredEnvironmentValue(environment, 'PR_NUMBER'),
    'PR_NUMBER',
  );
  const repository = canonicalRepository(requiredEnvironmentValue(environment, 'REPOSITORY'));
  const baseRef = canonicalRef(requiredEnvironmentValue(environment, 'BASE_REF'));
  const baseSha = canonicalSha(requiredEnvironmentValue(environment, 'BASE_SHA'), 'BASE_SHA');
  const headSha = canonicalSha(requiredEnvironmentValue(environment, 'HEAD_SHA'), 'HEAD_SHA');
  const patchproofSha = canonicalSha(
    requiredEnvironmentValue(environment, 'PATCHPROOF_SHA'),
    'PATCHPROOF_SHA',
  );
  return Object.freeze({
    privateKey,
    webhookSecret,
    appId,
    installationId,
    repository,
    pullRequest,
    baseRef,
    baseSha,
    headSha,
    patchproofSha,
    runnerTemp: canonicalRunnerTemp(environment),
  });
}

export function assertNoValidationArguments(arguments_ = process.argv.slice(2)) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0)
    fail('preflight', 'The App validation harness does not accept command-line arguments');
}

function sanitizeMessage(value) {
  return String(value)
    .replaceAll(/-----BEGIN[\s\S]*?-----END[^-]*-----/giu, '[credential omitted]')
    .replaceAll(/Authorization\s*:\s*Bearer\s+[^\s`]+/giu, 'Authorization: [credential omitted]')
    .replaceAll(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/gu, '[credential omitted]')
    .replaceAll(/[\r\n]+/gu, ' ')
    .slice(0, 512);
}

function errorForOperator(error) {
  if (error instanceof AppValidationError) return error.message;
  return 'App validation failed';
}

function secretPatternMatch(text, secrets = []) {
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0 && text.includes(secret)) return secret;
  }
  if (/-----BEGIN (?:RSA )?PRIVATE KEY-----/u.test(text)) return 'PEM marker';
  if (/-----END (?:RSA )?PRIVATE KEY-----/u.test(text)) return 'PEM marker';
  if (/(?:^|\s)Bearer\s+[A-Za-z0-9._~+/=-]{8,}/iu.test(text)) return 'Bearer token';
  if (/Authorization\s*:\s*Bearer\s+/iu.test(text)) return 'Authorization header';
  if (/(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/u.test(text))
    return 'GitHub token prefix';
  // JWT-shaped values are prohibited even when their signing key is unknown.
  if (
    /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/u.test(
      text,
    )
  )
    return 'JWT-shaped credential';
  return undefined;
}

export function assertSecretFreeText(value, secrets = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') fail('validation', 'Evidence value could not be serialized');
  const match = secretPatternMatch(text, secrets);
  if (match !== undefined) fail('validation', `Secret-bearing evidence was suppressed (${match})`);
  return text;
}

function exactRecord(value, keys, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('validation', `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail('validation', `${path} contains an unexpected field`);
  return value;
}

function assertBoundedString(value, path, maximum = 512) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    hasControlCharacters(value)
  )
    fail('validation', `${path} is invalid`);
  return value;
}

function assertIso(value, path) {
  assertBoundedString(value, path, 32);
  if (!ISO_PATTERN.test(value) || !Number.isFinite(Date.parse(value)))
    fail('validation', `${path} is invalid`);
}

function assertSummaryIdentity(value, path, pattern) {
  assertBoundedString(value, path, 512);
  if (!pattern.test(value)) fail('validation', `${path} is invalid`);
}

/** Validate the deliberately closed summary schema before it reaches RUNNER_TEMP. */
export function validateValidationSummary(summary, secrets = []) {
  const root = exactRecord(
    summary,
    [
      'schemaVersion',
      'patchproofSha',
      'runId',
      'repository',
      'pullRequest',
      'baseRef',
      'baseSha',
      'headSha',
      'deliveryId',
      'terminalState',
      'attemptState',
      'check',
      'comment',
      'evidence',
      'duplicate',
      'docker',
      'timestamps',
      'cleanup',
    ],
    'summary',
  );
  if (root.schemaVersion !== 1) fail('validation', 'Summary schema version is invalid');
  assertSummaryIdentity(root.patchproofSha, 'summary.patchproofSha', SHA_PATTERN);
  assertSummaryIdentity(root.runId, 'summary.runId', UUID_PATTERN);
  assertSummaryIdentity(
    root.repository,
    'summary.repository',
    /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/iu,
  );
  if (!Number.isSafeInteger(root.pullRequest) || root.pullRequest < 1)
    fail('validation', 'summary.pullRequest is invalid');
  assertBoundedString(root.baseRef, 'summary.baseRef', 255);
  assertSummaryIdentity(root.baseSha, 'summary.baseSha', SHA_PATTERN);
  assertSummaryIdentity(root.headSha, 'summary.headSha', SHA_PATTERN);
  assertSummaryIdentity(root.deliveryId, 'summary.deliveryId', UUID_PATTERN);
  if (root.terminalState !== 'completed' || root.attemptState !== 'succeeded')
    fail('validation', 'Summary terminal state is invalid');

  const check = exactRecord(root.check, ['id', 'appId', 'ownership', 'headSha'], 'summary.check');
  const comment = exactRecord(root.comment, ['id', 'appId', 'ownership'], 'summary.comment');
  for (const [item, path] of [
    [check, 'summary.check'],
    [comment, 'summary.comment'],
  ]) {
    if (
      !Number.isSafeInteger(item.id) ||
      item.id < 1 ||
      !Number.isSafeInteger(item.appId) ||
      item.appId < 1
    )
      fail('validation', `${path} identity is invalid`);
    if (item.ownership !== 'app') fail('validation', `${path}.ownership is invalid`);
  }
  assertSummaryIdentity(check.headSha, 'summary.check.headSha', SHA_PATTERN);
  if (check.headSha !== root.headSha) fail('validation', 'Summary Check head identity is invalid');

  const evidence = exactRecord(root.evidence, ['sha256', 'result'], 'summary.evidence');
  assertSummaryIdentity(evidence.sha256, 'summary.evidence.sha256', /^[0-9a-f]{64}$/iu);
  if (!['PASS', 'FAIL', 'INCONCLUSIVE', 'INFRA_ERROR', 'POLICY_DENIED'].includes(evidence.result))
    fail('validation', 'Summary evidence result is invalid');

  const duplicate = exactRecord(
    root.duplicate,
    ['status', 'queuedJobs', 'workerAttempts', 'mutations'],
    'summary.duplicate',
  );
  if (
    duplicate.status !== 'ignored' ||
    duplicate.queuedJobs !== 1 ||
    duplicate.workerAttempts !== 1 ||
    duplicate.mutations !== 0
  )
    fail('validation', 'Summary duplicate result is invalid');

  const docker = exactRecord(
    root.docker,
    [
      'image',
      'imageId',
      'network',
      'user',
      'readOnlyRoot',
      'capDrop',
      'noNewPrivileges',
      'resourceBounds',
      'residualContainers',
    ],
    'summary.docker',
  );
  if (!IMAGE_TAG_PATTERN.test(docker.image) || !IMAGE_ID_PATTERN.test(docker.imageId))
    fail('validation', 'Summary Docker image identity is invalid');
  if (
    docker.network !== 'none' ||
    docker.user !== '65532:65532' ||
    docker.readOnlyRoot !== true ||
    docker.capDrop !== 'ALL' ||
    docker.noNewPrivileges !== true ||
    docker.residualContainers !== 0
  )
    fail('validation', 'Summary Docker assertions are invalid');
  const bounds = exactRecord(
    docker.resourceBounds,
    ['memoryMb', 'cpuCount', 'pids'],
    'summary.docker.resourceBounds',
  );
  if (
    !Number.isSafeInteger(bounds.memoryMb) ||
    bounds.memoryMb < 1 ||
    !Number.isSafeInteger(bounds.cpuCount) ||
    bounds.cpuCount < 1 ||
    !Number.isSafeInteger(bounds.pids) ||
    bounds.pids < 1
  )
    fail('validation', 'Summary Docker resource bounds are invalid');

  const timestamps = exactRecord(
    root.timestamps,
    ['startedAt', 'finishedAt'],
    'summary.timestamps',
  );
  assertIso(timestamps.startedAt, 'summary.timestamps.startedAt');
  assertIso(timestamps.finishedAt, 'summary.timestamps.finishedAt');
  const cleanup = exactRecord(root.cleanup, ['ok', 'residualCount'], 'summary.cleanup');
  if (cleanup.ok !== true || cleanup.residualCount !== 0)
    fail('validation', 'Summary cleanup outcome is invalid');
  const text = JSON.stringify(summary);
  if (Buffer.byteLength(text, 'utf8') > MAX_SUMMARY_BYTES)
    fail('validation', 'Summary exceeds its size bound');
  assertSecretFreeText(text, secrets);
  return summary;
}

export function serializeValidationSummary(summary, secrets = []) {
  validateValidationSummary(summary, secrets);
  const text = JSON.stringify(summary) + '\n';
  if (Buffer.byteLength(text, 'utf8') > MAX_SUMMARY_BYTES)
    fail('validation', 'Summary exceeds its size bound');
  assertSecretFreeText(text, secrets);
  return text;
}

export function summaryPath(runnerTemp) {
  if (typeof runnerTemp !== 'string' || !isAbsolute(runnerTemp) || hasControlCharacters(runnerTemp))
    fail('preflight', 'Runner temporary directory is invalid');
  return join(resolve(runnerTemp), VALIDATION_SUMMARY_NAME);
}

export async function writeValidationSummary(summary, runnerTemp, secrets = []) {
  const text = serializeValidationSummary(summary, secrets);
  const destination = summaryPath(runnerTemp);
  await mkdir(resolve(runnerTemp), { recursive: true, mode: 0o700 });
  const temporary = join(resolve(runnerTemp), `.${VALIDATION_SUMMARY_NAME}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    fail('validation', 'Validation summary could not be written', error);
  }
}

function assertCurrentCheckoutSha(repositoryRoot, patchproofSha) {
  return execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryRoot,
    env: safeToolEnvironment(),
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  })
    .then(({ stdout }) => {
      const actual = stdout.trim().toLowerCase();
      if (!SHA_PATTERN.test(actual) || actual !== patchproofSha)
        fail('preflight', 'Current checkout SHA does not match PATCHPROOF_SHA');
      return actual;
    })
    .catch((error) => {
      if (error instanceof AppValidationError) throw error;
      fail('preflight', 'Current checkout SHA could not be verified', error);
    });
}

function safeToolEnvironment() {
  const allowed = new Set(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => allowed.has(name) && typeof value === 'string',
    ),
  );
}

export function buildValidationImageCommand(context, dockerfile, tag) {
  if (!isAbsolute(context) || !isAbsolute(dockerfile) || !IMAGE_TAG_PATTERN.test(tag))
    fail('validation', 'Validation Docker image specification is invalid');
  return [
    'docker',
    'build',
    '--pull=false',
    '--network',
    'none',
    '--file',
    dockerfile,
    '--tag',
    tag,
    context,
  ];
}

export function buildValidationImageInspectCommand(tag) {
  if (!IMAGE_TAG_PATTERN.test(tag) && !IMAGE_ID_PATTERN.test(tag))
    fail('validation', 'Validation Docker image identity is invalid');
  return ['docker', 'image', 'inspect', '--format', '{{.Id}}', tag];
}

export function buildValidationImageRemoveCommand(tag) {
  if (!IMAGE_TAG_PATTERN.test(tag) && !IMAGE_ID_PATTERN.test(tag))
    fail('validation', 'Validation Docker image identity is invalid');
  return ['docker', 'image', 'rm', '--force', tag];
}

export function buildValidationContainerListCommand() {
  return ['docker', 'container', 'ls', '--all', '--format', '{{.Names}}'];
}

export function buildValidationImageInventoryCommand() {
  return [
    'docker',
    'image',
    'ls',
    '--all',
    '--no-trunc',
    '--format',
    '{{.Repository}}:{{.Tag}}\\t{{.ID}}',
  ];
}

async function fixedCommand(file, arguments_, options = {}) {
  try {
    return await execFileAsync(file, arguments_, {
      cwd: options.cwd,
      env: options.environment ?? safeToolEnvironment(),
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: options.maxBuffer ?? 1_048_576,
    });
  } catch (error) {
    fail('validation', `Validation ${options.label ?? 'command'} failed`, error);
  }
}

function validateImageInventory(entries) {
  if (!Array.isArray(entries)) fail('validation', 'Docker image inventory is invalid');
  return entries.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.reference !== 'string' ||
      typeof entry.id !== 'string' ||
      entry.reference.length === 0 ||
      hasControlCharacters(entry.reference) ||
      !IMAGE_ID_PATTERN.test(entry.id)
    )
      fail('validation', 'Docker image inventory is invalid');
    return Object.freeze({ reference: entry.reference, id: entry.id.toLowerCase() });
  });
}

export async function listValidationImages(command = fixedCommand) {
  const result = await command('docker', buildValidationImageInventoryCommand(), {
    label: 'Docker image inventory',
  });
  if (typeof result?.stdout !== 'string') fail('validation', 'Docker image inventory is invalid');
  const entries = [];
  for (const line of result.stdout.split(/\r?\n/u).filter((value) => value.length > 0)) {
    const fields = line.split('\t');
    if (fields.length !== 2) fail('validation', 'Docker image inventory is invalid');
    entries.push({ reference: fields[0], id: fields[1] });
  }
  return validateImageInventory(entries);
}

function imageInventoryMatches(entries, reference) {
  if (IMAGE_ID_PATTERN.test(reference)) {
    const expectedId = reference.toLowerCase();
    return entries.some((entry) => entry.id === expectedId);
  }
  return entries.some(
    (entry) =>
      entry.reference === reference ||
      entry.reference.startsWith(`${reference}:`) ||
      entry.reference.startsWith(`${reference}@`),
  );
}

export async function cleanupValidationImage({ tag, imageId }, options = {}) {
  if (!IMAGE_TAG_PATTERN.test(tag) || (imageId !== undefined && !IMAGE_ID_PATTERN.test(imageId)))
    fail('validation', 'Validation Docker image identity is invalid');
  const command = options.command ?? fixedCommand;
  const listImages = options.listImages ?? (() => listValidationImages(command));
  const inventory = async () => {
    try {
      return validateImageInventory(await listImages());
    } catch (error) {
      if (error instanceof AppValidationError) throw error;
      fail('validation', 'Docker image inventory failed', error);
    }
  };

  let current = await inventory();
  const references = [tag];
  if (imageId !== undefined) references.push(imageId);
  for (const entry of current) {
    if (imageInventoryMatches([entry], tag) && !references.includes(entry.id))
      references.push(entry.id);
  }
  for (const reference of references) {
    if (!imageInventoryMatches(current, reference)) continue;
    try {
      await command('docker', buildValidationImageRemoveCommand(reference), {
        label: 'Docker validation-image cleanup',
      });
    } catch (error) {
      if (error instanceof AppValidationError) throw error;
      fail('validation', 'Docker validation-image cleanup failed', error);
    }
    // Refresh the authoritative daemon inventory before attempting the next
    // reference. Removing a tag can already remove the image ID as well.
    current = await inventory();
  }
  const residual = current.filter((entry) =>
    references.some((reference) => imageInventoryMatches([entry], reference)),
  );
  if (residual.length !== 0) fail('validation', 'Validation image remained after cleanup');
  return residual.length;
}

/**
 * Count mutating calls while preserving the real production transport and its
 * App-authenticated request implementation. The proxy never records method
 * arguments or return values, so credentials cannot enter the test evidence.
 */
export function instrumentProductionTransport(transport) {
  if (typeof transport !== 'object' || transport === null)
    fail('validation', 'Production GitHub transport is invalid');
  const counts = Object.fromEntries(VALIDATION_MUTATION_METHODS.map((name) => [name, 0]));
  const mutationNames = new Set(VALIDATION_MUTATION_METHODS);
  const instrumented = new Proxy(transport, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property === 'string' && mutationNames.has(property)) {
        if (typeof value !== 'function')
          fail('validation', `Production GitHub transport method is invalid: ${property}`);
        return (...arguments_) => {
          counts[property] += 1;
          return Reflect.apply(value, target, arguments_);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    transport: instrumented,
    counts,
    mutationCount: () =>
      VALIDATION_MUTATION_METHODS.reduce((total, name) => total + counts[name], 0),
  });
}

async function inspectLocalImage(tag) {
  if (!IMAGE_TAG_PATTERN.test(tag) && !IMAGE_ID_PATTERN.test(tag))
    fail('validation', 'Validation Docker image identity is invalid');
  const result = await fixedCommand('docker', buildValidationImageInspectCommand(tag), {
    label: 'Docker image inspection',
  });
  const value = result.stdout.trim();
  if (!IMAGE_ID_PATTERN.test(value)) fail('validation', 'Validation image identity is invalid');
  return value.toLowerCase();
}

async function listDockerContainers() {
  const result = await fixedCommand('docker', buildValidationContainerListCommand(), {
    label: 'Docker residual inspection',
  });
  return new Set(
    result.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => /^patchproof-(?:base|head)-[0-9a-f]{32}$/iu.test(value)),
  );
}

export async function cleanupValidationContainers(before, options = {}) {
  const listContainers = options.listContainers ?? listDockerContainers;
  const command = options.command ?? fixedCommand;
  let after;
  try {
    after = await listContainers();
  } catch (error) {
    fail('validation', 'Docker residual inspection failed', error);
  }
  const newContainers = [...after].filter((name) => !before.has(name));
  let failed = false;
  for (const name of newContainers) {
    if (!/^patchproof-(?:base|head)-[0-9a-f]{32}$/iu.test(name)) {
      failed = true;
      continue;
    }
    try {
      await command('docker', ['container', 'rm', '--force', name], {
        label: 'Docker validation-container cleanup',
      });
    } catch {
      failed = true;
    }
  }
  let residual = 0;
  try {
    const final = await listContainers();
    residual = [...final].filter((name) => !before.has(name)).length;
  } catch {
    failed = true;
  }
  if (failed || residual !== 0) fail('validation', 'Docker validation-container cleanup failed');
  return residual;
}

export async function buildValidationImage({
  validationRoot,
  repositoryRoot,
  runId,
  command = fixedCommand,
}) {
  const tag = `patchproof-app-validation-probe-${runId.replaceAll('-', '')}`;
  if (!IMAGE_TAG_PATTERN.test(tag)) fail('validation', 'Validation Docker image tag is invalid');
  const context = join(validationRoot, 'image-context');
  await mkdir(context, { recursive: true, mode: 0o700 });
  const fixtureRoot = join(repositoryRoot, 'test', 'fixtures', 'app-validation');
  const source = join(fixtureRoot, 'probe.c');
  const dockerfileSource = join(fixtureRoot, 'Dockerfile');
  const binary = join(context, 'probe');
  const dockerfile = join(context, 'Dockerfile');
  await access(source);
  await access(dockerfileSource);
  await cp(dockerfileSource, dockerfile, { force: true, errorOnExist: false });
  let compiled = false;
  let lastError;
  for (const compiler of ['cc', 'gcc']) {
    try {
      await command(compiler, ['-std=c11', '-O2', '-static', '-s', '-o', binary, source], {
        cwd: repositoryRoot,
        label: 'validation probe compilation',
      });
      compiled = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!compiled)
    fail('validation', 'A static C compiler is required for the validation probe', lastError);
  if (process.platform !== 'win32') await chmod(binary, 0o755);
  const imageCommand = buildValidationImageCommand(context, dockerfile, tag);
  await command(imageCommand[0], imageCommand.slice(1), {
    cwd: repositoryRoot,
    label: 'Docker image build',
  });
  const imageId = await inspectLocalImage(tag);
  return Object.freeze({ tag, imageId, context, dockerfile });
}

export function buildValidationConfig(imageTag) {
  if (!IMAGE_TAG_PATTERN.test(imageTag) && !IMAGE_ID_PATTERN.test(imageTag))
    fail('validation', 'Validation Docker image identity is invalid');
  return [
    'version: 1',
    'name: PatchProof App validation probe',
    'scenario:',
    '  id: app-validation-probe',
    '  name: First-party App validation isolation probe',
    '  command: [/probe]',
    '  cwd: .',
    '  expectedFailure:',
    '    exitCode: 1',
    '    reasonPattern: EXPECTED_BUG',
    'policy:',
    '  backend: docker',
    '  allowUnsafeLocal: false',
    '  allowFork: false',
    '  network: none',
    '  allowedHosts: []',
    '  timeoutMs: 10000',
    '  outputBytes: 8192',
    '  memoryMb: 64',
    '  cpuCount: 1',
    '  pids: 32',
    `  dockerImage: ${imageTag}`,
    '  readOnlyRoot: true',
    'redaction:',
    '  secrets: []',
    '',
  ].join('\n');
}

function assertWithin(root, candidate, label) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (
    rel === '' ||
    rel.startsWith('..') ||
    rel.includes('..\\') ||
    rel.includes('../') ||
    !isAbsolute(rootPath)
  )
    fail('validation', `${label} is outside the validation workspace`);
  return candidatePath;
}

export class FixtureOverlaySourceAdapter {
  constructor(
    productionSource,
    fixtureRoot,
    validationRoot,
    repository,
    baseSha,
    headSha,
    configText,
  ) {
    this.productionSource = productionSource;
    this.fixtureRoot = fixtureRoot;
    this.validationRoot = validationRoot;
    this.repository = repository;
    this.baseSha = baseSha;
    this.headSha = headSha;
    this.configText = configText;
  }

  async materializeRevision(repository, sha, destination, options = {}) {
    if (repository !== this.repository || (sha !== this.baseSha && sha !== this.headSha))
      fail('validation', 'Validation source identity was not allowlisted');
    const staging = await mkdtemp(join(this.validationRoot, 'fetched-source-'));
    try {
      /* This is the production GitHubSourceAdapter call; fetched PR code is never executed. */
      await this.productionSource.materializeRevision(repository, sha, staging, options);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await cp(this.fixtureRoot, destination, { recursive: true, dereference: false, force: true });
      await writeFile(join(destination, '.patchproof.yml'), this.configText, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

function apiPathForRepository(repository) {
  const separator = repository.indexOf('/');
  const owner = repository.slice(0, separator);
  const name = repository.slice(separator + 1);
  return `/repos/${owner}/${name}`;
}

function assertReadPath(pathname) {
  if (
    typeof pathname !== 'string' ||
    !pathname.startsWith('/') ||
    pathname.includes('..') ||
    pathname.includes('\\') ||
    pathname.includes('\u0000') ||
    pathname.includes('#') ||
    pathname.includes('://')
  )
    fail('validation', 'GitHub read endpoint is invalid');
  return pathname;
}

function responseHasNextPage(headers) {
  const link = headers.get('link');
  return (
    typeof link === 'string' &&
    /(?:^|,)\s*<[^>]+>\s*;\s*rel\s*=\s*["']?next["']?(?:\s*,|$)/iu.test(link)
  );
}

async function readGitHubJson(pathname, token, options = {}) {
  assertReadPath(pathname);
  if (typeof token !== 'string' || token.length === 0 || token.length > 16_384)
    fail('validation', 'GitHub installation credential is invalid');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com${pathname}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'PatchProof-App-Validation/0.1.0',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) fail('validation', 'GitHub protected preflight read failed');
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_HTTP_BODY_BYTES)
      fail('validation', 'GitHub protected preflight response was too large');
    try {
      const parsed = JSON.parse(body);
      return options.includeMetadata
        ? Object.freeze({ body: parsed, hasNext: responseHasNextPage(response.headers) })
        : parsed;
    } catch (error) {
      fail('validation', 'GitHub protected preflight response was invalid', error);
    }
  } catch (error) {
    if (error instanceof AppValidationError) throw error;
    fail('validation', 'GitHub protected preflight read failed', error);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Enumerate a paginated GitHub collection with a hard page bound. A complete
 * short page, an authoritative total count, or an empty page ends traversal;
 * an inconsistent or truncated response fails closed instead of reconciling
 * only the first page.
 */
export async function collectBoundedPages(fetchPage, options = {}) {
  if (typeof fetchPage !== 'function') fail('validation', 'Pagination fetcher is invalid');
  const label = options.label ?? 'GitHub collection';
  const pageSize = options.pageSize ?? RECONCILIATION_PAGE_SIZE;
  const maxPages = options.maxPages ?? MAX_RECONCILIATION_PAGES;
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1
  )
    fail('validation', 'Pagination bounds are invalid');
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    let response;
    try {
      response = await fetchPage(page);
    } catch (error) {
      if (error instanceof AppValidationError) throw error;
      fail('validation', `${label} page could not be fetched`, error);
    }
    if (typeof response !== 'object' || response === null || !Array.isArray(response.items))
      fail('validation', `${label} pagination response is invalid`);
    if (response.items.length > pageSize)
      fail('validation', `${label} pagination page exceeds its bound`);
    const total = response.total;
    if (
      total !== undefined &&
      (!Number.isSafeInteger(total) || total < 0 || items.length + response.items.length > total)
    )
      fail('validation', `${label} pagination total is invalid`);
    if (response.hasNext !== undefined && typeof response.hasNext !== 'boolean')
      fail('validation', `${label} pagination continuation is invalid`);
    items.push(...response.items);
    if (total !== undefined && items.length === total) return items;
    const hasNext = response.hasNext === true;
    if (!hasNext && response.items.length < pageSize) {
      if (total !== undefined && items.length < total)
        fail('validation', `${label} pagination is incomplete`);
      return items;
    }
    if (page === maxPages) fail('validation', `${label} pagination exceeded its bound`);
  }
  fail('validation', `${label} pagination exceeded its bound`);
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function stringField(value, field, maximum = 512) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    hasControlCharacters(value)
  )
    fail('validation', `GitHub metadata field is invalid: ${field}`);
  return value;
}

function validateLivePullRequestMetadata(value, environment) {
  const object = record(value);
  const base = record(object?.base);
  const baseRepository = record(base?.repo);
  const head = record(object?.head);
  const headRepository = record(head?.repo);
  if (object === undefined || base === undefined || head === undefined)
    fail('validation', 'GitHub pull request metadata is invalid');
  const number = object.number;
  if (number !== environment.pullRequest || object.state !== 'open')
    fail('validation', 'Protected pull request is not the expected open PR');
  const repository = canonicalRepository(
    stringField(baseRepository?.full_name, 'base.repo.full_name'),
  );
  const controlledHeadRepository = canonicalRepository(
    stringField(headRepository?.full_name, 'head.repo.full_name'),
  );
  const baseSha = canonicalSha(stringField(base.sha, 'base.sha', 128), 'live base.sha');
  const headSha = canonicalSha(stringField(head.sha, 'head.sha', 128), 'live head.sha');
  const baseRef = canonicalRef(stringField(base.ref, 'base.ref', 255));
  const headRef = canonicalRef(stringField(head.ref, 'head.ref', 255));
  if (
    repository !== environment.repository ||
    controlledHeadRepository !== environment.repository ||
    baseRef !== environment.baseRef ||
    baseSha !== environment.baseSha ||
    headSha !== environment.headSha
  )
    fail('validation', 'Protected pull request identity does not match the workflow allowlist');
  return Object.freeze({
    number,
    repository,
    baseRef,
    baseSha,
    headRef,
    headSha,
    headRepository: controlledHeadRepository,
    installationId: environment.installationId,
  });
}

function validateInstallationScope(value, repository) {
  const object = record(value);
  const repositories = object?.repositories;
  if (!Array.isArray(repositories) || repositories.length > 100)
    fail('validation', 'GitHub installation scope response is invalid');
  let found = false;
  for (const entry of repositories) {
    const item = record(entry);
    if (item === undefined) fail('validation', 'GitHub installation scope response is invalid');
    const fullName = item.full_name;
    if (typeof fullName === 'string' && canonicalRepository(fullName) === repository) found = true;
  }
  if (!found) fail('validation', 'GitHub App installation does not own the allowlisted repository');
  return true;
}

export function canonicalSyntheticPullRequest(metadata) {
  const source = record(metadata);
  if (source === undefined) fail('validation', 'Synthetic pull request metadata is invalid');
  const number = source.number;
  if (!Number.isSafeInteger(number) || number < 1)
    fail('validation', 'Synthetic pull request number is invalid');
  const repository = canonicalRepository(source.repository);
  const headRepository = canonicalRepository(source.headRepository);
  const baseSha = canonicalSha(source.baseSha, 'synthetic base SHA');
  const headSha = canonicalSha(source.headSha, 'synthetic head SHA');
  const baseRef = canonicalRef(source.baseRef);
  const headRef = canonicalRef(source.headRef);
  const installationId = canonicalPositiveId(
    String(source.installationId),
    'synthetic installation ID',
  );
  const payload = {
    action: 'opened',
    number,
    repository: { full_name: repository },
    installation: { id: installationId },
    pull_request: {
      number,
      state: 'open',
      base: { ref: baseRef, sha: baseSha, repo: { full_name: repository } },
      head: { ref: headRef, sha: headSha, repo: { full_name: headRepository } },
    },
  };
  return JSON.stringify(payload);
}

export function buildWebhookRequest(body, webhookSecret, deliveryId) {
  if (
    typeof body !== 'string' ||
    body.length === 0 ||
    Buffer.byteLength(body, 'utf8') > MAX_HTTP_BODY_BYTES
  )
    fail('validation', 'Synthetic webhook body is invalid');
  if (typeof webhookSecret !== 'string' || webhookSecret.length < 16)
    fail('validation', 'Synthetic webhook secret is invalid');
  if (typeof deliveryId !== 'string' || !UUID_PATTERN.test(deliveryId))
    fail('validation', 'Synthetic webhook delivery identity is invalid');
  const signature = `sha256=${createHmac('sha256', webhookSecret).update(body, 'utf8').digest('hex')}`;
  return Object.freeze({ body, signature, deliveryId, event: 'pull_request' });
}

function postWebhook(port, request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(request.body, 'utf8'),
        'x-hub-signature-256': request.signature,
        'x-github-delivery': request.deliveryId,
        'x-github-event': request.event,
      },
    });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      req.destroy();
      rejectPromise(new AppValidationError('validation', 'Local webhook request timed out'));
    }, REQUEST_TIMEOUT_MS);
    req.on('response', (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > 64 * 1024) {
          req.destroy();
          clearTimeout(timer);
          rejectPromise(
            new AppValidationError('validation', 'Local webhook response was too large'),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        resolvePromise({ status: response.statusCode ?? 0, body: chunks.join('') });
      });
      response.on('error', () => {
        clearTimeout(timer);
        rejectPromise(new AppValidationError('validation', 'Local webhook response failed'));
      });
    });
    req.on('error', () => {
      clearTimeout(timer);
      rejectPromise(new AppValidationError('validation', 'Local webhook request failed'));
    });
    req.end(request.body, 'utf8');
  });
}

async function listenWebhook(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = () =>
      rejectPromise(new AppValidationError('validation', 'Local webhook server failed to bind'));
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolvePromise();
    });
  });
  const address = server.address();
  if (
    typeof address !== 'object' ||
    address === null ||
    !Number.isSafeInteger(address.port) ||
    address.port < 1
  )
    fail('validation', 'Local webhook server did not expose an ephemeral port');
  return address.port;
}

function closeServer(server) {
  return new Promise((resolvePromise) => {
    if (server === undefined || !server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
  });
}

function extractEvidenceDigest(bundlePath, secrets, verifyEvidenceBundle) {
  return Promise.all([readFile(bundlePath), readFile(bundlePath, 'utf8')])
    .then(async ([bytes, text]) => {
      assertSecretFreeText(text, secrets);
      const parsed = JSON.parse(text);
      if (typeof parsed.outcome !== 'string') fail('validation', 'Evidence outcome is invalid');
      const verified = await verifyEvidenceBundle(bundlePath);
      if (!verified?.valid) fail('validation', 'Evidence bundle integrity verification failed');
      return {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        result: parsed.outcome,
      };
    })
    .catch((error) => {
      if (error instanceof AppValidationError) throw error;
      fail('validation', 'Evidence bundle could not be verified', error);
    });
}

export function assertSnapshotMatches(snapshot, environment) {
  const expectedRepository = environment.repository.toLowerCase();
  const object = record(snapshot);
  if (
    object === undefined ||
    typeof object.number !== 'number' ||
    object.number !== environment.pullRequest ||
    object.state !== 'open' ||
    typeof object.baseSha !== 'string' ||
    typeof object.headSha !== 'string' ||
    typeof object.headRepository !== 'string' ||
    object.baseSha.toLowerCase() !== environment.baseSha ||
    object.headSha.toLowerCase() !== environment.headSha ||
    object.headRepository.toLowerCase() !== expectedRepository ||
    object.fork !== false ||
    (object.repository !== undefined &&
      (typeof object.repository !== 'string' ||
        object.repository.toLowerCase() !== expectedRepository))
  )
    fail('validation', 'Protected pull request snapshot does not match the workflow allowlist');
}

async function reconcileRemoteSurfaces({ github, environment, appId, token }) {
  const checkRuns = await collectBoundedPages(
    async (page) => {
      const response = await readGitHubJson(
        `${apiPathForRepository(environment.repository)}/commits/${environment.headSha}/check-runs?check_name=PatchProof&filter=all&app_id=${appId}&per_page=${RECONCILIATION_PAGE_SIZE}&page=${page}`,
        token,
        { includeMetadata: true },
      );
      const body = record(response.body);
      return {
        items: body?.check_runs,
        total: body?.total_count,
        hasNext: response.hasNext,
      };
    },
    { label: 'GitHub Check', pageSize: RECONCILIATION_PAGE_SIZE },
  );
  const expectedExternal = `patchproof:${environment.repository}#${environment.pullRequest}:${environment.headSha}`;
  const managedChecks = checkRuns.filter((value) => {
    const item = record(value);
    return (
      item?.name === 'PatchProof' &&
      item.external_id === expectedExternal &&
      record(item.app)?.id === appId &&
      item.head_sha === environment.headSha
    );
  });
  const comments = await collectBoundedPages(
    async (page) => {
      const response = await readGitHubJson(
        `${apiPathForRepository(environment.repository)}/issues/${environment.pullRequest}/comments?per_page=${RECONCILIATION_PAGE_SIZE}&page=${page}`,
        token,
        { includeMetadata: true },
      );
      return { items: response.body, hasNext: response.hasNext };
    },
    { label: 'GitHub comment', pageSize: RECONCILIATION_PAGE_SIZE },
  );
  const managedComments = comments.filter((value) => {
    const item = record(value);
    return (
      typeof item?.body === 'string' &&
      item.body.includes('<!-- patchproof:summary:start -->') &&
      item.body.includes('<!-- patchproof:summary:end -->') &&
      record(item.performed_via_github_app)?.id === appId
    );
  });
  if (managedChecks.length !== 1 || managedComments.length !== 1)
    fail(
      'validation',
      'GitHub managed surface reconciliation did not find exactly one App-owned Check and comment',
    );
  const check = managedChecks[0];
  const comment = managedComments[0];
  if (!Number.isSafeInteger(check.id) || !Number.isSafeInteger(comment.id))
    fail('validation', 'GitHub managed surface identities are invalid');
  // Exercise the production reconciliation methods as the final ownership proof.
  const productionCheck = await github.findManagedCheck(
    environment.repository,
    environment.pullRequest,
    environment.headSha,
    { installationId: environment.installationId },
  );
  const productionComment = await github.findManagedComment(
    environment.repository,
    environment.pullRequest,
    { installationId: environment.installationId },
  );
  if (productionCheck?.id !== check.id || productionComment?.id !== comment.id)
    fail(
      'validation',
      'Production managed-surface reconciliation disagreed with the App-owned identities',
    );
  return { checkId: check.id, commentId: comment.id };
}

function assertQueueState(jobs, environment, expectedStatus) {
  if (!Array.isArray(jobs) || jobs.length !== 1)
    fail('validation', 'Validation queue cardinality is invalid');
  const [job] = jobs;
  if (
    job.repository !== environment.repository ||
    job.pullRequest !== environment.pullRequest ||
    job.baseSha !== environment.baseSha ||
    job.headSha !== environment.headSha ||
    job.installationId !== environment.installationId ||
    job.status !== expectedStatus ||
    job.attempts !== 1
  )
    fail('validation', 'Validation queue identity or attempt state is invalid');
  return job;
}

async function loadProductionModules() {
  const root = dirname(fileURLToPath(import.meta.url));
  const [auth, api, server, queue, sqlite, source, worker, github, core] = await Promise.all([
    import(pathToFileURL(join(root, '..', 'apps', 'github-app', 'dist', 'github-auth.js')).href),
    import(pathToFileURL(join(root, '..', 'apps', 'github-app', 'dist', 'github-api.js')).href),
    import(pathToFileURL(join(root, '..', 'apps', 'github-app', 'dist', 'server.js')).href),
    import(pathToFileURL(join(root, '..', 'apps', 'github-app', 'dist', 'queue.js')).href),
    import(pathToFileURL(join(root, '..', 'apps', 'github-app', 'dist', 'sqlite.js')).href),
    import(pathToFileURL(join(root, '..', 'apps', 'github-app', 'dist', 'source.js')).href),
    import(pathToFileURL(join(root, '..', 'apps', 'github-app', 'dist', 'worker.js')).href),
    import(pathToFileURL(join(root, '..', 'packages', 'github', 'dist', 'index.js')).href),
    import(pathToFileURL(join(root, '..', 'packages', 'core', 'dist', 'index.js')).href),
  ]);
  return { auth, api, server, queue, sqlite, source, worker, github, core };
}

function assertProductionAppWiring(auth, github, appId) {
  if (auth?.requiresInstallationId !== true || auth?.appId !== appId)
    fail('validation', 'Production App authentication wiring is invalid');
  if (
    github?.requiresInstallationId !== true ||
    github?.requiresFreshSnapshot !== true ||
    github?.appId !== appId
  )
    fail('validation', 'Production GitHub transport wiring is invalid');
}

function safeResolvedRepositoryRoot(value) {
  const root = resolve(value);
  if (!isAbsolute(root) || hasControlCharacters(root))
    fail('preflight', 'Repository root is invalid');
  return root;
}

async function cleanupFileOrDirectory(pathname, label) {
  try {
    await rm(pathname, { recursive: true, force: true });
    await access(pathname).then(
      () => fail('validation', `${label} remained after cleanup`),
      () => undefined,
    );
  } catch (error) {
    if (error instanceof AppValidationError) throw error;
    fail('validation', `${label} cleanup failed`, error);
  }
}

/**
 * Execute the credentialed validation flow. The only supported invocation is
 * the protected workflow's fixed environment; test callers may inject the
 * command runner, but production App authentication and transport remain the
 * defaults and are never replaced by a token test adapter.
 */
export async function runValidation(options = {}) {
  assertNoValidationArguments(options.arguments_ ?? process.argv.slice(2));
  const environment = parseValidationEnvironment(options.environment ?? process.env);
  const repositoryRoot = safeResolvedRepositoryRoot(
    options.repositoryRoot ?? dirname(fileURLToPath(import.meta.url)) + '/..',
  );
  await assertCurrentCheckoutSha(repositoryRoot, environment.patchproofSha);

  const modules = await loadProductionModules();
  const auth = new modules.auth.GitHubAppAuth({
    appId: environment.appId,
    privateKey: environment.privateKey,
  });
  const productionTransport = new modules.api.GitHubApiTransport(auth);
  assertProductionAppWiring(auth, productionTransport, environment.appId);
  const instrumentedTransport = instrumentProductionTransport(productionTransport);
  const github = instrumentedTransport.transport;
  const mutationCount = instrumentedTransport.mutationCount;

  // Read the live snapshot through the production transport before any local
  // image, queue, webhook, or remote mutation is prepared.
  const snapshot = await github.getPullRequest(environment.repository, environment.pullRequest, {
    installationId: environment.installationId,
  });
  assertSnapshotMatches(snapshot, environment);
  const installationToken = await auth.getToken(environment.installationId);
  const liveMetadata = validateLivePullRequestMetadata(
    await readGitHubJson(
      `${apiPathForRepository(environment.repository)}/pulls/${environment.pullRequest}`,
      installationToken,
    ),
    environment,
  );
  validateInstallationScope(
    await readGitHubJson('/installation/repositories?per_page=100&page=1', installationToken),
    environment.repository,
  );

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const validationRoot = await mkdtemp(join(environment.runnerTemp, 'patchproof-app-validation-'));
  let image;
  const imageTag = `patchproof-app-validation-probe-${runId.replaceAll('-', '')}`;
  let beforeContainers;
  let server;
  let worker;
  let queue;
  let store;
  let primaryError;
  let result;
  let evidence;
  let surfaces;
  let duplicateResponse;
  let duplicateMutations;
  let cleanupFailure;
  try {
    beforeContainers = await listDockerContainers();
    image = await buildValidationImage({
      validationRoot,
      repositoryRoot,
      runId,
      ...(options.command === undefined ? {} : { command: options.command }),
    });
    // Docker's local image ID is an immutable, daemon-local identity. It can
    // be inspected without a registry and avoids a mutable tag allowlist.
    const configText = buildValidationConfig(image.imageId);
    const fixtureRoot = join(repositoryRoot, 'test', 'fixtures', 'app-validation');
    const productionSource = new modules.source.GitHubSourceAdapter(auth);
    const source = new FixtureOverlaySourceAdapter(
      productionSource,
      fixtureRoot,
      validationRoot,
      environment.repository,
      environment.baseSha,
      environment.headSha,
      configText,
    );
    const sqlitePath = join(validationRoot, 'state.sqlite');
    const outputRoot = join(validationRoot, 'evidence');
    store = new modules.sqlite.SqliteStateStore(sqlitePath);
    queue = new modules.queue.SqliteQueue(sqlitePath, () => new Date(), {
      requireInstallationId: true,
    });
    const dependencies = {
      webhookSecret: environment.webhookSecret,
      store,
      github,
      enqueue: async (request) => queue.enqueue(request),
      cancelPullRequest: async (repository, pullRequest, reason) =>
        queue.cancelPullRequest(repository, pullRequest, reason),
      requireInstallationId: true,
    };
    server = modules.server.createWebhookServer(dependencies);
    const port = await listenWebhook(server);
    const body = canonicalSyntheticPullRequest(liveMetadata);
    const deliveryId = randomUUID();
    const request = buildWebhookRequest(body, environment.webhookSecret, deliveryId);
    const queuedResponse = await postWebhook(port, request);
    if (queuedResponse.status !== 202)
      fail('validation', 'Synthetic pull request delivery was not queued');
    const queuedJobs = await queue.list();
    assertQueueState(queuedJobs, environment, 'queued');

    worker = new modules.worker.PatchProofWorker({
      queue,
      source,
      store,
      github,
      outputRoot,
      workerId: `app-validation-${runId}`,
      operatorPolicy: {
        forceDocker: true,
        maxTimeoutMs: 10_000,
        maxOutputBytes: 8192,
        maxMemoryMb: 64,
        maxCpuCount: 1,
        maxPids: 32,
        // The config names the exact local image ID; a mutable tag allowlist
        // would be rejected by the production policy as not digest-pinned.
        approvedDockerImages: [],
        requireDigestPinnedImages: false,
        requireReadOnlyRoot: true,
        provisioningTimeoutMs: 120_000,
      },
      requireFreshSnapshot: true,
    });
    result = await worker.runOnce();
    if (
      result.status !== 'completed' ||
      result.job?.status !== 'running' ||
      result.bundlePath === undefined
    )
      fail('validation', 'Production worker did not complete exactly one validation attempt');
    const completedJob = assertQueueState(await queue.list(), environment, 'succeeded');
    if (completedJob.evidencePath !== result.bundlePath || completedJob.attempts !== 1)
      fail('validation', 'Validation worker evidence identity is invalid');
    assertWithin(outputRoot, result.bundlePath, 'Validation evidence path');
    evidence = await extractEvidenceDigest(
      result.bundlePath,
      [environment.privateKey, environment.webhookSecret],
      modules.core.verifyEvidenceBundle,
    );
    if (evidence.result !== 'PASS')
      fail('validation', 'Validation probe did not produce PASS evidence');
    const state = await store.getRun(
      environment.repository,
      environment.pullRequest,
      environment.headSha,
      environment.appId,
    );
    if (state?.checkId === undefined || state.commentId === undefined)
      fail('validation', 'Validation managed-surface IDs were not persisted');
    const postToken = await auth.getToken(environment.installationId);
    surfaces = await reconcileRemoteSurfaces({
      github,
      environment,
      appId: environment.appId,
      token: postToken,
    });
    if (surfaces.checkId !== state.checkId || surfaces.commentId !== state.commentId)
      fail('validation', 'Validation managed-surface IDs did not reconcile to stored IDs');

    // Replay byte-for-byte with the same UUID. The production SQLite delivery
    // claim must return duplicate before parsing, queueing, or mutating.
    const mutationsBeforeReplay = mutationCount();
    duplicateResponse = await postWebhook(port, request);
    if (
      duplicateResponse.status !== 200 ||
      !duplicateResponse.body.includes('duplicate delivery ignored')
    )
      fail('validation', 'Duplicate delivery was not ignored');
    const afterDuplicate = assertQueueState(await queue.list(), environment, 'succeeded');
    if (afterDuplicate.attempts !== 1 || afterDuplicate.id !== completedJob.id)
      fail('validation', 'Duplicate delivery created a second queue attempt');
    const duplicateSurfaces = await reconcileRemoteSurfaces({
      github,
      environment,
      appId: environment.appId,
      token: await auth.getToken(environment.installationId),
    });
    if (
      duplicateSurfaces.checkId !== surfaces.checkId ||
      duplicateSurfaces.commentId !== surfaces.commentId
    )
      fail('validation', 'Duplicate delivery changed managed surface identities');
    duplicateMutations = mutationCount() - mutationsBeforeReplay;
    if (duplicateMutations !== 0)
      fail('validation', 'Duplicate delivery performed a remote mutation');
    const finalImageId = await inspectLocalImage(image.tag);
    if (finalImageId !== image.imageId)
      fail('validation', 'Validation image identity changed during execution');

    const summary = {
      schemaVersion: 1,
      patchproofSha: environment.patchproofSha,
      runId,
      repository: environment.repository,
      pullRequest: environment.pullRequest,
      baseRef: environment.baseRef,
      baseSha: environment.baseSha,
      headSha: environment.headSha,
      deliveryId,
      terminalState: 'completed',
      attemptState: 'succeeded',
      check: {
        id: state.checkId,
        appId: environment.appId,
        ownership: 'app',
        headSha: environment.headSha,
      },
      comment: { id: state.commentId, appId: environment.appId, ownership: 'app' },
      evidence,
      duplicate: {
        status: 'ignored',
        queuedJobs: 1,
        workerAttempts: 1,
        mutations: duplicateMutations,
      },
      docker: {
        image: image.tag,
        imageId: image.imageId,
        network: 'none',
        user: '65532:65532',
        readOnlyRoot: true,
        capDrop: 'ALL',
        noNewPrivileges: true,
        resourceBounds: { memoryMb: 64, cpuCount: 1, pids: 32 },
        residualContainers: 0,
      },
      timestamps: { startedAt, finishedAt: new Date().toISOString() },
      cleanup: { ok: true, residualCount: 0 },
    };
    result.summary = summary;
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      worker?.stop();
      await closeServer(server);
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      queue?.close();
    } catch (error) {
      cleanupFailure ??= error;
    }
    try {
      store?.close();
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (beforeContainers !== undefined) {
      try {
        await cleanupValidationContainers(beforeContainers);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    try {
      await cleanupValidationImage({ tag: image?.tag ?? imageTag, imageId: image?.imageId });
    } catch (error) {
      cleanupFailure ??= error;
    }
    try {
      await cleanupFileOrDirectory(validationRoot, 'Validation workspace');
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (primaryError !== undefined) {
    if (cleanupFailure !== undefined)
      fail('validation', 'App validation failed and cleanup did not complete', primaryError);
    if (primaryError instanceof AppValidationError) throw primaryError;
    fail('validation', 'App validation failed', primaryError);
  }
  if (cleanupFailure !== undefined)
    fail('validation', 'App validation cleanup failed', cleanupFailure);
  if (result?.summary === undefined) fail('validation', 'App validation produced no summary');
  await writeValidationSummary(result.summary, environment.runnerTemp, [
    environment.privateKey,
    environment.webhookSecret,
  ]);
  return result.summary;
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (
      pathToFileURL(realpathSync(resolve(entry))).href.toLowerCase() ===
      pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href.toLowerCase()
    );
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  void (async () => {
    try {
      await runValidation({ arguments_: process.argv.slice(2) });
    } catch (error) {
      console.error(sanitizeMessage(errorForOperator(error)));
      process.exitCode =
        error instanceof AppValidationError && error.code === 'preflight'
          ? VALIDATION_EXIT_CODES.preflight
          : VALIDATION_EXIT_CODES.validation;
    }
  })();
}
