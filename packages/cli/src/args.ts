export interface ParsedArgs {
  command: string;
  positional: string[];
  options: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf('=');
    if (equals >= 0) {
      options.set(raw.slice(0, equals), raw.slice(equals + 1));
      continue;
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options.set(raw, next);
      index += 1;
    } else {
      options.set(raw, true);
    }
  }
  return { command, positional, options };
}

export function option(args: ParsedArgs, name: string): string | true | undefined {
  return args.options.get(name);
}

export function hasOption(args: ParsedArgs, name: string): boolean {
  return args.options.has(name);
}
