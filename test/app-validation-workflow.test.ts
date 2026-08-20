import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

type Mapping = Record<string, unknown>;

const root = resolve(process.cwd());
const appWorkflowText = readFileSync(resolve(root, '.github/workflows/app-validation.yml'), 'utf8');
const appWorkflow = mapping(parse(appWorkflowText));
const appJobs = mapping(appWorkflow.jobs);
const appJob = mapping(appJobs['app-validation']);
const appSteps = steps(appJob.steps);
const ciWorkflowText = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const ciWorkflow = mapping(parse(ciWorkflowText));
const ciJobs = mapping(ciWorkflow.jobs);
const bundleJob = mapping(ciJobs['app-validation-bundle']);
const bundleSteps = steps(bundleJob.steps);

test('app-validation workflow has the fixed manual and environment boundary', () => {
  assert.deepEqual(appWorkflow.on, { workflow_dispatch: null });
  assert.deepEqual(appWorkflow.permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(appWorkflow.concurrency, {
    group: 'patchproof-app-validation',
    'cancel-in-progress': false,
  });
  assert.deepEqual(Object.keys(appJobs), ['app-validation']);
  assert.equal(appJob['runs-on'], 'ubuntu-24.04');
  assert.equal(appJob.environment, 'app-validation');
  assert.equal(appJob['timeout-minutes'], 20);
  assert.deepEqual(Object.keys(mapping(appJob.env)).sort(), [
    'PATCHPROOF_VALIDATION_APP_ID',
    'PATCHPROOF_VALIDATION_BASE_REF',
    'PATCHPROOF_VALIDATION_BASE_SHA',
    'PATCHPROOF_VALIDATION_HEAD_SHA',
    'PATCHPROOF_VALIDATION_INSTALLATION_ID',
    'PATCHPROOF_VALIDATION_PATCHPROOF_SHA',
    'PATCHPROOF_VALIDATION_PR_NUMBER',
    'PATCHPROOF_VALIDATION_REPOSITORY',
  ]);
  assert.doesNotMatch(appWorkflowText, /\binputs\s*:/gu);
  assert.doesNotMatch(appWorkflowText, /\b(GITHUB_ENV|GITHUB_OUTPUT)\b/gu);
  assert.doesNotMatch(appWorkflowText, /\bcache:\s*pnpm\b/gu);
  assert.doesNotMatch(
    appWorkflowText,
    /\b(pnpm\s+install|npm\s+(?:ci|install|publish)|yarn\s+add|docker\s+(?:pull|push)|gh\s+(?:release|workflow)|git\s+tag)\b/giu,
  );
});

test('app-validation workflow checks fixed repository, ref, SHA, and checkout credentials', () => {
  const checkout = stepUsing(appSteps, 'actions/checkout@');
  const checkoutWith = mapping(checkout.with);
  assert.equal(checkoutWith.ref, 'refs/heads/main');
  assert.equal(checkoutWith['persist-credentials'], false);

  const fixedContract = stepNamed(appSteps, 'Validate the fixed dispatch contract');
  const fixedRun = String(fixedContract.run);
  for (const name of [
    'PATCHPROOF_VALIDATION_APP_ID',
    'PATCHPROOF_VALIDATION_INSTALLATION_ID',
    'PATCHPROOF_VALIDATION_REPOSITORY',
    'PATCHPROOF_VALIDATION_PR_NUMBER',
    'PATCHPROOF_VALIDATION_BASE_REF',
    'PATCHPROOF_VALIDATION_BASE_SHA',
    'PATCHPROOF_VALIDATION_HEAD_SHA',
    'PATCHPROOF_VALIDATION_PATCHPROOF_SHA',
  ]) {
    assert.match(fixedRun, new RegExp(`\\$${name}|${name}`, 'u'));
  }
  assert.match(fixedRun, /GITHUB_REPOSITORY.*kwlck\/PatchProof/u);
  assert.match(fixedRun, /GITHUB_REF.*refs\/heads\/main/u);
  assert.match(fixedRun, /GITHUB_SHA.*PATCHPROOF_VALIDATION_PATCHPROOF_SHA/u);
  assert.match(
    String(stepNamed(appSteps, 'Verify the checkout is the approved SHA').run),
    /git rev-parse HEAD/u,
  );
});

test('app-validation workflow uses exact CI API identity and verifies the bundle inventory', () => {
  const discover = stepNamed(appSteps, 'Discover and verify the exact CI bundle');
  const discoverRun = String(discover.run);
  assert.deepEqual(mapping(discover.env), { GITHUB_TOKEN: '${{ github.token }}' });
  assert.match(discoverRun, /api\.github\.com\/repos\/kwlck\/PatchProof/u);
  assert.match(discoverRun, /actions\/workflows\/ci\.yml\/runs/u);
  assert.match(discoverRun, /\.path == "\.github\/workflows\/ci\.yml"/u);
  assert.match(discoverRun, /\.name == "CI"/u);
  assert.match(discoverRun, /\.conclusion == "success"/u);
  assert.match(discoverRun, /\.head_sha == \$expected_sha/u);
  assert.match(discoverRun, /\.head_branch == "main"/u);
  assert.match(discoverRun, /actions\/runs\/\$run_id\/artifacts/u);
  assert.match(discoverRun, /actions\/artifacts\/\$artifact_id\/zip/u);
  assert.match(discoverRun, /manifest\.artifactName/u);
  assert.match(discoverRun, /manifest\.sourceSha/u);
  assert.match(discoverRun, /manifest\.inventorySha256/u);
  assert.match(discoverRun, /digest\(bytes\)/u);
  assert.match(discoverRun, /JSON\.stringify\(actual\).*JSON\.stringify\(listed\)/u);
  assert.match(discoverRun, /cp -a "\$bundle"\/. "\$GITHUB_WORKSPACE"\//u);
});

test('credentialed harness receives only environment credentials and fixed no-argument invocation', () => {
  const harness = stepNamed(appSteps, 'Run the credentialed app harness');
  assert.deepEqual(mapping(harness.env), {
    PATCHPROOF_VALIDATION_APP_PRIVATE_KEY: '${{ secrets.PATCHPROOF_VALIDATION_APP_PRIVATE_KEY }}',
    PATCHPROOF_VALIDATION_WEBHOOK_SECRET: '${{ secrets.PATCHPROOF_VALIDATION_WEBHOOK_SECRET }}',
    APP_ID: '${{ vars.PATCHPROOF_VALIDATION_APP_ID }}',
    INSTALLATION_ID: '${{ vars.PATCHPROOF_VALIDATION_INSTALLATION_ID }}',
    REPOSITORY: '${{ vars.PATCHPROOF_VALIDATION_REPOSITORY }}',
    PR_NUMBER: '${{ vars.PATCHPROOF_VALIDATION_PR_NUMBER }}',
    BASE_REF: '${{ vars.PATCHPROOF_VALIDATION_BASE_REF }}',
    BASE_SHA: '${{ vars.PATCHPROOF_VALIDATION_BASE_SHA }}',
    HEAD_SHA: '${{ vars.PATCHPROOF_VALIDATION_HEAD_SHA }}',
    PATCHPROOF_SHA: '${{ vars.PATCHPROOF_VALIDATION_PATCHPROOF_SHA }}',
  });
  assert.equal(harness.run, 'node scripts/app-validation.mjs');
  assert.doesNotMatch(
    String(harness.run),
    /PATCHPROOF_VALIDATION_APP_PRIVATE_KEY|PATCHPROOF_VALIDATION_WEBHOOK_SECRET|GITHUB_ENV|GITHUB_OUTPUT/u,
  );
  assert.match(String(harness['working-directory']), /github\.workspace/u);
});

test('summary upload is fixed, short-lived, secret-scanned, and fail-closed', () => {
  const placeIndex = appSteps.findIndex(
    (step) => step.name === 'Place the fixed validation summary',
  );
  const scanIndex = appSteps.findIndex(
    (step) => step.name === 'Scan the fixed summary for secrets',
  );
  const uploadIndex = appSteps.findIndex(
    (step) => step.name === 'Upload the fixed validation summary',
  );
  assert.ok(placeIndex >= 0 && scanIndex > placeIndex && uploadIndex > scanIndex);
  assert.equal(appSteps[placeIndex].if, '${{ success() }}');
  assert.match(
    String(appSteps[placeIndex].run),
    /RUNNER_TEMP.*patchproof-app-validation-summary\.json/u,
  );
  assert.match(String(appSteps[placeIndex].run), /work\/app-validation\/summary\.json/u);
  const scan = appSteps[scanIndex];
  const upload = appSteps[uploadIndex];
  assert.equal(scan.if, '${{ success() }}');
  assert.match(String(scan.run), /work\/app-validation\/summary\.json/u);
  assert.match(String(scan.run), /credential-like value/u);
  assert.equal(upload.if, '${{ success() }}');
  assert.equal(upload.uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
  assert.deepEqual(mapping(upload.with), {
    name: 'patchproof-app-validation-summary',
    path: 'work/app-validation/summary.json',
    'if-no-files-found': 'error',
    'retention-days': 3,
  });
});

test('CI produces an exact-SHA bundle only after successful checks and build', () => {
  assert.equal(bundleJob.needs, 'checks');
  assert.match(String(bundleJob.if), /github\.event_name == 'push'/u);
  assert.match(String(bundleJob.if), /github\.ref == 'refs\/heads\/main'/u);
  assert.equal(bundleJob['runs-on'], 'ubuntu-24.04');
  assert.equal(bundleJob['timeout-minutes'], 20);

  const checkout = stepUsing(bundleSteps, 'actions/checkout@');
  assert.equal(mapping(checkout.with).ref, '${{ github.sha }}');
  assert.equal(mapping(checkout.with)['persist-credentials'], false);
  const install = stepNamed(bundleSteps, 'Install the immutable build inputs');
  assert.equal(install.run, 'pnpm install --frozen-lockfile');
  const build = stepNamed(bundleSteps, 'Build the exact checked-out SHA');
  assert.match(String(build.run), /git rev-parse HEAD/u);
  assert.match(String(build.run), /pnpm build/u);
  const assemble = stepNamed(bundleSteps, 'Assemble credential-free validation bundle');
  const assembleRun = String(assemble.run);
  for (const required of [
    'scripts/app-validation.mjs',
    'fixtures',
    'test/fixtures',
    'apps/github-app/dist',
    'packages/$workspace/dist',
    'node_modules/yaml',
    'manifest.json',
    'sourceSha',
    'inventorySha256',
    'sha256',
  ])
    assert.match(assembleRun, new RegExp(required.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

  const upload = stepNamed(bundleSteps, 'Upload exact-SHA app validation bundle');
  assert.equal(upload.uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
  assert.deepEqual(mapping(upload.with), {
    name: 'patchproof-app-validation-bundle',
    path: '${{ runner.temp }}/patchproof-app-validation-bundle',
    'if-no-files-found': 'error',
    'retention-days': 7,
  });
  assert.doesNotMatch(ciWorkflowText, /secrets\./u);
});

function mapping(value: unknown): Mapping {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Mapping;
}

function steps(value: unknown): Mapping[] {
  assert.ok(Array.isArray(value));
  return value.map((step) => mapping(step));
}

function stepNamed(allSteps: Mapping[], name: string): Mapping {
  const step = allSteps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
}

function stepUsing(allSteps: Mapping[], actionPrefix: string): Mapping {
  const step = allSteps.find((candidate) => String(candidate.uses ?? '').startsWith(actionPrefix));
  assert.ok(step, `missing workflow action: ${actionPrefix}`);
  return step;
}
