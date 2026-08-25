import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, ConfigValidationError, formatDiagnostics } from '@patchproof/config';
import { hasOption, option, type ParsedArgs } from './args.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MAX_INPUT_CHARS = 32_000;

function jsonOutput(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function bound(value: string): string {
  return value.length > MAX_INPUT_CHARS ? `${value.slice(0, MAX_INPUT_CHARS)}\n[truncated]` : value;
}

/** Builds the chat messages that turn a fix diff plus a bug report into a draft scenario. */
export function buildDraftPrompt(
  diff: string,
  issue: string,
): Array<{ role: string; content: string }> {
  const system = [
    'You draft PatchProof reproduction scenarios.',
    'PatchProof replays a trusted scenario against a base and a head revision and certifies that it fails on base and passes on head.',
    'Return ONLY a JSON object with exactly two string fields:',
    '{"config":"<.patchproof.yml contents>","scenario":"<scenario.mjs contents>"}',
    'Rules for config: version: 1; scenario.id and scenario.name describe the bug; scenario.command runs the scenario with node; scenario.file names the scenario file; expectedFailure.exitCode is 1; policy.backend is local with allowUnsafeLocal: true so the draft runs without Docker; network: none.',
    'Rules for scenario: a single self-contained Node ESM file that reproduces the reported bug with no network access and no dependencies; it must exit 1 with an EXPECTED_BUG marker when the bug is present and exit 0 when the fix from the diff is applied.',
    'Never include secrets, credentials, or real host paths.',
  ].join('\n');
  const user = [
    'Bug report:',
    '```',
    bound(issue),
    '```',
    'Fix diff:',
    '```',
    bound(diff),
    '```',
    'Return the JSON object now.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Extracts the drafted files from a model response that may wrap them in prose or fences. */
export function parseDraftResponse(text: string): { config: string; scenario: string } | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidates = [fenced?.[1], text].filter((item): item is string => item !== undefined);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const config = (parsed as Record<string, unknown>).config;
      const scenario = (parsed as Record<string, unknown>).scenario;
      if (typeof config !== 'string' || typeof scenario !== 'string') continue;
      if (config.length === 0 || scenario.length === 0) continue;
      return { config, scenario };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

type FetchLike = (
  input: string,
  init: unknown,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

async function requestDraft(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
  model: string,
  endpoint: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature: 0.2 }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Draft request failed (${response.status}); check OPENAI_API_KEY and model access`,
    );
  }
  let content: unknown;
  try {
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    content = parsed.choices?.[0]?.message?.content;
  } catch {
    throw new Error('Draft response was not valid JSON');
  }
  if (typeof content !== 'string' || content.length === 0)
    throw new Error('Draft response contained no message content');
  return content;
}

/**
 * Optional AI assistance, strictly bring your own key: without
 * OPENAI_API_KEY the command explains how to proceed by hand and changes
 * nothing. The request carries only the user supplied diff and report.
 */
export async function runDraft(
  args: ParsedArgs,
  fetchImpl: FetchLike = (input, init) => fetch(input, init as RequestInit),
): Promise<number> {
  const json = hasOption(args, 'json');
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.length < 20) {
    const message =
      'AI drafting needs an OpenAI API key. Set OPENAI_API_KEY, or write the scenario by hand: patchproof init <dir> creates a template, and docs/quickstart.md walks through it.';
    if (json) jsonOutput({ ok: false, reason: 'missing OPENAI_API_KEY' });
    else console.error(message);
    return 2;
  }
  const diff = option(args, 'diff');
  const issue = option(args, 'issue');
  const diffText = diff === true || diff === undefined ? undefined : diff;
  const issueText = issue === true || issue === undefined ? undefined : issue;
  if (diffText === undefined || issueText === undefined) {
    console.error('draft requires --diff <file-or-text> and --issue <file-or-text>');
    return 2;
  }
  const readInput = async (value: string): Promise<string> => {
    try {
      const content = await (await import('node:fs/promises')).readFile(value, 'utf8');
      return content;
    } catch {
      return value;
    }
  };
  const [diffContent, issueContent] = await Promise.all([
    readInput(diffText),
    readInput(issueText),
  ]);
  const model = process.env.PATCHPROOF_DRAFT_MODEL ?? DEFAULT_MODEL;
  const endpoint = process.env.OPENAI_BASE_URL ?? DEFAULT_ENDPOINT;
  let content: string;
  try {
    content = await requestDraft(
      buildDraftPrompt(diffContent, issueContent),
      apiKey,
      model,
      endpoint,
      fetchImpl,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) jsonOutput({ ok: false, error: message });
    else console.error(`PatchProof error: ${message}`);
    return 2;
  }
  const draft = parseDraftResponse(content);
  if (draft === undefined) {
    const message = 'The model response did not contain a usable draft; retry or edit by hand';
    if (json) jsonOutput({ ok: false, error: message });
    else console.error(`PatchProof error: ${message}`);
    return 2;
  }
  const outOption = option(args, 'out');
  const outDir = resolve(
    typeof outOption === 'string' && outOption !== '' ? outOption : 'patchproof-draft',
  );
  const configPath = join(outDir, '.patchproof.yml');
  const scenarioPath = join(outDir, 'scenario.mjs');
  const force = hasOption(args, 'force');
  for (const path of [configPath, scenarioPath]) {
    if (!force && (await pathExists(path))) {
      console.error(`${path} already exists; pass --force to overwrite`);
      return 2;
    }
  }
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await writeFile(
    scenarioPath,
    draft.scenario.endsWith('\n') ? draft.scenario : `${draft.scenario}\n`,
    'utf8',
  );
  await writeFile(
    configPath,
    draft.config.endsWith('\n') ? draft.config : `${draft.config}\n`,
    'utf8',
  );
  let validation = 'unknown';
  try {
    const result = await loadConfig(configPath);
    validation = result.diagnostics.length === 0 ? 'valid' : 'valid with warnings';
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      validation = 'invalid';
      if (!json) console.error(formatDiagnostics(error.diagnostics));
    } else {
      validation = 'unreadable';
    }
  }
  if (json) {
    jsonOutput({
      ok: validation === 'valid' || validation === 'valid with warnings',
      outDir,
      validation,
    });
  } else {
    console.log(
      `Draft written to ${outDir}\nConfig validation: ${validation}\nNext: review scenario.mjs, then patchproof validate ${configPath}`,
    );
  }
  return validation === 'valid' || validation === 'valid with warnings' ? 0 : 2;
}
