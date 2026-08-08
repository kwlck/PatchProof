import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, lstat, cp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, join, relative, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

async function walk(root: string, current: string, files: string[]): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'work') continue;
    const full = join(current, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic links are not allowed in execution workspace: ${full}`);
    if (entry.isDirectory()) await walk(root, full, files);
    else if (entry.isFile()) files.push(relative(root, full).replaceAll('\\', '/'));
  }
}

export async function hashDirectory(root: string): Promise<string> {
  const files: string[] = [];
  await walk(root, root, files);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const bytes = await readFile(join(root, file));
    hash.update(file);
    hash.update('\0');
    hash.update(String(bytes.byteLength));
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export const KNOWN_LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
] as const;

export type KnownLockfileName = (typeof KNOWN_LOCKFILES)[number];

export interface KnownLockfileIdentity {
  file: KnownLockfileName;
  sha256: string;
}

export async function hashKnownLockfile(root: string): Promise<KnownLockfileIdentity | undefined> {
  for (const name of KNOWN_LOCKFILES) {
    try {
      const bytes = await readFile(join(root, name));
      return { file: name, sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch {
      // Try the next known lockfile.
    }
  }
  return undefined;
}

export async function copyWorkspaceSafe(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => {
      const name = basename(sourcePath);
      return name !== '.git' && name !== 'node_modules' && name !== 'work';
    },
  });
  const files: string[] = [];
  await walk(destination, destination, files);
}

export async function materializeScenarioFile(
  baseRoot: string,
  headRoot: string,
  file: string,
): Promise<string> {
  const source = resolve(baseRoot, file);
  const target = resolve(headRoot, file);
  const stat = await lstat(source);
  if (!stat.isFile()) throw new Error(`Trusted scenario file is not a regular file: ${file}`);
  const content = await readFile(source);
  await mkdir(resolve(headRoot, file, '..'), { recursive: true });
  await writeFile(target, content, { flag: 'w' });
  return createHash('sha256').update(content).digest('hex');
}

export async function cleanupWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function sourceIdentity(
  root: string,
  fallbackRef: string,
): Promise<{ sha256: string; kind: 'git-commit' | 'directory-tree'; ref: string }> {
  try {
    const result = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      windowsHide: true,
    });
    const ref = result.stdout.trim();
    if (/^[0-9a-f]{40}$/i.test(ref)) return { sha256: ref, kind: 'git-commit', ref };
  } catch {
    // A directory fixture is a supported local source and uses its deterministic tree hash.
  }
  return { sha256: await hashDirectory(root), kind: 'directory-tree', ref: fallbackRef };
}
