/**
 * TaskVault 验收测试（已评审，禁止修改）。
 * 这些测试定义交付标准：测试通过 + 独立审计通过才算完成任务。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/store.js';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskvault-'));
  return path.join(dir, 'tasks.json');
}

test('addTask 生成唯一任务并去除标题首尾空白', () => {
  const store = new TaskStore();
  const first = store.addTask('  写周报  ');
  const second = store.addTask('写周报');
  assert.equal(first.title, '写周报');
  assert.equal(first.completed, false);
  assert.ok(first.id && second.id);
  assert.notEqual(first.id, second.id);
  assert.ok(!Number.isNaN(Date.parse(first.createdAt)), 'createdAt 必须是合法时间');
});

test('addTask 拒绝空标题', () => {
  const store = new TaskStore();
  assert.throws(() => store.addTask('   '));
  assert.throws(() => store.addTask(''));
});

test('completeTask 标记完成并拒绝未知 ID', () => {
  const store = new TaskStore();
  const task = store.addTask('完成测试');
  const updated = store.completeTask(task.id);
  assert.equal(updated.completed, true);
  const listed = store.listTasks();
  assert.equal(listed[0].completed, true);
  assert.throws(() => store.completeTask('not-exist'));
});

test('listTasks 支持 all/open/done 过滤', () => {
  const store = new TaskStore();
  const a = store.addTask('任务A');
  store.addTask('任务B');
  store.completeTask(a.id);
  assert.equal(store.listTasks().length, 2);
  assert.equal(store.listTasks({ status: 'all' }).length, 2);
  assert.equal(store.listTasks({ status: 'open' }).length, 1);
  assert.equal(store.listTasks({ status: 'done' }).length, 1);
  assert.equal(store.listTasks({ status: 'open' })[0].title, '任务B');
});

test('stats 返回 total/open/done 统计', () => {
  const store = new TaskStore();
  assert.deepEqual(store.stats(), { total: 0, open: 0, done: 0 });
  const t = store.addTask('统计任务');
  store.addTask('未完成任务');
  store.completeTask(t.id);
  assert.deepEqual(store.stats(), { total: 2, open: 1, done: 1 });
});

test('JSON 文件持久化：重新加载后任务与完成状态保留', () => {
  const file = tempFile();
  const store = new TaskStore(file);
  const task = store.addTask('持久化任务');
  store.completeTask(task.id);
  const reloaded = new TaskStore(file);
  const tasks = reloaded.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, '持久化任务');
  assert.equal(tasks[0].completed, true);
  assert.equal(reloaded.stats().done, 1);
});
