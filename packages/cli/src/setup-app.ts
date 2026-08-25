import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { hasOption, option, type ParsedArgs } from './args.js';

const MANIFEST_URL = 'https://github.com/settings/manifests/new';
const CONVERSION_URL = 'https://api.github.com/app-manifests';
const FLOW_TIMEOUT_MS = 10 * 60_000;
const INSTALL_POLL_MS = 3_000;

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { active: boolean };
  redirect_url: string;
  callback_urls: string[];
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

export interface AppCredentials {
  appId: number;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
}

/** The manifest requests exactly the permissions the deployment docs require. */
export function buildAppManifest(name: string, redirectUrl: string): AppManifest {
  return {
    name,
    url: 'https://github.com/kwlck/PatchProof',
    hook_attributes: { active: false },
    redirect_url: redirectUrl,
    callback_urls: [redirectUrl],
    public: false,
    default_permissions: {
      contents: 'read',
      issues: 'write',
      checks: 'write',
      metadata: 'read',
      pull_requests: 'write',
    },
    default_events: ['pull_request', 'issue_comment'],
  };
}

export function generateAppSecrets(): { privateKey: string; webhookSecret: string } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    webhookSecret: randomBytes(32).toString('hex'),
  };
}

/** RS256 JWT for App-level endpoints such as the installations list. */
export function mintAppJwt(privateKey: string, appId: number, now = Date.now()): string {
  const encode = (value: string): string => Buffer.from(value).toString('base64url');
  const header = encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = encode(
    JSON.stringify({
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 480,
      iss: appId,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(privateKey).toString('base64url')}`;
}

type FetchLike = (
  input: string,
  init: unknown,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface ConversionResponse {
  id?: unknown;
  slug?: unknown;
  client_id?: unknown;
  webhook_secret?: unknown;
  pem?: unknown;
}

export async function convertManifestCode(
  code: string,
  fetchImpl: FetchLike,
): Promise<AppCredentials> {
  const response = await fetchImpl(`${CONVERSION_URL}/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub rejected the manifest conversion (${response.status})`);
  const payload = (await response.json()) as ConversionResponse;
  const appId =
    typeof payload.id === 'number' && Number.isSafeInteger(payload.id) ? payload.id : undefined;
  const slug = typeof payload.slug === 'string' ? payload.slug : undefined;
  const clientId = typeof payload.client_id === 'string' ? payload.client_id : undefined;
  const webhookSecret =
    typeof payload.webhook_secret === 'string' ? payload.webhook_secret : undefined;
  const privateKey = typeof payload.pem === 'string' ? payload.pem : undefined;
  if (
    appId === undefined ||
    slug === undefined ||
    clientId === undefined ||
    webhookSecret === undefined ||
    privateKey === undefined
  )
    throw new Error('Manifest conversion response was incomplete');
  return { appId, slug, privateKey, webhookSecret, clientId };
}

export async function listInstallations(
  privateKey: string,
  appId: number,
  fetchImpl: FetchLike,
): Promise<number[]> {
  const response = await fetchImpl('https://api.github.com/app/installations?per_page=100', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${mintAppJwt(privateKey, appId)}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`Installation lookup failed (${response.status})`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error('Installation response was invalid');
  return payload.flatMap((item) => {
    const id =
      typeof item === 'object' && item !== null ? (item as Record<string, unknown>).id : undefined;
    return typeof id === 'number' && Number.isSafeInteger(id) ? [id] : [];
  });
}

function listenOnFreePort(server: Server): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string')
        rejectPort(new Error('Callback port unavailable'));
      else resolvePort(address.port);
    });
  });
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32'
      ? { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
      : process.platform === 'darwin'
        ? { command: 'open', args: [url] }
        : { command: 'xdg-open', args: [url] };
  try {
    const child = spawn(command.command, command.args, {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });
    child.on('error', () => undefined);
  } catch {
    // Printing the URL is the fallback; opening the browser is best effort.
  }
}

const NEWLINE = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

function escapePrivateKeyForEnv(pem: string): string {
  return pem
    .replaceAll(String.fromCharCode(13), '')
    .replaceAll(NEWLINE, BACKSLASH + 'n')
    .trim();
}

export function renderEnvFile(credentials: AppCredentials): string {
  return [
    'PatchProof GitHub App credentials generated by patchproof setup --app.',
    'Keep this file private; it grants write access to the repositories the App can reach.',
    `PATCHPROOF_GITHUB_APP_ID=${credentials.appId}`,
    `PATCHPROOF_GITHUB_APP_PRIVATE_KEY="${escapePrivateKeyForEnv(credentials.privateKey)}"`,
    `PATCHPROOF_WEBHOOK_SECRET=${credentials.webhookSecret}`,
    '',
  ].join(NEWLINE);
}

/**
 * Interactive wizard for the GitHub App deployment. Uses the official App
 * Manifest flow: the user reviews one pre-filled form on github.com, GitHub
 * returns a one-time code to a local callback, and the wizard exchanges it
 * for the App credentials and writes a 0600 env file.
 */
export async function runSetupApp(args: ParsedArgs): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error('setup --app is interactive; run it in a terminal');
    return 2;
  }
  const envFileOption = option(args, 'env-file');
  const envPath = resolve(
    typeof envFileOption === 'string' && envFileOption.length > 0 ? envFileOption : '.env',
  );
  const nameOption = option(args, 'name');
  const appName =
    typeof nameOption === 'string' && nameOption.trim().length > 0
      ? nameOption.trim().slice(0, 60)
      : 'PatchProof local deployment';
  let server: Server | undefined;
  let code: string | undefined;
  try {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const received = url.searchParams.get('code') ?? undefined;
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(
        received === undefined
          ? 'Missing code parameter; go back and retry the GitHub form.'
          : 'PatchProof received the App credentials. You can close this tab.',
      );
      if (received !== undefined) code = received;
    });
    const port = await listenOnFreePort(server);
    const redirectUrl = `http://127.0.0.1:${port}/callback`;
    const manifest = buildAppManifest(appName, redirectUrl);
    const manifestUrl = `${MANIFEST_URL}?manifest=${encodeURIComponent(JSON.stringify(manifest))}`;
    console.log(
      [
        'This wizard creates a GitHub App through the official manifest flow.',
        '1. GitHub opens with a pre-filled form; review it and press Create.',
        '2. GitHub redirects to a local callback with a one-time code.',
        '3. The wizard writes the credentials to a private env file.',
        '',
        'Open this URL to start:',
        manifestUrl,
        '',
      ].join(NEWLINE),
    );
    if (!hasOption(args, 'no-open')) openBrowser(manifestUrl);
    await new Promise<void>((resolveFlow, rejectFlow) => {
      const deadline = Date.now() + FLOW_TIMEOUT_MS;
      const timer = setInterval(() => {
        if (code !== undefined) {
          clearInterval(timer);
          resolveFlow();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          rejectFlow(new Error('Timed out waiting for the GitHub manifest callback'));
        }
      }, 250);
    });
  } finally {
    server?.close();
  }
  console.log('Credentials received. Exchanging the manifest code...');
  const credentials = await convertManifestCode(code as string, (input, init) =>
    fetch(input, init as RequestInit),
  );
  await mkdir(join(envPath, '..'), { recursive: true, mode: 0o700 });
  await writeFile(envPath, renderEnvFile(credentials), { encoding: 'utf8', mode: 0o600 });
  console.log(
    [
      `App created: ${credentials.slug} (id ${credentials.appId}).`,
      `Credentials written to ${envPath} (mode 0600).`,
      '',
      'Next: install the App on the repositories it should check.',
      `Open: https://github.com/apps/${credentials.slug}/installations/new`,
      'The wizard detects the installation automatically (up to 10 minutes).',
      '',
    ].join(NEWLINE),
  );
  let installations: number[] = [];
  const deadline = Date.now() + FLOW_TIMEOUT_MS;
  while (installations.length === 0 && Date.now() < deadline) {
    await new Promise((resolvePause) => setTimeout(resolvePause, INSTALL_POLL_MS));
    try {
      installations = await listInstallations(
        credentials.privateKey,
        credentials.appId,
        (input, init) => fetch(input, init as RequestInit),
      );
    } catch {
      // Transient lookup failures just extend the polling window.
    }
  }
  if (installations.length === 0) {
    console.log('No installation detected yet. Re-run this wizard later with the same env file.');
    return 0;
  }
  console.log(
    [
      `Installation detected: ${installations.join(', ')}.`,
      '',
      'Start the deployment (from the directory that holds the env file):',
      '  node --env-file=.env node_modules/.bin/patchproof-app-webhook',
      'Or with the repository tooling:',
      '  pnpm --filter @patchproof/github-app start:webhook',
      '  pnpm --filter @patchproof/github-app start:worker',
    ].join(NEWLINE),
  );
  return 0;
}
