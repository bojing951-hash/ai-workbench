import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, appendEvent } from '../src/events.js';
import { reduceState } from '../src/state.js';

test('task2: reduceState 按事件归约任务状态与计数', () => {
  const store = createStore();
  appendEvent(store, { type: 'task.created', taskId: 'a', payload: { title: 'Alpha' } });
  appendEvent(store, { type: 'task.created', taskId: 'b', payload: { title: 'Beta' } });
  appendEvent(store, { type: 'task.started', taskId: 'a' });
  appendEvent(store, { type: 'task.completed', taskId: 'a' });
  appendEvent(store, { type: 'task.blocked', taskId: 'b', payload: { reason: 'wait' } });
  const state = reduceState(store.events);
  assert.equal(state.tasks.a.title, 'Alpha');
  assert.equal(state.tasks.a.status, 'done');
  assert.equal(state.tasks.b.status, 'blocked');
  assert.deepEqual(state.counts, { pending: 0, running: 0, done: 1, blocked: 1 });
});

test('task2: 乱序/重复事件不破坏状态（后到 started 不覆盖 done）', () => {
  const state = reduceState([
    { seq: 1, type: 'task.created', taskId: 'x', payload: { title: 'X' } },
    { seq: 2, type: 'task.completed', taskId: 'x' },
    { seq: 3, type: 'task.started', taskId: 'x' },
  ]);
  assert.equal(state.tasks.x.status, 'done');
});
