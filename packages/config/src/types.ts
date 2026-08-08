export interface PatchProofConfig {
  version: 1;
  name: string;
  scenario: {
    id: string;
    name: string;
    command: string[];
    cwd: string;
    file?: string;
    expectedFailure: {
      exitCode: number;
      reasonPattern?: string;
      reasonClass?: string;
    };
    environment: Record<string, string>;
  };
  policy: {
    backend: 'docker' | 'local';
    allowUnsafeLocal: boolean;
    allowFork: boolean;
    network: 'none' | 'allowlist';
    allowedHosts: string[];
    timeoutMs: number;
    outputBytes: number;
    memoryMb: number;
    cpuCount: number;
    pids: number;
    dockerImage: string;
    readOnlyRoot: boolean;
  };
  redaction: {
    secrets: string[];
  };
}

export interface ConfigDiagnostic {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ConfigParseResult {
  config: PatchProofConfig;
  diagnostics: ConfigDiagnostic[];
  sourcePath: string;
  sourceRevision: 'base';
  sha256: string;
}

export class ConfigValidationError extends Error {
  public constructor(
    public readonly diagnostics: ConfigDiagnostic[],
    message = 'Invalid PatchProof configuration',
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}
