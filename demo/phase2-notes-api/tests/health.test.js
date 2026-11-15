/** 验收测试：服务骨架与健康检查（禁止修改）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';

test('GET /health 返回服务健康信息', async () => {
  const app = await startServer(0);
  try {
    const res = await fetch(`${app.url}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await res.json(), { status: 'ok', service: 'notes-api' });
  } finally {
    await app.close();
  }
});

test('未知路径返回 404 JSON', async () => {
  const app = await startServer(0);
  try {
    const res = await fetch(`${app.url}/unknown-path`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  } finally {
    await app.close();
  }
});

test('startServer(0) 使用随机端口且可重复启动', async () => {
  const a = await startServer(0);
  const b = await startServer(0);
  try {
    assert.ok(a.port > 0 && b.port > 0);
    assert.notEqual(a.port, b.port);
    assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await a.close();
    await b.close();
  }
});
