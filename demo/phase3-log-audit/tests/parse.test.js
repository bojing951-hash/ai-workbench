/** 验收测试：日志解析（禁止修改）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogLine, parseLog } from '../src/index.js';

test('parseLogLine 解析标准日志行', () => {
  const entry = parseLogLine('2026-01-02T03:04:05Z INFO 服务启动完成');
  assert.deepEqual(entry, {
    timestamp: '2026-01-02T03:04:05Z',
    level: 'info',
    message: '服务启动完成',
  });
});

test('parseLogLine 级别大小写不敏感且输出小写', () => {
  for (const level of ['DEBUG', 'Info', 'WARN', 'error']) {
    const entry = parseLogLine(`2026-01-02T03:04:05Z ${level} 消息`);
    assert.equal(entry.level, level.toLowerCase());
  }
});

test('parseLogLine 非法输入返回 null', () => {
  const invalid = [
    '',
    '   ',
    'not a log line',
    '2026-01-02T03:04:05Z VERBOSE 未知级别',
    '2026-99-99T99:99:99Z INFO 非法时间',
  ];
  for (const line of invalid) assert.equal(parseLogLine(line), null, `应返回 null: ${line}`);
});

test('parseLog 解析多行并过滤非法行', () => {
  const text = [
    '2026-01-02T03:04:05Z INFO 第一条',
    'garbage line',
    '',
    '2026-01-02T03:04:06Z WARN 第二条',
    '2026-01-02T03:04:07Z ERROR 第三条',
  ].join('\n');
  const entries = parseLog(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.level), ['info', 'warn', 'error']);
  assert.deepEqual(entries.map((e) => e.message), ['第一条', '第二条', '第三条']);
});
