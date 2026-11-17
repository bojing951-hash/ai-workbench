// 静态检查: 页面结构可运行、无任何网络请求逻辑、UI 完整接线
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('index.html: 可直接打开且包含全部核心控件与本地脚本', () => {
  const html = read('index.html');
  const requiredIds = [
    'record-form', 'record-amount', 'record-category', 'record-date', 'record-note',
    'submit-button', 'cancel-edit-button', 'record-list',
    'range-select', 'range-start', 'range-end', 'custom-range',
    'total-income', 'total-expense', 'total-balance',
    'alerts', 'alert-list', 'category-breakdown',
    'settings-form', 'setting-budget', 'setting-large', 'setting-floor'
  ];
  for (const id of requiredIds) {
    assert.ok(html.includes('id="' + id + '"'), 'index.html 缺少 #' + id);
  }
  assert.ok(html.includes('name="record-type"'), '缺少收支类型单选框');
  assert.ok(html.includes('script src="js/store.js"'));
  assert.ok(html.includes('script src="js/ui.js"'));
  assert.ok(html.includes('css/style.css'));
  for (const file of ['index.html', 'js/store.js', 'js/ui.js', 'css/style.css']) {
    assert.ok(fs.existsSync(path.join(root, file)), file + ' 必须存在');
  }
  // 不引用任何外部资源，保证 file:// 直开可用
  assert.ok(!html.includes('http://') && !html.includes('https://'), '页面不应引用外部网络资源');
});

test('安全约束: 全部产品源码不包含任何网络请求逻辑', () => {
  const banned = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'axios', 'xhr', 'navigator.onLine'];
  for (const file of ['index.html', 'js/store.js', 'js/ui.js', 'css/style.css']) {
    const source = read(file);
    for (const marker of banned) {
      assert.ok(!source.includes(marker), file + ' 不应包含网络相关代码: ' + marker);
    }
  }
});

test('UI 接线: 增删改、持久化与渲染均已在事件中绑定', () => {
  const ui = read('js/ui.js');
  for (const needle of [
    'store.addRecord(',
    'store.updateRecord(',
    'store.deleteRecord(',
    'renderRecords',
    'createStore(defaultStorage())',
    'global.localStorage',
    "addEventListener('submit'",
    "addEventListener('click'",
    'data-action',
    'edit',
    'delete'
  ]) {
    assert.ok(ui.includes(needle), 'ui.js 缺少关键接线: ' + needle);
  }
  const store = read('js/store.js');
  assert.ok(store.includes('global.ExpenseStore'), 'store.js 应把核心模块挂到全局供页面使用');
  assert.ok(store.includes('RECORDS_KEY'), 'store.js 应定义 localStorage 键名');
});
