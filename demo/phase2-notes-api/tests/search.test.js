/** 验收测试：搜索（禁止修改）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';

async function seed(app) {
  const notes = [
    { title: 'Node.js 学习', body: '内置模块与事件循环' },
    { title: '数据库设计', body: '索引与事务' },
    { title: '周报', body: '本周完成 node 服务开发' },
  ];
  for (const note of notes) {
    const res = await fetch(`${app.url}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note),
    });
    assert.equal(res.status, 201);
  }
}

test('GET /notes?q= 大小写不敏感匹配 title 与 body', async () => {
  const app = await startServer(0);
  try {
    await seed(app);
    const res = await fetch(`${app.url}/notes?q=NODE`);
    assert.equal(res.status, 200);
    const notes = await res.json();
    assert.deepEqual(notes.map((n) => n.title), ['Node.js 学习', '周报']);
  } finally {
    await app.close();
  }
});

test('GET /notes?q= 空关键字返回全部', async () => {
  const app = await startServer(0);
  try {
    await seed(app);
    const all = await (await fetch(`${app.url}/notes`)).json();
    for (const query of ['', '?q=']) {
      const res = await fetch(`${app.url}/notes${query.startsWith('?') ? query : '?q='}`);
      const notes = await res.json();
      assert.deepEqual(notes.map((n) => n.id), all.map((n) => n.id));
    }
  } finally {
    await app.close();
  }
});

test('GET /notes?q= 无匹配返回空数组', async () => {
  const app = await startServer(0);
  try {
    await seed(app);
    const notes = await (await fetch(`${app.url}/notes?q=不存在的关键字`)).json();
    assert.deepEqual(notes, []);
  } finally {
    await app.close();
  }
});
