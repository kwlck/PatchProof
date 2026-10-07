import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DOCKER_PIN_TIMEOUT_MS = 120_000;

function dockerEnvironment(): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    ...(process.env.USERPROFILE === undefined ? {} : { USERPROFILE: process.env.USERPROFILE }),
  };
}

function repositoryName(image: string): string {
  const digestIndex = image.indexOf('@');
  if (digestIndex >= 0) return image.slice(0, digestIndex);
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  return colon > slash ? image.slice(0, colon) : image;
}

export function isPinnedDockerImage(image: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}@sha256:[0-9a-f]{64}$/iu.test(image);
}

/** Pull a tag once and return the immutable repository digest Docker resolved. */
export async function resolveDockerImageDigest(image: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/u.test(image))
    throw new Error('Docker image reference is invalid');
  if (isPinnedDockerImage(image)) return image;

  const common = {
    windowsHide: true,
    shell: false,
    timeout: DOCKER_PIN_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: dockerEnvironment(),
  } as const;
  try {
    await execFileAsync('docker', ['pull', image], common);
  } catch (error) {
    throw new Error(
      `Docker image pull failed for ${image}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
  }

  let output: string;
  try {
    const inspected = await execFileAsync(
      'docker',
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', image],
      common,
    );
    output = inspected.stdout.trim();
  } catch (error) {
    throw new Error(
      `Docker image inspect failed for ${image}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
  }

  let digests: unknown;
  try {
    digests = JSON.parse(output) as unknown;
  } catch {
    throw new Error(`Docker returned invalid RepoDigests for ${image}`);
  }
  if (!Array.isArray(digests)) throw new Error(`Docker returned no RepoDigests for ${image}`);
  const candidates = digests.filter(
    (value): value is string => typeof value === 'string' && isPinnedDockerImage(value),
  );
  const repository = repositoryName(image);
  const exact = candidates.find((value) => value.startsWith(`${repository}@sha256:`));
  const resolved = exact ?? candidates[0];
  if (resolved === undefined) throw new Error(`Docker returned no immutable digest for ${image}`);
  return resolved;
}
