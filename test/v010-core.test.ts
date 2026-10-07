import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  canonicalize,
  createIntegrity,
  verifyEvidenceBundle,
  type EvidenceBundle,
} from '@patchproof/core';
import type { PatchProofConfig } from '@patchproof/config';
import {
  applyOperatorPolicy,
  isAllowedEgressHost,
  renderSquidAllowlist,
} from '@patchproof/runner';
import {
  parseWorkerOperatorPolicy,
  WorkerPolicyConfigurationError,
} from '../apps/github-app/dist/worker-policy.js';
import { aiTimeoutFromEnvironment } from '../packages/cli/dist/ai.js';
import { isPinnedDockerImage } from '../packages/cli/dist/docker-pin.js';

const digestImage = (name: string, fill: string): string => `${name}@sha256:${fill.repeat(64)}`;

function repositoryPolicy(): PatchProofConfig['policy'] {
  return {
    backend: 'docker',
    allowUnsafeLocal: false,
    allowFork: false,
    network: 'allowlist',
    allowedHosts: ['api.github.com'],
    timeoutMs: 30_000,
    outputBytes: 65_536,
    memoryMb: 512,
    cpuCount: 1,
    pids: 128,
    dockerImage: digestImage('node', 'a'),
    readOnlyRoot: true,
  };
}

test('v0.10 allowlist accepts only exact public DNS hosts', () => {
  assert.equal(isAllowedEgressHost('api.github.com'), true);
  assert.equal(isAllowedEgressHost('registry.npmjs.org'), true);
  for (const host of ['*.github.com', '127.0.0.1', 'localhost', 'metadata.google.internal', 'EXAMPLE.com'])
    assert.equal(isAllowedEgressHost(host), false, host);

  const squid = renderSquidAllowlist(['registry.npmjs.org', 'api.github.com']);
  assert.match(squid, /acl allowed_domains dstdomain api\.github\.com registry\.npmjs\.org/u);
  assert.match(squid, /acl blocked_v4 dst/u);
  assert.match(squid, /acl blocked_v6 dst/u);
  assert.match(squid, /http_access deny all/u);
});

test('v0.10 operator policy fails closed without a pinned egress proxy', () => {
  const policy = repositoryPolicy();
  const baseOperator = {
    forceDocker: true,
    requireDigestPinnedImages: true,
    requireReadOnlyRoot: true,
    approvedDockerImages: [policy.dockerImage],
  };
  const denied = applyOperatorPolicy(policy, baseOperator);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? '', /egress proxy|PATCHPROOF_EGRESS_PROXY_IMAGE/iu);

  const allowed = applyOperatorPolicy(policy, {
    ...baseOperator,
    egressProxyImage: digestImage('ubuntu/squid', 'b'),
  });
  assert.equal(allowed.allowed, true);
});

test('v0.10 production worker parses immutable egress proxy image', () => {
  const scenario = digestImage('ghcr.io/patchproof/scenario', 'a');
  const proxy = digestImage('ubuntu/squid', 'b');
  const parsed = parseWorkerOperatorPolicy({
    PATCHPROOF_APPROVED_DOCKER_IMAGES: scenario,
    PATCHPROOF_EGRESS_PROXY_IMAGE: proxy,
  });
  assert.equal(parsed.egressProxyImage, proxy);
  assert.throws(
    () =>
      parseWorkerOperatorPolicy({
        PATCHPROOF_APPROVED_DOCKER_IMAGES: scenario,
        PATCHPROOF_EGRESS_PROXY_IMAGE: 'ubuntu/squid:latest',
      }),
    WorkerPolicyConfigurationError,
  );
});

test('v0.10 Docker pin and AI timeout helpers are bounded', () => {
  assert.equal(isPinnedDockerImage(digestImage('node', 'a')), true);
  assert.equal(isPinnedDockerImage('node:24-bookworm-slim'), false);
  assert.equal(aiTimeoutFromEnvironment({ PATCHPROOF_AI_TIMEOUT_MS: '45000' }), 45_000);
  assert.equal(aiTimeoutFromEnvironment({ PATCHPROOF_AI_TIMEOUT_MS: '9999999' }), 30_000);
  assert.equal(aiTimeoutFromEnvironment({ PATCHPROOF_AI_TIMEOUT_MS: 'oops' }), 30_000);
});

test('v0.10 verifier accepts schema v2 and remains compatible with v1 fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchproof-v010-'));
  try {
    await cp('docs/examples/fixture-proof', root, { recursive: true });
    const bundlePath = join(root, 'patchproof.evidence.json');
    const legacy = await verifyEvidenceBundle(bundlePath);
    assert.equal(legacy.valid, true);

    const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as EvidenceBundle;
    const asRecord = bundle as unknown as Record<string, unknown>;
    const sources = asRecord.sources as Record<string, Record<string, unknown>>;
    const baseOid = 'a'.repeat(40);
    const headOid = 'b'.repeat(64);
    sources.base = {
      revision: 'base',
      ref: baseOid,
      kind: 'git-commit',
      location: 'base',
      commitOid: baseOid,
      objectFormat: 'sha1',
    };
    sources.head = {
      revision: 'head',
      ref: headOid,
      kind: 'git-commit',
      location: 'head',
      commitOid: headOid,
      objectFormat: 'sha256',
    };
    asRecord.schemaVersion = 2;
    const { integrity: _oldIntegrity, ...withoutIntegrity } = asRecord;
    void _oldIntegrity;
    asRecord.integrity = createIntegrity(withoutIntegrity);
    await writeFile(bundlePath, `${canonicalize(asRecord)}\n`, 'utf8');

    const v2 = await verifyEvidenceBundle(bundlePath);
    assert.equal(v2.valid, true, v2.errors.join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
