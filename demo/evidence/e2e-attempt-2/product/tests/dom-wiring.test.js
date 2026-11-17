'use strict';

// 产品测试：页面接线与静态安全 —— app.js 查询的 DOM id 必须存在于 index.html，
// 渲染层不使用 innerHTML / 内联事件，资源引用全部为相对路径，样式含响应式断点。
// 运行方式：node --test tests/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

test('接线完整：app.js 引用的每个 DOM id 都存在于 index.html', () => {
  const referenced = new Set();
  const pattern = /byId\('([^']+)'\)/g;
  let match;
  while ((match = pattern.exec(js)) !== null) referenced.add(match[1]);
  assert.ok(referenced.size >= 20, 'app.js 应至少引用 20 个元素，实际 ' + referenced.size);
  for (const id of referenced) {
    assert.ok(html.includes('id="' + id + '"'), 'index.html 缺少 app.js 引用的 #' + id);
  }
});

test('渲染安全：不使用 innerHTML 赋值、内联事件或 javascript: 伪协议', () => {
  assert.equal(/innerHTML\s*=/.test(js), false, 'app.js 不得使用 innerHTML 赋值');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'index.html 不得使用内联事件处理器');
  assert.equal(/javascript:/i.test(html), false, 'index.html 不得使用 javascript: 伪协议');
});

test('资源引用：脚本与样式均为相对路径，且无任何绝对地址外链', () => {
  assert.ok(/<script\s+src="app\.js"/.test(html), '应以相对路径加载 app.js');
  assert.ok(/<link\s+rel="stylesheet"\s+href="styles\.css"/.test(html), '应以相对路径加载 styles.css');
  assert.equal(/(src|href)\s*=\s*["'](\w+:)?\/\//i.test(html), false, '不得引用任何绝对地址资源');
});

test('响应式与可用性基线：viewport、lang 声明与窄屏 / 宽屏媒体查询齐备', () => {
  assert.ok(/name="viewport"/.test(html), '页面需要 viewport meta 以支持窄屏自适应');
  assert.ok(/<html\s+lang="zh-CN">/.test(html), '页面应声明 lang="zh-CN"');
  assert.ok(/@media\s*\(max-width/.test(css), 'styles.css 需要窄屏媒体查询');
  assert.ok(/@media\s*\(min-width/.test(css), 'styles.css 需要宽屏媒体查询');
});

test('内置分类均可通过校验写入记录（表单选项与校验层一致）', () => {
  const app = require(path.join(root, 'app.js'));
  assert.ok(Array.isArray(app.CATEGORY_MAP.expense) && app.CATEGORY_MAP.expense.length >= 6);
  assert.ok(Array.isArray(app.CATEGORY_MAP.income) && app.CATEGORY_MAP.income.length >= 4);
  app.CATEGORY_MAP.expense.forEach(function (name) {
    const result = app.addRecord(createStorage(), {
      type: 'expense', amount: '10', date: '2026-11-17', category: name, note: ''
    });
    assert.equal(result.ok, true, '支出分类「' + name + '」应能通过校验');
  });
  app.CATEGORY_MAP.income.forEach(function (name) {
    const result = app.addRecord(createStorage(), {
      type: 'income', amount: '10', date: '2026-11-17', category: name, note: ''
    });
    assert.equal(result.ok, true, '收入分类「' + name + '」应能通过校验');
  });
});

function createStorage() {
  const data = new Map();
  return {
    getItem: function (key) { return data.has(key) ? data.get(key) : null; },
    setItem: function (key, value) { data.set(key, String(value)); },
    removeItem: function (key) { data.delete(key); },
    clear: function () { data.clear(); }
  };
}
