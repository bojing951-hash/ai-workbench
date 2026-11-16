import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, appendEvent, readEvents } from '../src/events.js';

test('task1: appendEvent 分配递增 seq 并返回副本', () => {
  const store = createStore();
  const a = appendEvent(store, { type: 'task.created', taskId: 't1', payload: { title: 'A' } });
  const b = appendEvent(store, { type: 'task.started', taskId: 't1' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(store.events.length, 2);
  a.type = 'mutated';
  assert.equal(store.events[0].type, 'task.created');
});

test('task1: appendEvent 校验必填字段与允许类型', () => {
  const store = createStore();
  assert.throws(() => appendEvent(store, null));
  assert.throws(() => appendEvent(store, { type: '', taskId: 't1' }));
  assert.throws(() => appendEvent(store, { type: 'task.created' }));
  assert.throws(() => appendEvent(store, { type: 'unknown', taskId: 't1' }));
  assert.throws(() => appendEvent(store, { type: 'task.created', taskId: 't1', payload: { title: '' } }));
});

test('task1: readEvents 可按 taskId 过滤并返回副本', () => {
  const store = createStore();
  appendEvent(store, { type: 'task.created', taskId: 't1', payload: { title: 'A' } });
  appendEvent(store, { type: 'task.created', taskId: 't2', payload: { title: 'B' } });
  appendEvent(store, { type: 'task.started', taskId: 't1' });
  const t1 = readEvents(store, { taskId: 't1' });
  assert.equal(t1.length, 2);
  assert.deepEqual(t1.map((e) => e.type), ['task.created', 'task.started']);
  t1[0].type = 'mutated';
  assert.equal(store.events[0].type, 'task.created');
});
