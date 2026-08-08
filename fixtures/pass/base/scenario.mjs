import { readFileSync } from 'node:fs';

const behavior = readFileSync(new URL('./behavior.txt', import.meta.url), 'utf8').trim();
if (behavior === 'bug') {
  console.error('EXPECTED_BUG: parser accepted a malformed token');
  process.exit(1);
}
console.log('assertion passed: malformed token is rejected');
