import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, win32 } from 'node:path';

export async function assertPathInside(
  root: string,
  candidate: string,
  label: string,
): Promise<string> {
  const rootReal = await realpath(root);
  // Resolve relative candidates against the caller's root before resolving
  // either path through symlinks. On Windows a workspace may be presented via
  // a mapped drive while realpath returns its canonical drive; resolving an
  // absolute C: candidate under a D: root would otherwise compare unrelated
  // drives and reject every valid path.
  const candidateResolved = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const lexicalRoot = resolve(root);
  const lexicalRelative = relative(lexicalRoot, candidateResolved);
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative))
    throw new Error(`${label} escapes trusted root`);
  const candidateStat = await lstat(candidateResolved);
  if (candidateStat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const candidateReal = await realpath(candidateResolved);
  const rel = relative(rootReal, candidateReal);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`${label} resolves outside trusted root`);
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
