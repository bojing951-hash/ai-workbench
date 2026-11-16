// SPDX-License-Identifier: Apache-2.0
/** v2.8 P0-2：真实子进程 SIGKILL 注入（pending 前后），重启恢复不丢任务/不重复 Run。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openStore } from '../src/db.js';

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-crash-'));
  return { root, db: path.join(root, 'wb.db') };
}
function seed(db) {
  const store = openStore(db);
  store.createProject({ id: 'p', name: 'p', localPath: '/tmp/none', testCommand: 'true' });
  store.createLoop({ id: 'loop', projectId: 'p', goal: 'g', mode: 'queue', maxRounds: 3, queue: [{ title: '关键任务', qualityIssueId: 'Q1' }] });
  store.close();
}
async function childCrash({ db, afterRun }) {
  const dbUrl = pathToFileURL(path.resolve('src/db.js')).href;
  const code = `
    import { openStore } from ${JSON.stringify(dbUrl)};
    const s = openStore(process.env.DB_PATH);
    const requestKey = 'crash-key-${afterRun ? 'after' : 'before'}';
    s.setLoopPending('loop', { task: { title: '关键任务', qualityIssueId: 'Q1' }, queueIndex: 0, requestKey });
    ${afterRun ? "s.createRun({ id: 'run-created-before-crash', projectId: 'p', planId: 'plan1', goal: 'g', mode: 'single', status: 'queued', requestKey }); s.createTasks([{ id: 'task-created-before-crash', projectId: 'p', planId: 'plan1', runId: 'run-created-before-crash', seq: 1, title: '关键任务', acceptance: ['a'], testCommand: 'true', status: 'queued' }]);" : ''}
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', code], { env: { ...process.env, DB_PATH: db }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child ready timeout')), 10000);
    child.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(timer); resolve(); } });
    child.on('error', reject);
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
}

test('v2.8 P0-2：SIGKILL 在 startRun 前，pending 任务恢复队列不丢失', async () => {
  const { db } = tmp(); seed(db);
  await childCrash({ db, afterRun: false });
  const store = openStore(db);
  try {
    const rec = store.recoverLoopPending('loop');
    assert.equal(rec.restored, true);
    assert.equal(store.getLoop('loop').queue_json[0].title, '关键任务');
    assert.equal(store.getLoop('loop').current_run_id, '');
  } finally { store.close(); }
});

test('v2.8 P0-2：SIGKILL 在 startRun 后，requestKey 绑定既有 Run，不重复创建/不丢队列工单', async () => {
  const { db } = tmp(); seed(db);
  await childCrash({ db, afterRun: true });
  const store = openStore(db);
  try {
    const rec = store.recoverLoopPending('loop');
    assert.equal(rec.linked, true);
    assert.equal(rec.runId, 'run-created-before-crash');
    const loop = store.getLoop('loop');
    assert.equal(loop.current_run_id, 'run-created-before-crash');
    assert.equal(loop.queue_json.length, 0);
    assert.equal(store.getRunByRequestKey('crash-key-after').id, 'run-created-before-crash');
  } finally { store.close(); }
});
