import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ConfigValidationError, type ConfigParseResult } from './types.js';
import { parseConfigText } from './validate.js';
import { assertPathInside } from './paths.js';

export async function loadTrustedConfig(
  configPath: string,
  trustedBaseDir: string,
): Promise<ConfigParseResult> {
  const trustedConfigPath = await assertPathInside(
    trustedBaseDir,
    resolve(configPath),
    'Configuration path',
  );
  const source = await readFile(trustedConfigPath, 'utf8');
  const parsed = parseConfigText(source);
  if (parsed.config === undefined) throw new ConfigValidationError(parsed.diagnostics);
  return {
    config: parsed.config,
    diagnostics: parsed.diagnostics,
    sourcePath: trustedConfigPath,
    sourceRevision: 'base',
    sha256: parsed.sha256,
  };
}

export async function loadConfig(configPath: string): Promise<ConfigParseResult> {
  return loadTrustedConfig(configPath, dirname(resolve(configPath)));
}

export function formatDiagnostics(
  diagnostics: readonly { level: string; path: string; message: string }[],
): string {
  return diagnostics
    .map(
      (diagnostic) => `${diagnostic.level.toUpperCase()} ${diagnostic.path}: ${diagnostic.message}`,
    )
    .join('\n');
}
