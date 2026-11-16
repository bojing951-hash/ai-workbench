import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/report.js';

test('task4: buildReport 汇总状态与完成率', () => {
  const state = {
    tasks: {
      a: { title: 'A', status: 'done' }, b: { title: 'B', status: 'done' }, c: { title: 'C', status: 'blocked' }, d: { title: 'D', status: 'running' }, e: { title: 'E', status: 'pending' },
    },
    counts: { done: 2, blocked: 1, running: 1, pending: 1 },
  };
  const r = buildReport(state);
  assert.equal(r.total, 5);
  assert.equal(r.completed, 2);
  assert.equal(r.blocked, 1);
  assert.equal(r.running, 1);
  assert.equal(r.pending, 1);
  assert.equal(r.completionRate, 40);
  assert.deepEqual(r.byStatus, { done: 2, blocked: 1, running: 1, pending: 1 });
});

test('task4: 空状态安全返回 0', () => {
  const r = buildReport({ tasks: {}, counts: {} });
  assert.equal(r.total, 0);
  assert.equal(r.completionRate, 0);
});
