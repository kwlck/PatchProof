import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftPrompt, parseDraftResponse, runDraft } from '@patchproof/cli';
import { parseArgs } from '@patchproof/cli';

const VALID_RESPONSE = JSON.stringify({
  config:
    'version: 1\nname: Draft\nscenario:\n  id: d\n  name: Draft scenario\n  command: [node, scenario.mjs]\n  cwd: .\n  file: scenario.mjs\n  expectedFailure:\n    exitCode: 1\npolicy:\n  backend: local\n  allowUnsafeLocal: true\n  network: none\nredaction:\n  secrets: []\n',
  scenario:
    "if (process.env.PATCHPROOF_REVISION !== 'head') {\n  console.error('EXPECTED_BUG');\n  process.exit(1);\n}\n",
});

test('draft prompt carries the report and diff with JSON-only instructions', () => {
  const messages = buildDraftPrompt('diff --git a/app.js b/app.js', 'Crash on empty token');
  assert.equal(messages[0]?.role, 'system');
  assert.match(messages[0]!.content, /"config"/u);
  assert.match(messages[0]!.content, /EXPECTED_BUG/u);
  assert.match(messages[1]!.content, /Crash on empty token/u);
  assert.match(messages[1]!.content, /diff --git/u);
});

test('draft response parser accepts plain and fenced JSON and rejects garbage', () => {
  const plain = parseDraftResponse(VALID_RESPONSE);
  assert.equal(plain?.config.includes('version: 1'), true);
  const fenced = parseDraftResponse(`Here you go:\n\`\`\`json\n${VALID_RESPONSE}\n\`\`\`\nDone.`);
  assert.equal(fenced?.scenario.includes('EXPECTED_BUG'), true);
  assert.equal(parseDraftResponse('no json here'), undefined);
  assert.equal(parseDraftResponse('{"config":42,"scenario":""}'), undefined);
});

test('draft without an API key explains the manual path and changes nothing', async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const exitCode = await runDraft(parseArgs(['draft', '--diff', 'd', '--issue', 'i']));
    assert.equal(exitCode, 2);
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  }
});

test('draft writes a validating config and scenario from a model response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-draft-'));
  const fakeFetch = async (input: string, init: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: VALID_RESPONSE } }] }),
  });
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-key-000000000000';
  try {
    const exitCode = await runDraft(
      parseArgs([
        'draft',
        '--diff',
        'diff text',
        '--issue',
        'issue text',
        '--out',
        join(root, 'out'),
      ]),
      fakeFetch as never,
    );
    assert.equal(exitCode, 0);
    const scenario = await readFile(join(root, 'out', 'scenario.mjs'), 'utf8');
    assert.match(scenario, /EXPECTED_BUG/u);
    const config = await readFile(join(root, 'out', '.patchproof.yml'), 'utf8');
    assert.match(config, /allowUnsafeLocal: true/u);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('draft reports a failed API call without writing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-draft-err-'));
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"bad key"}}',
  });
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-key-000000000000';
  try {
    const exitCode = await runDraft(
      parseArgs(['draft', '--diff', 'd', '--issue', 'i', '--out', join(root, 'out')]),
      fakeFetch as never,
    );
    assert.equal(exitCode, 2);
    const files = await readFile(join(root, 'out', '.patchproof.yml'), 'utf8').then(
      () => 'written',
      () => 'absent',
    );
    assert.equal(files, 'absent');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
