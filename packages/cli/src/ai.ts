export const DEFAULT_AI_MODEL = 'gpt-4o-mini';
export const DEFAULT_AI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_AI_TIMEOUT_MS = 30_000;

export type AiMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type FetchLike = (
  input: string,
  init: unknown,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface AiJsonSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface AiRequestOptions {
  apiKey: string;
  model: string;
  endpoint: string;
  messages: AiMessage[];
  fetchImpl: FetchLike;
  timeoutMs?: number;
  temperature?: number;
  jsonSchema?: AiJsonSchema;
  label: string;
}

export function aiTimeoutFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.PATCHPROOF_AI_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_AI_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/u.test(raw)) return DEFAULT_AI_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 120_000
    ? value
    : DEFAULT_AI_TIMEOUT_MS;
}

/**
 * One bounded, BYOK chat-completion transport for every optional AI command.
 * The API key is sent only in the Authorization header and response bodies are
 * never included in thrown diagnostics.
 */
export async function requestAiText(options: AiRequestOptions): Promise<string> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await options.fetchImpl(options.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.2,
        ...(options.jsonSchema === undefined
          ? {}
          : {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: options.jsonSchema.name,
                  strict: options.jsonSchema.strict ?? true,
                  schema: options.jsonSchema.schema,
                },
              },
            }),
      }),
    });
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(`${options.label} request exceeded ${timeoutMs} ms`);
    throw new Error(
      `${options.label} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `${options.label} request failed (${response.status}); check OPENAI_API_KEY and model access`,
    );

  let content: unknown;
  try {
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    content = parsed.choices?.[0]?.message?.content;
  } catch {
    throw new Error(`${options.label} response was not valid JSON`);
  }
  if (typeof content !== 'string' || content.trim().length === 0)
    throw new Error(`${options.label} response contained no message content`);
  return content;
}
