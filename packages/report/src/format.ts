import type { EvidenceBundle, ExecutionEvidence, RunOutcome } from '@patchproof/core';

const OUTCOME_LABELS: Record<RunOutcome, string> = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCONCLUSIVE: 'INCONCLUSIVE',
  INFRA_ERROR: 'INFRA ERROR',
  POLICY_DENIED: 'POLICY DENIED',
};

function clean(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13);
    })
    .join('');
}

const MANAGED_MARKERS = [
  '<!-- patchproof:summary:start -->',
  '<!-- patchproof:summary:end -->',
] as const;

function stripManagedMarkers(value: string): string {
  return MANAGED_MARKERS.reduce(
    (text, marker) => text.replaceAll(marker, '[managed marker omitted]'),
    value,
  );
}

function singleLine(value: string): string {
  return stripManagedMarkers(clean(value).replaceAll(/\r?\n/gu, ' '));
}

function code(value: string): string {
  return stripManagedMarkers(clean(value).replaceAll('`', '\\x60'));
}

function color(text: string, ansi: string, enabled: boolean): string {
  return enabled ? `\u001b[${ansi}m${text}\u001b[0m` : text;
}

function executionLine(execution: ExecutionEvidence, enabled: boolean): string {
  const status = execution.timedOut ? 'timeout' : execution.exitCode === 0 ? 'pass' : 'fail';
  const statusText =
    status === 'pass'
      ? color(status, '32', enabled)
      : status === 'fail'
        ? color(status, '31', enabled)
        : color(status, '33', enabled);
  const exit = execution.exitCode === null ? 'null' : String(execution.exitCode);
  return `${execution.revision.toUpperCase().padEnd(5)} ${statusText.padEnd(enabled ? 18 : 11)} exit=${exit.padEnd(4)} ${String(execution.durationMs).padStart(5)}ms`;
}

export function renderTerminalReport(
  bundle: EvidenceBundle,
  options: { color?: boolean } = {},
): string {
  const enabled =
    options.color ?? (process.stdout.isTTY === true && process.env.NO_COLOR === undefined);
  const outcome = OUTCOME_LABELS[bundle.outcome];
  const headingColor = bundle.outcome === 'PASS' ? '32' : bundle.outcome === 'FAIL' ? '31' : '33';
  const lines = [
    `${color('PatchProof', '36', enabled)} ${color(outcome, headingColor, enabled)} - ${singleLine(bundle.verdict)}`,
    `Scenario   ${singleLine(bundle.scenario.name)} (${singleLine(bundle.scenario.id)})`,
    'Comparison',
    `  ${executionLine(bundle.executions.base, enabled)}`,
    `  ${executionLine(bundle.executions.head, enabled)}`,
    `Evidence   schema=${bundle.schemaVersion} sha256=${bundle.integrity.canonicalSha256.slice(0, 16)}... artifacts=${bundle.artifacts.length}`,
    `Policy     backend=${bundle.policy.backend} network=${bundle.policy.network} trusted-config=${bundle.policy.trustedConfigRevision}`,
    'Replay     patchproof replay patchproof.evidence.json --yes --base <base-dir> --head <head-dir>',
    `Why        ${clean(bundle.completeness.missing.length === 0 ? bundle.verdict : bundle.completeness.missing.join('; '))}`,
  ];
  return lines.join('\n');
}

export function renderMarkdownReport(bundle: EvidenceBundle): string {
  const outcome = OUTCOME_LABELS[bundle.outcome];
  const base = bundle.executions.base;
  const head = bundle.executions.head;
  const artifactRows = bundle.artifacts
    .map(
      (artifact) =>
        `| \`${code(artifact.relativePath)}\` | ${artifact.sizeBytes} | \`${artifact.sha256}\` |`,
    )
    .join('\n');
  return [
    '<!-- patchproof:summary:start -->',
    `## PatchProof - ${outcome}`,
    '',
    singleLine(bundle.verdict),
    '',
    `**Scenario:** \`${code(bundle.scenario.id)}\` - ${singleLine(bundle.scenario.name)}`,
    '',
    '| Revision | Exit | Duration | Stdout | Stderr |',
    '| --- | ---: | ---: | --- | --- |',
    `| Base | ${base.exitCode === null ? 'null' : base.exitCode} | ${base.durationMs} ms | ${base.stdout.truncated ? 'truncated' : 'bounded'} | ${base.stderr.truncated ? 'truncated' : 'bounded'} |`,
    `| Head | ${head.exitCode === null ? 'null' : head.exitCode} | ${head.durationMs} ms | ${head.stdout.truncated ? 'truncated' : 'bounded'} | ${head.stderr.truncated ? 'truncated' : 'bounded'} |`,
    '',
    `**Provenance:** base \`${bundle.sources.base.sha256}\` (${bundle.sources.base.kind}), head \`${bundle.sources.head.sha256}\` (${bundle.sources.head.kind}); trusted scenario from base; backend \`${bundle.policy.backend}\`, network \`${bundle.policy.network}\`.`,
    '',
    '**Redacted excerpts**',
    '',
    'Base stdout:',
    '```text',
    code(base.stdout.preview),
    '```',
    'Base stderr:',
    '```text',
    code(base.stderr.preview),
    '```',
    'Head stdout:',
    '```text',
    code(head.stdout.preview),
    '```',
    'Head stderr:',
    '```text',
    code(head.stderr.preview),
    '```',
    '',
    `**Integrity:** schema ${bundle.schemaVersion}; canonical SHA-256 \`${bundle.integrity.canonicalSha256}\`; signer identity is not asserted.`,
    '',
    '**Replay:** run `patchproof verify patchproof.evidence.json`, then `patchproof replay patchproof.evidence.json --yes --base <base-dir> --head <head-dir>` after reviewing environment deviations.',
    '',
    '**Artifacts**',
    '',
    '| Path | Bytes | SHA-256 |',
    '| --- | ---: | --- |',
    artifactRows || '| none | 0 | - |',
    '',
    `**Limitations:** ${singleLine(bundle.completeness.missing.length === 0 ? 'Logs are bounded and redacted; Docker isolation and current host policy are recorded, not remotely attested.' : bundle.completeness.missing.join('; '))}`,
    '<!-- patchproof:summary:end -->',
  ].join('\n');
}

export function outcomeExitCode(outcome: RunOutcome): number {
  if (outcome === 'PASS') return 0;
  if (outcome === 'FAIL') return 1;
  if (outcome === 'POLICY_DENIED') return 3;
  if (outcome === 'INFRA_ERROR') return 4;
  return 2;
}
