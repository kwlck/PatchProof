import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoFiles, parseArgs, runSetup, runSign } from '@patchproof/cli';
import { generateSigningKeyPair, verifyEvidenceSignature } from '@patchproof/core';

async function signedBundle(): Promise<{
  bundlePath: string;
  dir: string;
  keys: { privateKey: string; publicKey: string };
}> {
  const dir = await mkdtemp(join(tmpdir(), 'patchproof-sign-'));
  await runSetup(parseArgs(['setup', '--demo', '--demo-dir', dir, '--json']));
  const bundlePath = join(dir, 'evidence', 'patchproof.evidence.json');
  const keys = generateSigningKeyPair();
  await runSign(
    parseArgs(['sign', bundlePath, '--key', join(dir, 'ignored.pem')]),
    keys.privateKey,
  );
  return { bundlePath, dir, keys };
}

test('sign writes an envelope that verifies against the bundle bytes', async () => {
  const { bundlePath, keys } = await signedBundle();
  const envelopePath = `${bundlePath}.sig`;
  const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
  assert.equal(envelope.algorithm, 'rsa-sha256');
  const verification = await verifyEvidenceSignature(bundlePath, envelopePath, keys.publicKey);
  assert.equal(verification.valid, true, verification.errors.join('; '));
});

test('a tampered bundle fails signature verification', async () => {
  const { bundlePath, keys } = await signedBundle();
  const original = await readFile(bundlePath, 'utf8');
  await writeFile(bundlePath, `${original.slice(0, -2)} }`, 'utf8');
  const verification = await verifyEvidenceSignature(
    bundlePath,
    `${bundlePath}.sig`,
    keys.publicKey,
  );
  assert.equal(verification.valid, false);
  assert.match(verification.errors.join(' '), /does not match/u);
});

test('a different key fails the fingerprint check', async () => {
  const { bundlePath } = await signedBundle();
  const other = generateSigningKeyPair();
  const verification = await verifyEvidenceSignature(
    bundlePath,
    `${bundlePath}.sig`,
    other.publicKey,
  );
  assert.equal(verification.valid, false);
  assert.match(verification.errors.join(' '), /fingerprint/u);
});
