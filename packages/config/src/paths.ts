import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, win32 } from 'node:path';

export async function assertPathInside(
  root: string,
  candidate: string,
  label: string,
): Promise<string> {
  const rootReal = await realpath(root);
  const candidateResolved = resolve(rootReal, candidate);
  if (
    relative(rootReal, candidateResolved).startsWith('..') ||
    isAbsolute(relative(rootReal, candidateResolved))
  )
    throw new Error(`${label} escapes trusted root`);
  const candidateReal = await realpath(candidateResolved);
  const rel = relative(rootReal, candidateReal);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`${label} resolves outside trusted root`);
  const stat = await lstat(candidateReal);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  return candidateReal;
}

export function assertSafeRelativePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes('\u0000')
  )
    throw new Error(`${label} must be a non-empty relative path`);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').includes('..'))
    throw new Error(`${label} must not contain traversal segments`);
  return normalized;
}
