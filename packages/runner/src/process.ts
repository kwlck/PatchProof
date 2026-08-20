import { spawn, type ChildProcess } from 'node:child_process';
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

export interface LocalProcessBackendOptions {
  /** Docker uses this adapter only as a launcher and must not receive scenario env. */
  includeScenarioEnvironment?: boolean;
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

function terminate(child: ChildProcess): void {
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
  // Host-side scenarios are hostile input and may ignore SIGTERM. This is a
  // bounded second attempt; normal close handling clears its timer.
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, 250).unref();
}

function newOutputState(): OutputState {
  return { parts: [], storedBytes: 0, redactedBytes: 0, truncated: false };
}

export class LocalProcessBackend implements ExecutionBackend {
  public readonly kind = 'local' as const;

  public constructor(private readonly options: LocalProcessBackendOptions = {}) {}

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
    let cancelled = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceTerminationTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    let abortListener: (() => void) | undefined;
    const env = {
      ...(spec.launcherEnvironment ?? {}),
      ...(this.options.includeScenarioEnvironment === false ? {} : spec.environment),
    };
    const result = await new Promise<{ exitCode: number | null; signal?: string; error?: string }>(
      (resolve) => {
        const executable = spec.command[0];
        if (executable === undefined) {
          resolve({ exitCode: null, error: 'Scenario command is empty' });
          return;
        }
        const finish = (value: {
          exitCode: number | null;
          signal?: string;
          error?: string;
        }): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          if (forceTerminationTimer !== undefined) clearTimeout(forceTerminationTimer);
          if (abortListener !== undefined && spec.signal !== undefined)
            spec.signal.removeEventListener('abort', abortListener);
          resolve(value);
        };
        const requestTermination = (reason: 'timeout' | 'output' | 'cancel'): void => {
          if (reason === 'timeout') timedOut = true;
          if (reason === 'output') outputLimitHit = true;
          if (reason === 'cancel') cancelled = true;
          if (child === undefined) return;
          terminate(child);
          forceTerminationTimer = setTimeout(() => {
            if (!settled) {
              if (process.platform === 'win32' && child?.pid !== undefined) {
                const taskkill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                  shell: false,
                  windowsHide: true,
                  stdio: 'ignore',
                });
                taskkill.once('error', () => undefined);
              } else child?.kill('SIGKILL');
            }
          }, 750);
          forceTerminationTimer.unref();
        };
        abortListener = () => requestTermination('cancel');
        if (spec.signal?.aborted) {
          cancelled = true;
          finish({ exitCode: null, error: 'Execution cancelled' });
          return;
        }
        try {
          child = spawn(executable, spec.command.slice(1), {
            cwd: join(spec.workspace, spec.cwd),
            env,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          finish({ exitCode: null, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        spec.signal?.addEventListener('abort', abortListener, { once: true });
        if (spec.signal?.aborted) requestTermination('cancel');
        child.stdout?.on('data', (chunk: Buffer) => {
          if (outputLimitHit) return;
          if (appendChunk(stdout, stdoutDecoder.write(chunk), stdoutRedactor, spec.outputBytes))
            requestTermination('output');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (outputLimitHit) return;
          if (appendChunk(stderr, stderrDecoder.write(chunk), stderrRedactor, spec.outputBytes))
            requestTermination('output');
        });
        child.once('error', (error: Error) => finish({ exitCode: null, error: error.message }));
        child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
          finish({
            exitCode,
            ...(signal === null ? {} : { signal }),
            ...(timedOut
              ? { error: `Execution exceeded ${spec.timeoutMs} ms` }
              : outputLimitHit
                ? { error: `Output exceeded ${spec.outputBytes} bytes` }
                : cancelled
                  ? { error: 'Execution cancelled' }
                  : {}),
          });
        });
        timer = setTimeout(() => requestTermination('timeout'), Math.max(1, spec.timeoutMs));
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
        : cancelled
          ? 'Execution cancelled'
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
      ...(cancelled ? { cancelled: true } : {}),
      ...(outputLimitHit ? { outputLimitHit: true } : {}),
      ...(error === undefined ? {} : { error }),
    };
  }
}
