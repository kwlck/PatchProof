import { readFile } from 'node:fs/promises';
import { verifyEvidenceBundle } from '@patchproof/core';
import { hasOption, type ParsedArgs } from './args.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MAX_EVIDENCE_CHARS = 24_000;

function jsonOutput(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

type FetchLike = (
  input: string,
  init: unknown,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Builds the explanation request from an already verified evidence bundle. */
export function buildExplainPrompt(bundleText: string): Array<{ role: string; content: string }> {
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

/** Extracts the explanation text from a chat completion response. */
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
 * Optional AI triage, strictly bring your own key: without OPENAI_API_KEY the
 * command points at the deterministic report and sends nothing anywhere. The
 * bundle is verified before any text is sent to the model.
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
  const model = process.env.PATCHPROOF_DRAFT_MODEL ?? DEFAULT_MODEL;
  const endpoint = process.env.OPENAI_BASE_URL ?? DEFAULT_ENDPOINT;
  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: buildExplainPrompt(bundleText),
        temperature: 0.2,
      }),
    });
  } catch (error) {
    const message = `Explanation request failed: ${error instanceof Error ? error.message : String(error)}`;
    if (json) jsonOutput({ ok: false, error: message });
    else console.error(`PatchProof error: ${message}`);
    return 2;
  }
  const text = await response.text();
  if (!response.ok) {
    const message = `Explanation request failed (${response.status}); check OPENAI_API_KEY and model access`;
    if (json) jsonOutput({ ok: false, error: message });
    else console.error(`PatchProof error: ${message}`);
    return 2;
  }
  const explanation = parseExplanation(text);
  if (explanation === undefined) {
    const message = 'The model response did not contain an explanation';
    if (json) jsonOutput({ ok: false, error: message });
    else console.error(`PatchProof error: ${message}`);
    return 2;
  }
  if (json) jsonOutput({ ok: true, explanation });
  else console.log(explanation);
  return 0;
}
