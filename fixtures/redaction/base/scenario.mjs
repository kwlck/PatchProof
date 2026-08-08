if (process.env.PATCHPROOF_REVISION === 'base') {
  process.stderr.write('EXPECTED_BUG fixture-secret-' + '123456789');
  process.exit(1);
}
console.log('fixed fixture-secret-123456789');
