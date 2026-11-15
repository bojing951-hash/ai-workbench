/** 验收测试：日志统计与过滤（禁止修改）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, summarizeLogs, filterByLevel } from '../src/index.js';

const SAMPLE = parseLog(
  [
    '2026-01-02T03:04:05Z INFO 启动',
    '2026-01-02T03:04:06Z WARN 慢查询',
    '2026-01-02T03:04:07Z ERROR 请求失败',
    '2026-01-02T03:04:08Z INFO 重试成功',
    '2026-01-02T03:04:09Z DEBUG 详细上下文',
  ].join('\n'),
);

test('summarizeLogs 返回完整统计', () => {
  const stats = summarizeLogs(SAMPLE);
  assert.equal(stats.total, 5);
  assert.deepEqual(stats.byLevel, { debug: 1, info: 2, warn: 1, error: 1 });
  assert.equal(stats.firstTimestamp, '2026-01-02T03:04:05Z');
  assert.equal(stats.lastTimestamp, '2026-01-02T03:04:09Z');
});

test('summarizeLogs 空数组时四类计数存在且时间戳为 null', () => {
  assert.deepEqual(summarizeLogs([]), {
    total: 0,
    byLevel: { debug: 0, info: 0, warn: 0, error: 0 },
    firstTimestamp: null,
    lastTimestamp: null,
  });
});

test('filterByLevel 按级别过滤，all 返回副本', () => {
  const warns = filterByLevel(SAMPLE, 'warn');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].message, '慢查询');

  const all = filterByLevel(SAMPLE, 'all');
  assert.equal(all.length, 5);
  assert.notEqual(all, SAMPLE, 'all 应返回新数组');

  assert.deepEqual(filterByLevel(SAMPLE, 'debug').map((e) => e.message), ['详细上下文']);
  assert.deepEqual(filterByLevel(SAMPLE, 'error').map((e) => e.message), ['请求失败']);
});
