import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(process.cwd(), 'src', 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('task5: CLI 通过文件持久化 create/start/complete/list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-'));
  const file = path.join(dir, 'events.json');
  let r = run(['--file', file, 'create', '--id', 'a', '--title', 'Alpha']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--file', file, 'start', '--id', 'a']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--file', file, 'complete', '--id', 'a']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--file', file, 'list']);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.total, 1);
  assert.equal(data.completed, 1);
  assert.equal(data.tasks.a.status, 'done');
});
