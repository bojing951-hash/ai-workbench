'use strict';

// 产品测试：DOM 级端到端流程（内置轻量假 DOM，零依赖）——直接驱动 app.js 的 initDom：
// 提交合法记录 -> 写入 localStorage -> 模拟刷新后重新渲染；非法输入 -> 字段错误显示且不写入；
// 编辑回填两位小数、删除、时间范围筛选、阈值设置与预警渲染、损坏 localStorage 数据规范化。
// 运行方式：node --test tests/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'app.js');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// 逻辑模式（无 window/document）下的公共 API，供单元级断言使用
const app = require(APP_PATH);

/* ------------------------------ 轻量假 DOM ------------------------------ */

const VOID_TAGS = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);

class FakeElement {
  constructor(tagName, id) {
    this.tagName = tagName;
    this.id = id || '';
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.className = '';
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.selected = false;
    this.type = '';
    this.colSpan = null;
    this._listeners = {};
    const self = this;
    this.classList = {
      toggle: function (name, force) {
        const parts = self.className ? self.className.split(/\s+/).filter(Boolean) : [];
        const has = parts.indexOf(name) !== -1;
        const want = force === undefined ? !has : Boolean(force);
        if (want && !has) parts.push(name);
        if (!want && has) parts.splice(parts.indexOf(name), 1);
        self.className = parts.join(' ');
        return want;
      }
    };
  }

  get firstChild() {
    return this.children[0] || null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (child.tagName === 'option' && child.selected) this.value = child.value;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }

  fire(type, event) {
    const evt = event || {};
    if (typeof evt.preventDefault !== 'function') evt.preventDefault = function () {};
    (this._listeners[type] || []).slice().forEach(function (handler) { handler(evt); });
    return evt;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (selector === 'button[data-action]') {
        if (node.tagName === 'button' && node.dataset && node.dataset.action != null) return node;
      } else if (node.tagName === selector) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  reset() {
    const walk = function (el) {
      el.children.forEach(function (child) {
        if (child.tagName === 'input' || child.tagName === 'select') child.value = '';
        walk(child);
      });
    };
    walk(this);
  }
}

/** 从真实 index.html 解析出带层级与 id 的元素树（忽略文本节点，足够驱动 initDom）。 */
function buildDocument() {
  const root = new FakeElement('#document', '');
  const stack = [root];
  const byIdMap = {};
  const tagPattern = /<\/?(\w+)[^>]*>/g;
  let match;
  while ((match = tagPattern.exec(HTML)) !== null) {
    const token = match[0];
    const tag = match[1].toLowerCase();
    if (token.startsWith('</')) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tagName === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const idMatch = /\bid="([^"]+)"/.exec(token);
    const el = new FakeElement(tag, idMatch ? idMatch[1] : '');
    stack[stack.length - 1].appendChild(el);
    if (!VOID_TAGS.has(tag)) stack.push(el);
    if (el.id) byIdMap[el.id] = el;
  }
  return {
    readyState: 'complete',
    getElementById: function (id) { return byIdMap[id] || null; },
    createElement: function (tag) { return new FakeElement(String(tag).toLowerCase(), ''); },
    addEventListener: function () {}
  };
}

/* ------------------------------ 环境装配 ------------------------------ */

function createStorage() {
  const data = new Map();
  return {
    getItem: function (key) { return data.has(key) ? data.get(key) : null; },
    setItem: function (key, value) { data.set(key, String(value)); },
    removeItem: function (key) { data.delete(key); },
    clear: function () { data.clear(); }
  };
}

/** 以假 window/document 重新加载 app.js，让 initDom 在指定 storage 上启动。 */
function bootApp(storage) {
  delete require.cache[require.resolve(APP_PATH)];
  global.document = buildDocument();
  global.window = {
    localStorage: storage,
    confirm: function () { return true; }
  };
  const domApp = require(APP_PATH);
  return domApp;
}

function teardownApp() {
  delete global.window;
  delete global.document;
  delete require.cache[require.resolve(APP_PATH)];
}

function element(id) {
  return global.document.getElementById(id);
}

function submitForm(id) {
  let prevented = false;
  element(id).fire('submit', { preventDefault: function () { prevented = true; } });
  return prevented;
}

function fillRecordForm(type, amount, date, category, note) {
  element('record-type').value = type;
  element('record-amount').value = amount;
  element('record-date').value = date;
  element('record-category').value = category;
  element('record-note').value = note;
}

function rowCells(row) {
  return row.children.map(function (td) { return td.textContent; });
}

function findActionButtons(row) {
  const actions = row.children[row.children.length - 1];
  const buttons = {};
  actions.children.forEach(function (btn) { buttons[btn.dataset.action] = btn; });
  return buttons;
}

function currentMonthDate(day) {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(day).padStart(2, '0');
}

/* ------------------------------ 测试用例 ------------------------------ */

