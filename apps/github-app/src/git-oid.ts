export const GIT_OBJECT_ID_ROUTE_PATTERN = '(?:[0-9a-f]{40}|[0-9a-f]{64})';

export function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value);
}

export function gitObjectFormat(value: string): 'sha1' | 'sha256' {
  if (!isGitObjectId(value)) throw new Error('Git object ID is invalid');
  return value.length === 40 ? 'sha1' : 'sha256';
}
