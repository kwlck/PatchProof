import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAppManifest,
  convertManifestCode,
  generateAppSecrets,
  listInstallations,
  mintAppJwt,
  renderEnvFile,
} from '@patchproof/cli';

test('app manifest requests exactly the documented permissions and events', () => {
  const manifest = buildAppManifest('PatchProof test', 'http://127.0.0.1:1/callback');
  assert.equal(manifest.hook_attributes.active, false);
  assert.equal(manifest.public, false);
  assert.deepEqual(manifest.default_permissions, {
    contents: 'read',
    issues: 'write',
    checks: 'write',
    metadata: 'read',
    pull_requests: 'write',
  });
  assert.deepEqual(manifest.default_events, ['pull_request', 'issue_comment']);
  assert.equal(manifest.redirect_url, 'http://127.0.0.1:1/callback');
  assert.deepEqual(manifest.callback_urls, [manifest.redirect_url]);
});

test('generated secrets are a real pkcs1 PEM and a long random secret', () => {
  const secrets = generateAppSecrets();
  assert.match(secrets.privateKey, /-----BEGIN RSA PRIVATE KEY-----/u);
  assert.ok(secrets.webhookSecret.length >= 32);
  assert.notEqual(secrets.webhookSecret, generateAppSecrets().webhookSecret);
});

test('mintAppJwt produces a verifiable RS256 token with app identity', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const token = mintAppJwt(pem, 4660890, Date.UTC(2026, 0, 1));
  const [header, claims, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'RS256');
  const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(parsed.iss, 4660890);
  const verified = createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(publicKey, Buffer.from(signature, 'base64url'));
  assert.equal(verified, true);
});

test('manifest conversion maps the full credential payload', async () => {
  const credentials = await convertManifestCode('one-time-code', async () => ({
    ok: true,
    status: 201,
    json: async () => ({
      id: 4660890,
      slug: 'patchproof-local',
      client_id: 'Iv1Test',
      webhook_secret: 'whs',
      pem: '-----BEGIN RSA PRIVATE KEY-----X',
    }),
  }));
  assert.equal(credentials.appId, 4660890);
  assert.equal(credentials.slug, 'patchproof-local');
  assert.equal(credentials.webhookSecret, 'whs');
  await assert.rejects(
    convertManifestCode('bad', async () => ({
      ok: false,
      status: 422,
      json: async () => ({}),
    })),
    /rejected the manifest conversion/u,
  );
});

test('installation listing flattens valid ids only', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const seen: string[] = [];
  const ids = await listInstallations(pem, 1, async (input, init) => {
    seen.push(String(input));
    const headers = (init as { headers: Record<string, string> }).headers;
    assert.match(headers.Authorization, /^Bearer ey/u);
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: 155204489 }, { nope: true }, null, { id: 2 }],
    };
  });
  assert.deepEqual(ids, [155204489, 2]);
  assert.equal(seen.length, 1);
});

test('env file renders a single-line escaped private key with guidance', () => {
  const content = renderEnvFile({
    appId: 7,
    slug: 's',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\n',
    webhookSecret: 'secret',
    clientId: 'c',
  });
  assert.match(content, /PATCHPROOF_GITHUB_APP_ID=7/u);
  assert.doesNotMatch(content, /\nabc/u);
  assert.match(content, /PATCHPROOF_GITHUB_APP_PRIVATE_KEY="-----BEGIN/u);
  assert.match(content, /Keep this file private/u);
});