test('DOM 流程：提交合法记录写入 localStorage，模拟刷新后列表与看板仍渲染', () => {
  const storage = createStorage();
  bootApp(storage);
  fillRecordForm('income', '200.5', '2026-11-17', '工资', '兼职');
  const prevented = submitForm('record-form');
  assert.equal(prevented, true, '提交应 preventDefault，不发起导航或网络请求');

  const saved = JSON.parse(storage.getItem(app.STORAGE_KEY_RECORDS));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].amount, 200.5);
  assert.equal(saved[0].date, '2026-11-17');
  assert.equal(element('record-list').children.length, 1);
  assert.equal(element('record-form-message').textContent, '记录已添加。');

  // 模拟刷新页面：同一 localStorage，全新 document 重新初始化 app.js
  bootApp(storage);
  const rows = element('record-list').children;
  assert.equal(rows.length, 1, '刷新后记录行仍存在');
  assert.deepEqual(rowCells(rows[0]).slice(0, 5), ['收入', '+200.50', '2026-11-17', '工资', '兼职']);
  assert.equal(element('summary-income').textContent, '200.50');
  assert.equal(element('summary-expense').textContent, '0.00');
  assert.equal(element('summary-balance').textContent, '200.50');
  assert.equal(element('alerts-list').children[0].textContent, '暂无预警');
  teardownApp();
});

test('DOM 流程：非法金额 / 日期 / 分类 / 备注提交时显示明确错误，且不写入 localStorage', () => {
  const storage = createStorage();
  bootApp(storage);

  fillRecordForm('expense', '-5', '2026/11/17', '餐饮', '');
  submitForm('record-form');
  assert.ok(element('record-amount-error').textContent.indexOf('负数') !== -1, '负数金额需有明确提示');
  assert.ok(element('record-date-error').textContent.indexOf('YYYY-MM-DD') !== -1, '非法日期需有明确提示');
  assert.ok(element('record-form-message').textContent.length > 0);
  assert.equal(storage.getItem(app.STORAGE_KEY_RECORDS), null, '非法输入不得写入 localStorage');
  assert.equal(element('record-list').children[0].children[0].textContent, '暂无记录');

  fillRecordForm('expense', '12.5', '2026-11-17', '   ', 'x'.repeat(101));
  submitForm('record-form');
  assert.ok(element('record-category-error').textContent.length > 0, '空分类需有明确提示');
  assert.ok(element('record-note-error').textContent.length > 0, '超长备注需有明确提示');
  assert.equal(storage.getItem(app.STORAGE_KEY_RECORDS), null, '非法输入不得写入 localStorage');
  teardownApp();
});

test('DOM 流程与单元边界：Infinity 级超大金额 / 阈值被拒绝且不写入', () => {
  const storage = createStorage();
  bootApp(storage);
  fillRecordForm('expense', '9'.repeat(400), '2026-11-17', '餐饮', '');
  submitForm('record-form');
  assert.ok(element('record-amount-error').textContent.indexOf('范围') !== -1, '超大金额需有明确提示');
  assert.equal(storage.getItem(app.STORAGE_KEY_RECORDS), null);
  teardownApp();

  const atMax = app.validateRecordInput(
    { type: 'expense', amount: '100000000000', date: '2026-11-17', category: '餐饮', note: '' });
  assert.equal(atMax.ok, true, '恰好等于上限应合法');
  assert.equal(atMax.record.amount, 100000000000);
  const overMax = app.validateRecordInput(
    { type: 'expense', amount: '100000000000.01', date: '2026-11-17', category: '餐饮', note: '' });
  assert.equal(overMax.ok, false, '超过上限应拒绝');
  assert.ok(overMax.errors.amount.length > 0);

  const hugeSettings = app.validateSettingsInput(
    { monthlyBudget: '9'.repeat(400), singleExpenseThreshold: '', minBalance: '' });
  assert.equal(hugeSettings.ok, false, '超大阈值应拒绝');
  assert.ok(hugeSettings.errors.monthlyBudget.length > 0);
});

test('DOM 流程：编辑回填两位小数金额，保存修改后列表与看板更新', () => {
  const storage = createStorage();
  bootApp(storage);
  fillRecordForm('expense', '32.5', '2026-11-01', '餐饮', '午饭');
  submitForm('record-form');

  const row = element('record-list').children[0];
  const recordId = row.dataset.id;
  const buttons = findActionButtons(row);
  element('record-list').fire('click', { target: buttons.edit });
  assert.equal(element('record-amount').value, '32.50', '编辑回填应为两位小数');
  assert.equal(element('record-date').value, '2026-11-01');
  assert.equal(element('record-submit').textContent, '保存修改');
  assert.equal(element('record-cancel').hidden, false);

  element('record-amount').value = '88.8';
  submitForm('record-form');
  const records = app.getRecords(storage);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, recordId);
  assert.equal(records[0].amount, 88.8);
  const updatedRow = element('record-list').children[0];
  assert.equal(rowCells(updatedRow)[1], '-88.80');
  assert.equal(element('summary-expense').textContent, '88.80');
  teardownApp();
});

