/** 验收测试：笔记 CRUD（禁止修改）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';

async function withServer(fn) {
  const app = await startServer(0);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test('POST /notes 创建笔记并返回 201 与完整字段', async () => {
  await withServer(async (app) => {
    const res = await fetch(`${app.url}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '第一条笔记', body: '内容' }),
    });
    assert.equal(res.status, 201);
    const note = await res.json();
    assert.equal(note.title, '第一条笔记');
    assert.equal(note.body, '内容');
    assert.ok(typeof note.id === 'string' && note.id.length > 0);
    assert.ok(!Number.isNaN(Date.parse(note.createdAt)));
  });
});

test('POST /notes 校验 title', async () => {
  await withServer(async (app) => {
    for (const payload of [{ body: 'x' }, { title: '' }, { title: '   ' }, { title: 123 }]) {
      const res = await fetch(`${app.url}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'invalid_title' });
    }
  });
});

test('POST /notes 缺省 body 为空字符串', async () => {
  await withServer(async (app) => {
    const res = await fetch(`${app.url}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '无正文' }),
    });
    assert.equal(res.status, 201);
    const note = await res.json();
    assert.equal(note.body, '');
  });
});

test('GET /notes 返回全部笔记且顺序稳定', async () => {
  await withServer(async (app) => {
    for (const title of ['A', 'B', 'C']) {
      const res = await fetch(`${app.url}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      assert.equal(res.status, 201);
    }
    const res = await fetch(`${app.url}/notes`);
    assert.equal(res.status, 200);
    const notes = await res.json();
    assert.deepEqual(notes.map((n) => n.title), ['A', 'B', 'C']);
    assert.equal(new Set(notes.map((n) => n.id)).size, 3);
  });
});

test('GET /notes/:id 返回单条或 404', async () => {
  await withServer(async (app) => {
    const created = await (
      await fetch(`${app.url}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '单条' }),
      })
    ).json();
    const found = await fetch(`${app.url}/notes/${created.id}`);
    assert.equal(found.status, 200);
    assert.equal((await found.json()).id, created.id);
    const missing = await fetch(`${app.url}/notes/does-not-exist`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not_found' });
  });
});

test('DELETE /notes/:id 删除笔记，重复删除返回 404', async () => {
  await withServer(async (app) => {
    const created = await (
      await fetch(`${app.url}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '待删除' }),
      })
    ).json();
    const del = await fetch(`${app.url}/notes/${created.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    const again = await fetch(`${app.url}/notes/${created.id}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
    const list = await (await fetch(`${app.url}/notes`)).json();
    assert.equal(list.length, 0);
  });
});
