import { lstat, readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyEvidenceBundle, type EvidenceBundle } from '@patchproof/core';
import { renderTerminalReport } from '@patchproof/report';
import { hasOption, option, type ParsedArgs } from './args.js';

function rootFor(args: ParsedArgs): string {
  const supplied = option(args, 'root');
  if (supplied !== undefined && typeof supplied !== 'string')
    throw new Error('runs --root requires a path');
  return resolve(supplied ?? 'work/patchproof-run');
}

async function bundleFor(
  value: string,
  root: string,
): Promise<{ path: string; bundle: EvidenceBundle }> {
  const path = value.endsWith('.json')
    ? resolve(value)
    : join(
        /^[0-9a-f-]{36}$/iu.test(value) ? join(root, value) : resolve(value),
        'patchproof.evidence.json',
      );
  const verified = await verifyEvidenceBundle(path);
  if (!verified.valid) throw new Error(`Run evidence is invalid: ${verified.errors[0] ?? path}`);
  return { path, bundle: JSON.parse(await readFile(path, 'utf8')) as EvidenceBundle };
}

export async function runHistory(args: ParsedArgs): Promise<number> {
  const action = args.positional[0] ?? 'list';
  const root = rootFor(args);
  if (action === 'list') {
    let entries: Dirent[];
    try {
      if ((await lstat(root)).isSymbolicLink())
        throw new Error('Run history root must not be a link');
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entries = [];
    }
    const runs: Array<{ id: string; createdAt: string; outcome: string; path: string }> = [];
    for (const entry of entries.slice(0, 1_000)) {
      if (!entry.isDirectory()) continue;
      try {
        const item = await bundleFor(join(root, entry.name), root);
        runs.push({
          id: item.bundle.bundleId,
          createdAt: item.bundle.createdAt,
          outcome: item.bundle.outcome,
          path: item.path,
        });
      } catch {
        // Invalid or interrupted attempts are not counted as verified runs.
      }
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (hasOption(args, 'json')) process.stdout.write(`${JSON.stringify({ runs })}\n`);
    else
      console.log(
        runs.length === 0
          ? 'No verified runs found.'
          : runs
              .map((run) => `${run.createdAt}  ${run.outcome}  ${run.id}  ${run.path}`)
              .join('\n'),
      );
    return 0;
  }
  if (action === 'show') {
    const value = args.positional[1];
    if (value === undefined) throw new Error('runs show requires a bundle path or run directory');
    const { bundle } = await bundleFor(value, root);
    if (hasOption(args, 'json')) process.stdout.write(`${JSON.stringify(bundle)}\n`);
    else console.log(renderTerminalReport(bundle));
    return 0;
  }
  if (action === 'compare') {
    const [left, right] = args.positional.slice(1);
    if (left === undefined || right === undefined)
      throw new Error('runs compare requires two bundle paths or run directories');
    const [a, b] = await Promise.all([bundleFor(left, root), bundleFor(right, root)]);
    const comparison = {
      before: { id: a.bundle.bundleId, outcome: a.bundle.outcome, path: a.path },
      after: { id: b.bundle.bundleId, outcome: b.bundle.outcome, path: b.path },
      changed: a.bundle.outcome !== b.bundle.outcome,
      sameScenario: a.bundle.scenario.sha256 === b.bundle.scenario.sha256,
      sameBase: a.bundle.sources.base.sha256 === b.bundle.sources.base.sha256,
      sameHead: a.bundle.sources.head.sha256 === b.bundle.sources.head.sha256,
    };
    if (hasOption(args, 'json')) process.stdout.write(`${JSON.stringify(comparison)}\n`);
    else console.log(JSON.stringify(comparison, null, 2));
    return 0;
  }
  throw new Error('runs accepts list, show, or compare');
}
