import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { boundLog, StreamingRedactor } from '@patchproof/core';
import type { BackendExecution, ExecutionBackend, ExecutionSpec } from './types.js';

interface OutputState {
  parts: string[];
  storedBytes: number;
  redactedBytes: number;
  truncated: boolean;
}

function appendRedacted(target: OutputState, redacted: string, limit: number): boolean {
  if (target.truncated) return true;
  const sizeBytes = Buffer.byteLength(redacted, 'utf8');
  target.redactedBytes += sizeBytes;
  const remaining = Math.max(0, limit - target.storedBytes);
  if (sizeBytes > remaining) {
    const bounded = boundLog(redacted, remaining);
    target.parts.push(bounded.text);
    target.storedBytes += Buffer.byteLength(bounded.text, 'utf8');
    target.truncated = true;
    return true;
  }
  target.parts.push(redacted);
  target.storedBytes += sizeBytes;
  return false;
}

function appendChunk(
  target: OutputState,
  chunk: string,
  redactor: StreamingRedactor,
  limit: number,
): boolean {
  if (target.truncated) return true;
  return appendRedacted(target, redactor.push(chunk), limit);
}

function terminate(child: ReturnType<typeof spawn>): void {
  child.kill();
  if (process.platform === 'win32' && child.pid !== undefined) {
    const taskkill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    taskkill.once('error', () => undefined);
    return;
  }
  child.kill('SIGTERM');
}

function newOutputState(): OutputState {
  return { parts: [], storedBytes: 0, redactedBytes: 0, truncated: false };
}

export class LocalProcessBackend implements ExecutionBackend {
  public readonly kind = 'local' as const;

  public async run(spec: ExecutionSpec): Promise<BackendExecution> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const stdout = newOutputState();
    const stderr = newOutputState();
    const stdoutRedactor = new StreamingRedactor(spec.secrets);
    const stderrRedactor = new StreamingRedactor(spec.secrets);
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let timedOut = false;
    let outputLimitHit = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const env = { ...(spec.launcherEnvironment ?? {}), ...spec.environment };
    const result = await new Promise<{ exitCode: number | null; signal?: string; error?: string }>(
      (resolve) => {
        const executable = spec.command[0];
        if (executable === undefined) {
          resolve({ exitCode: null, error: 'Scenario command is empty' });
          return;
        }
        const child = spawn(executable, spec.command.slice(1), {
          cwd: join(spec.workspace, spec.cwd),
          env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const finish = (value: {
          exitCode: number | null;
          signal?: string;
          error?: string;
        }): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve(value);
        };
        child.stdout?.on('data', (chunk: Buffer) => {
          if (outputLimitHit) return;
          if (appendChunk(stdout, stdoutDecoder.write(chunk), stdoutRedactor, spec.outputBytes)) {
            outputLimitHit = true;
            terminate(child);
          }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (outputLimitHit) return;
          if (appendChunk(stderr, stderrDecoder.write(chunk), stderrRedactor, spec.outputBytes)) {
            outputLimitHit = true;
            terminate(child);
          }
        });
        child.once('error', (error: Error) => finish({ exitCode: null, error: error.message }));
        child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
          finish({
            exitCode,
            ...(signal === null ? {} : { signal }),
            ...(outputLimitHit ? { error: `Output exceeded ${spec.outputBytes} bytes` } : {}),
          });
        });
        timer = setTimeout(() => {
          timedOut = true;
          terminate(child);
        }, spec.timeoutMs);
      },
    );

    if (!outputLimitHit) {
      outputLimitHit = appendChunk(stdout, stdoutDecoder.end(), stdoutRedactor, spec.outputBytes);
    } else {
      stdoutDecoder.end();
    }
    const stdoutTail = stdoutRedactor.finish();
    if (!outputLimitHit) outputLimitHit = appendRedacted(stdout, stdoutTail, spec.outputBytes);

    if (!outputLimitHit) {
      outputLimitHit = appendChunk(stderr, stderrDecoder.end(), stderrRedactor, spec.outputBytes);
    } else {
      stderrDecoder.end();
    }
    const stderrTail = stderrRedactor.finish();
    if (!outputLimitHit) outputLimitHit = appendRedacted(stderr, stderrTail, spec.outputBytes);

    const error = timedOut
      ? `Execution exceeded ${spec.timeoutMs} ms`
      : outputLimitHit
        ? `Output exceeded ${spec.outputBytes} bytes`
        : result.error;
    return {
      ...result,
      timedOut,
      startedAt,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      stdout: stdout.parts.join(''),
      stderr: stderr.parts.join(''),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutSizeBytes: stdout.redactedBytes,
      stderrSizeBytes: stderr.redactedBytes,
      ...(error === undefined ? {} : { error }),
    };
  }
}
