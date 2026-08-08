export interface CommandAuthorization {
  login: string;
  association: 'OWNER' | 'MEMBER' | 'COLLABORATOR' | 'CONTRIBUTOR' | 'NONE';
}

export interface ParsedCommand {
  command: 'run' | 'verify' | 'help';
  argument?: string;
}

export function parseIssueCommentCommand(body: string): ParsedCommand | undefined {
  const firstLine = body.trim().split(/\r?\n/u)[0]?.trim() ?? '';
  const match = /^\/patchproof(?:\s+([a-z]+))?(?:\s+([^\s]+))?$/iu.exec(firstLine);
  if (match === null) return undefined;
  const command = (match[1] ?? 'help').toLowerCase();
  if (command !== 'run' && command !== 'verify' && command !== 'help') return { command: 'help' };
  return { command, ...(match[2] === undefined ? {} : { argument: match[2] }) };
}

export function isAuthorizedCommand(
  actor: CommandAuthorization,
  allowedAssociations: readonly CommandAuthorization['association'][] = [
    'OWNER',
    'MEMBER',
    'COLLABORATOR',
  ],
): boolean {
  return allowedAssociations.includes(actor.association);
}
