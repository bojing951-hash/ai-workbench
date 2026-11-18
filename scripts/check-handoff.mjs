import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Run from the repository root. The filenames are explicit so a missing group cannot silently pass.
const files = [
  'handoff-product-plan.test.js',
  'handoff-test-evidence.test.js',
  'handoff-audit-chunks.test.js',
  'handoff-billing.test.js',
  'handoff-identity.test.js',
  'handoff-recovery-checkpoint.test.js',
  'handoff-recovery-commit.test.js',
  'handoff-supervisor.test.mjs',
].map(name => 'tests/' + name);
for (const file of files) {
  if (!existsSync(file)) throw new Error('Missing independent regression file: ' + file);
}
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const run = spawnSync(process.execPath, [
  '--test', '--test-concurrency=4', '--test-reporter=tap', ...files,
], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
if (run.error) throw run.error;
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
const count = key => {
  const match = run.stdout.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'));
  return match ? Number(match[1]) : NaN;
};
const executed = count('tests');
const clean = executed >= 23 && count('pass') === executed
  && ['fail', 'cancelled', 'skipped', 'todo'].every(key => count(key) === 0);
process.exitCode = run.status === 0 && clean ? 0 : 1;