test('DOM 流程：删除记录（confirm 确认）后列表清空、看板归零', () => {
  const storage = createStorage();
  bootApp(storage);
  fillRecordForm('expense', '15', '2026-11-02', '交通', '');
  submitForm('record-form');
  assert.equal(app.getRecords(storage).length, 1);

  const row = element('record-list').children[0];
  const buttons = findActionButtons(row);
  element('record-list').fire('click', { target: buttons.delete });
  assert.deepEqual(app.getRecords(storage), []);
  assert.equal(element('record-list').children[0].children[0].textContent, '暂无记录');
  assert.equal(element('summary-expense').textContent, '0.00');
  teardownApp();
});

test('DOM 流程：时间范围筛选改变可见记录与统计，非法范围显示错误且不改变列表', () => {
  const storage = createStorage();
  bootApp(storage);
  fillRecordForm('expense', '10', '2026-11-01', '餐饮', '');
  submitForm('record-form');
  fillRecordForm('expense', '20', '2026-10-15', '交通', '');
  submitForm('record-form');
  assert.equal(element('record-list').children.length, 2);

  element('filter-start').value = '2026-11-01';
  submitForm('filter-form');
  assert.equal(element('record-list').children.length, 1, '仅显示范围内的记录');
  assert.equal(rowCells(element('record-list').children[0])[2], '2026-11-01');
  assert.equal(element('summary-expense').textContent, '10.00', '看板随筛选范围更新');

  element('filter-start').value = '2026/11/01';
  submitForm('filter-form');
  assert.ok(element('filter-error').textContent.indexOf('YYYY-MM-DD') !== -1, '非法范围需明确报错');
  assert.equal(element('record-list').children.length, 1, '非法筛选不得改变列表');

  element('filter-reset').fire('click');
  assert.equal(element('record-list').children.length, 2, '重置后恢复全部记录');
  assert.equal(element('summary-expense').textContent, '30.00');
  teardownApp();
});

test('DOM 流程：保存阈值设置后渲染预警，非法阈值显示错误且不覆盖已保存设置', () => {
  const storage = createStorage();
  bootApp(storage);
  fillRecordForm('expense', '150.5', currentMonthDate(5), '购物', '');
  submitForm('record-form');
  assert.equal(element('alerts-list').children[0].textContent, '暂无预警', '未设置阈值时不产生预警');

  element('setting-monthly-budget').value = '100';
  submitForm('settings-form');
  const savedSettings = JSON.parse(storage.getItem(app.STORAGE_KEY_SETTINGS));
  assert.equal(savedSettings.monthlyBudget, 100);
  const alertItems = element('alerts-list').children;
  assert.equal(alertItems.length, 1, '预算超支应产生一条预警');
  assert.equal(alertItems[0].className, 'alert-item alert-danger');
  assert.ok(alertItems[0].textContent.indexOf('150.50') !== -1, '预警消息金额为两位小数');
  assert.ok(alertItems[0].textContent.indexOf('100.00') !== -1, '阈值金额为两位小数');

  element('setting-monthly-budget').value = '-1';
  submitForm('settings-form');
  assert.ok(element('setting-monthly-budget-error').textContent.indexOf('负数') !== -1);
  assert.equal(JSON.parse(storage.getItem(app.STORAGE_KEY_SETTINGS)).monthlyBudget, 100,
    '非法阈值不得覆盖已保存设置');
  teardownApp();
});

test('持久化数据规范化：损坏的金额 / 日期 / 缺 id 记录在读取与渲染时被剔除', () => {
  const storage = createStorage();
  // 模拟审计指出的真实损坏场景：Infinity 被 JSON.stringify 写成 null，以及 1e999 溢出、非法日期、缺 id
  storage.setItem(app.STORAGE_KEY_RECORDS,
    '[{"id":"a","type":"expense","amount":null,"date":"2026-11-17","category":"餐饮","note":""},' +
    '{"id":"b","type":"expense","amount":12.5,"date":"2026/11/17","category":"餐饮","note":""},' +
    '{"type":"expense","amount":9.9,"date":"2026-11-17","category":"餐饮","note":""},' +
    '{"id":"d","type":"expense","amount":1e999,"date":"2026-11-17","category":"餐饮","note":""},' +
    '{"id":"e","type":"expense","amount":9.9,"date":"2026-11-17","category":"餐饮","note":"ok"}]');

  const records = app.getRecords(storage);
  assert.equal(records.length, 1, '仅保留合法记录');
  assert.equal(records[0].id, 'e');
  assert.equal(records[0].amount, 9.9);
  assert.equal(records[0].date, '2026-11-17');

  bootApp(storage);
  assert.equal(element('record-list').children.length, 1, '损坏数据不导致渲染崩溃，仅渲染合法记录');
  assert.equal(rowCells(element('record-list').children[0])[2], '2026-11-17');
  teardownApp();
});
