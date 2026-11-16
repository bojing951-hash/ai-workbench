import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/events.js';
import { createLedger } from '../src/ledger.js';

test('task3: Ledger 正常流转并记录事件', () => {
  const ledger = createLedger(createStore());
  ledger.createTask('a', 'Alpha');
  ledger.startTask('a');
  ledger.completeTask('a');
  const state = ledger.getState();
  assert.equal(state.tasks.a.status, 'done');
  assert.equal(ledger.getEvents({ taskId: 'a' }).length, 3);
});

test('task3: 非法流转抛错且不写入事件', () => {
  const ledger = createLedger(createStore());
  assert.throws(() => ledger.startTask('missing'));
  ledger.createTask('b', 'Beta');
  ledger.blockTask('b', 'blocked by test');
  assert.throws(() => ledger.completeTask('b'));
  const events = ledger.getEvents({ taskId: 'b' });
  assert.deepEqual(events.map((e) => e.type), ['task.created', 'task.blocked']);
});
