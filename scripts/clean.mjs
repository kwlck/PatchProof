import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const targets = [
  join(root, 'packages', 'core', 'dist'),
  join(root, 'packages', 'config', 'dist'),
  join(root, 'packages', 'runner', 'dist'),
  join(root, 'packages', 'report', 'dist'),
  join(root, 'packages', 'github', 'dist'),
  join(root, 'packages', 'testkit', 'dist'),
  join(root, 'packages', 'cli', 'dist'),
  join(root, 'apps', 'github-app', 'dist'),
];
for (const target of targets) await rm(target, { recursive: true, force: true });
console.log(`Removed ${targets.length} known build directories`);
