import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDemoFiles,
  buildExplainPrompt,
  parseArgs,
  parseExplanation,
  runExplain,
  runSetup,
} from '@patchproof/cli';

async function validBundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-explain-'));
  await runSetup(parseArgs(['setup', '--demo', '--demo-dir', root, '--json']));
  return join(root, 'evidence', 'patchproof.evidence.json');
}

test('explain prompt carries the bundle and bounds the explanation', () => {
  const messages = buildExplainPrompt('{"outcome":"PASS"}');
  assert.equal(messages[0]?.role, 'system');
  assert.match(messages[0]!.content, /120 words/u);
  assert.match(messages[1]!.content, /"outcome":"PASS"/u);
});

test('explanation parser extracts chat content and rejects junk', () => {
  const good = parseExplanation(
    JSON.stringify({ choices: [{ message: { content: '  It passed. ' } }] }),
  );
  assert.equal(good, 'It passed.');
  assert.equal(parseExplanation('nope'), undefined);
  assert.equal(parseExplanation(JSON.stringify({ choices: [] })), undefined);
});

test('explain refuses unverified bundles before any network call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-explain-bad-'));
  const path = join(root, 'bundle.json');
  await writeFile(path, '{"outcome":"PASS"}', 'utf8');
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-key-000000000000';
  try {
    const exitCode = await runExplain(parseArgs(['explain', path]));
    assert.equal(exitCode, 2);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('explain without a key points at the deterministic report', async () => {
  const bundlePath = await validBundle();
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const exitCode = await runExplain(parseArgs(['explain', bundlePath]));
    assert.equal(exitCode, 2);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('explain returns the model explanation for a verified bundle', async () => {
  const bundlePath = await validBundle();
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [
          { message: { content: 'The scenario failed before the fix and passed after it.' } },
        ],
      }),
  });
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-key-000000000000';
  try {
    const exitCode = await runExplain(parseArgs(['explain', bundlePath]), fakeFetch as never);
    assert.equal(exitCode, 0);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
