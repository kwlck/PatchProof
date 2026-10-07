import { readFile } from 'node:fs/promises';
import { verifyEvidenceBundle } from '@patchproof/core';
import { hasOption, type ParsedArgs } from './args.js';
import {
  aiTimeoutFromEnvironment,
  DEFAULT_AI_ENDPOINT,
  DEFAULT_AI_MODEL,
  requestAiText,
  type AiMessage,
  type FetchLike,
} from './ai.js';

const MAX_EVIDENCE_CHARS = 24_000;

function jsonOutput(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Builds the explanation request from an already verified evidence bundle. */
export function buildExplainPrompt(bundleText: string): AiMessage[] {
  const system = [
    'You explain PatchProof evidence to software engineers.',
    'PatchProof replayed a trusted bug scenario against the base and head revisions of a fix.',
    'Explain in at most 120 words: what the evidence shows, the most likely reason the outcome happened, and the single next action the author should take.',
    'Use plain prose. Never invent details that are not in the evidence. Never include secrets or tokens.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Evidence bundle JSON:\n${bundleText.slice(0, MAX_EVIDENCE_CHARS)}`,
    },
  ];
}

/**
 * Backward-compatible parser for callers that still handle raw Chat
 * Completions responses themselves. New commands use requestAiText directly.
 */
export function parseExplanation(text: string): string | undefined {
  let content: unknown;
  try {
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    content = parsed.choices?.[0]?.message?.content;
  } catch {
    return undefined;
  }
  if (typeof content !== 'string' || content.trim().length === 0) return undefined;
  return content.trim();
}

/**
 * Optional AI triage, strictly bring your own key. The evidence bundle is
 * fully verified before a bounded excerpt is sent to the configured model.
 */
export async function runExplain(
  args: ParsedArgs,
  fetchImpl: FetchLike = (input, init) => fetch(input, init as RequestInit),
): Promise<number> {
  const json = hasOption(args, 'json');
  const bundlePath = args.positional[0];
  if (bundlePath === undefined) {
    console.error('explain requires an evidence bundle path');
    return 2;
  }
  const verification = await verifyEvidenceBundle(bundlePath);
  if (!verification.valid) {
    const message = `Evidence bundle is invalid; refusing to explain unverified data: ${verification.errors[0] ?? ''}`;
    if (json) jsonOutput({ ok: false, error: message });
    else console.error(`PatchProof error: ${message}`);
    return 2;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.length < 20) {
    const message =
      'AI explanation needs an OpenAI API key. Set OPENAI_API_KEY, or read the deterministic report in the bundle and the managed comment instead.';
    if (json) jsonOutput({ ok: false, reason: 'missing OPENAI_API_KEY' });
    else console.error(message);
    return 2;
  }
  const bundleText = await readFile(bundlePath, 'utf8');
  const model = process.env.PATCHPROOF_EXPLAIN_MODEL ?? DEFAULT_AI_MODEL;
  const endpoint = process.env.OPENAI_BASE_URL ?? DEFAULT_AI_ENDPOINT;
  let explanation: string;
  try {
    explanation = await requestAiText({
      apiKey,
      model,
      endpoint,
      messages: buildExplainPrompt(bundleText),
      fetchImpl,
      timeoutMs: aiTimeoutFromEnvironment(),
      label: 'Explanation',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) jsonOutput({ ok: false, error: message });
    else console.error(`PatchProof error: ${message}`);
    return 2;
  }
  if (json) jsonOutput({ ok: true, explanation: explanation.trim() });
  else console.log(explanation.trim());
  return 0;
}
