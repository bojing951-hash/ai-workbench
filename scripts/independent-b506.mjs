import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previous = 'dd68e7916e3aa6f4a72403dc400604e02170717e';
const files = [
  'tests/freeze-checkpoint-owner.test.js', 'tests/freeze-final-evidence.test.js',
  'tests/freeze-ledger-upgrade.test.js', 'tests/freeze-loop-recovery.test.mjs',
  'tests/freeze-unknown-reservation.test.js',
];
const scratch = mkdtempSync(path.join(os.tmpdir(), 'wb-upgrade-baseline-'));
try {
  const supplied = process.env.WB_PRIOR_REPO;
  if (!supplied) {
    const archive = spawnSync('git', ['archive', previous, 'src', 'package.json'], {maxBuffer: 16 * 1024 * 1024});
    if (archive.error || archive.status !== 0) throw new Error(String(archive.error || archive.stderr));
    const extract = spawnSync('tar', ['-xf', '-', '-C', scratch], {input: archive.stdout});
    if (extract.error || extract.status !== 0) throw new Error(String(extract.error || extract.stderr));
  }
  const env = {PATH: process.env.PATH, HOME: scratch, WB_PRIOR_REPO: supplied || scratch};
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {stdio: 'inherit', env});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, {recursive: true, force: true});
}
