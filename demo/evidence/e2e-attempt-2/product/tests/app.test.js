'use strict';

// 产品测试：本地消费记录小站 —— 校验 / localStorage 数据层 / 统计 / 预警 / 静态结构
// 运行方式：node --test tests/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require(path.join(__dirname, '..', 'app.js'));

function createMemoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    clear() { data.clear(); }
  };
}

function currentMonthDate(day) {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(day).padStart(2, '0');
}

const VALID_INPUT = { type: 'expense', amount: '12.5', date: '2026-11-17', category: '餐饮', note: '午饭' };

test('金额校验：负数、非数字、零、超两位小数均给出明确错误', () => {
  const invalidAmounts = ['-5', '-0.01', 'abc', '1e3', '12.', '1,000', '12.345', '0', '0.00', ''];
  for (const amount of invalidAmounts) {
    const result = app.validateRecordInput(Object.assign({}, VALID_INPUT, { amount }));
    assert.equal(result.ok, false, 'amount=' + amount + ' 应校验失败');
    assert.equal(typeof result.errors.amount, 'string');
    assert.ok(result.errors.amount.length > 0, 'amount=' + amount + ' 需有明确错误信息');
  }
});

test('金额校验：合法金额通过并规范为两位小数数字', () => {
  const cases = [['12.5', 12.5], ['12', 12], ['0.01', 0.01], ['99.99', 99.99], [' 88.80 ', 88.8]];
  for (const [raw, expected] of cases) {
    const result = app.validateRecordInput(Object.assign({}, VALID_INPUT, { amount: raw }));
    assert.equal(result.ok, true, 'amount=' + raw + ' 应合法');
    assert.equal(result.record.amount, expected);
  }
});

test('日期校验：非 YYYY-MM-DD 或不存在的日期均报错', () => {
  const invalidDates = ['2026/11/17', '2026-13-01', '2026-00-10', '2026-02-30', '2026-04-31',
    '2026-1-1', '11/17/2026', '', 'abc'];
  for (const date of invalidDates) {
    const result = app.validateRecordInput(Object.assign({}, VALID_INPUT, { date }));
    assert.equal(result.ok, false, 'date=' + date + ' 应校验失败');
    assert.ok(result.errors.date && result.errors.date.length > 0, 'date=' + date + ' 需有明确错误信息');
  }
  // 闰年与边界
  assert.equal(app.validateRecordInput(Object.assign({}, VALID_INPUT, { date: '2024-02-29' })).ok, true);
  assert.equal(app.validateRecordInput(Object.assign({}, VALID_INPUT, { date: '2026-02-29' })).ok, false);
  const trimmed = app.validateRecordInput(Object.assign({}, VALID_INPUT, { date: ' 2026-11-17 ' }));
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.record.date, '2026-11-17');
});

test('分类 / 备注 / 类型校验：空分类、超长备注、非法类型报错', () => {
  const noCategory = app.validateRecordInput(Object.assign({}, VALID_INPUT, { category: '   ' }));
  assert.equal(noCategory.ok, false);
  assert.ok(noCategory.errors.category.length > 0);

  const longNote = app.validateRecordInput(Object.assign({}, VALID_INPUT, { note: 'a'.repeat(101) }));
  assert.equal(longNote.ok, false);
  assert.ok(longNote.errors.note.length > 0);
  assert.equal(app.validateRecordInput(Object.assign({}, VALID_INPUT, { note: 'a'.repeat(100) })).ok, true);

  const badType = app.validateRecordInput(Object.assign({}, VALID_INPUT, { type: 'other' }));
  assert.equal(badType.ok, false);
  assert.ok(badType.errors.type.length > 0);
});

test('持久化：合法记录写入 localStorage，重新读取（模拟刷新）后仍存在', () => {
  const storage = createMemoryStorage();
  const added = app.addRecord(storage, VALID_INPUT);
  assert.equal(added.ok, true);
  assert.equal(typeof added.record.id, 'string');

  // 模拟刷新页面：新的 store 实例从同一 storage 读取
  const reloaded = app.createRecordStore(storage).loadRecords();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, added.record.id);
  assert.equal(reloaded[0].type, 'expense');
  assert.equal(reloaded[0].amount, 12.5);
  assert.equal(reloaded[0].date, '2026-11-17');
  assert.equal(reloaded[0].category, '餐饮');
  assert.equal(reloaded[0].note, '午饭');

  // 损坏 JSON 或非数组数据不应导致崩溃
  storage.setItem(app.STORAGE_KEY_RECORDS, '{bad json');
  assert.deepEqual(app.getRecords(storage), []);
  storage.setItem(app.STORAGE_KEY_RECORDS, JSON.stringify({ no: 'array' }));
  assert.deepEqual(app.getRecords(storage), []);
});

test('非法输入不写入 localStorage', () => {
  const storage = createMemoryStorage();
  const badPatches = [
    { amount: '-5' },
    { amount: 'abc' },
    { date: '2026/11/17' },
    { date: '2026-02-30' },
    { category: '' },
    { note: 'x'.repeat(101) },
    { type: 'unknown' }
  ];
  for (const patch of badPatches) {
    const result = app.addRecord(storage, Object.assign({}, VALID_INPUT, patch));
    assert.equal(result.ok, false, JSON.stringify(patch) + ' 应校验失败');
    assert.equal(storage.getItem(app.STORAGE_KEY_RECORDS), null, '非法输入不得写入 localStorage');
  }
  assert.deepEqual(app.getRecords(storage), []);
});

test('更新与删除记录并持久化', () => {
  const storage = createMemoryStorage();
  const a = app.addRecord(storage, { type: 'income', amount: '100', date: '2026-10-01', category: '工资', note: '' });
  const b = app.addRecord(storage, { type: 'expense', amount: '30.5', date: '2026-10-02', category: '餐饮', note: '' });
  assert.equal(app.getRecords(storage).length, 2);

  const updated = app.updateRecord(storage, b.record.id, {
    type: 'expense', amount: '88.80', date: '2026-10-03', category: '购物', note: '改'
  });
  assert.equal(updated.ok, true);
  const records = app.getRecords(storage);
  assert.equal(records.length, 2);
  const changed = records.find((r) => r.id === b.record.id);
  assert.equal(changed.amount, 88.8);
  assert.equal(changed.date, '2026-10-03');
  assert.equal(changed.category, '购物');
  assert.equal(changed.createdAt, b.record.createdAt, '更新应保留创建时间');

  // 更新时校验仍生效且不写入
  const badUpdate = app.updateRecord(storage, b.record.id, {
    type: 'expense', amount: '-1', date: '2026-10-03', category: '购物', note: ''
  });
  assert.equal(badUpdate.ok, false);
  assert.equal(app.getRecords(storage).find((r) => r.id === b.record.id).amount, 88.8);

  // 删除
  assert.equal(app.deleteRecord(storage, a.record.id), true);
  assert.deepEqual(app.getRecords(storage).map((r) => r.id), [b.record.id]);
  assert.equal(app.deleteRecord(storage, 'not-exist'), false);
});

test('时间范围筛选：含端点、空范围返回全部；非法范围报错', () => {
  const records = [
    { id: '1', type: 'expense', amount: 10, date: '2026-01-01', category: '餐饮', note: '' },
    { id: '2', type: 'expense', amount: 20, date: '2026-01-31', category: '交通', note: '' },
    { id: '3', type: 'income', amount: 50, date: '2026-02-01', category: '工资', note: '' },
    { id: '4', type: 'expense', amount: 5, date: '2025-12-31', category: '餐饮', note: '' }
  ];
  assert.deepEqual(app.filterRecords(records, { start: '2026-01-01', end: '2026-01-31' }).map((r) => r.id), ['1', '2']);
  assert.deepEqual(app.filterRecords(records, { start: '2026-01-01', end: '' }).map((r) => r.id), ['1', '2', '3']);
  assert.deepEqual(app.filterRecords(records, {}).map((r) => r.id), ['1', '2', '3', '4']);
  assert.equal(app.filterRecords(records, null).length, 4);

  assert.equal(app.validateFilterInput({ start: '2026/01/01', end: '' }).ok, false);
  assert.equal(app.validateFilterInput({ start: '2026-01-01', end: '2026-01-32' }).ok, false);
  assert.equal(app.validateFilterInput({ start: '2026-02-01', end: '2026-01-01' }).ok, false);
  const okRange = app.validateFilterInput({ start: ' 2026-01-01 ', end: '' });
  assert.equal(okRange.ok, true);
  assert.deepEqual(okRange.value, { start: '2026-01-01', end: '' });
});

test('汇总统计：总收入、总支出、结余与分类统计（两位小数精度）', () => {
  const records = [
    { type: 'income', amount: 0.1, date: '2026-01-01', category: '工资' },
    { type: 'income', amount: 0.2, date: '2026-01-02', category: '工资' },
    { type: 'expense', amount: 30.05, date: '2026-01-03', category: '餐饮' },
    { type: 'expense', amount: 19.95, date: '2026-01-04', category: '餐饮' },
    { type: 'expense', amount: 8, date: '2026-01-05', category: '交通' }
  ];
  const summary = app.computeSummary(records);
  assert.equal(summary.totalIncome, 0.3);
  assert.equal(summary.totalExpense, 58);
  assert.equal(summary.balance, -57.7);
  assert.equal(app.formatAmount(summary.totalIncome), '0.30');
  assert.equal(app.formatAmount(summary.totalExpense), '58.00');
  assert.equal(app.formatAmount(summary.balance), '-57.70');

  const dining = summary.categories.find((c) => c.category === '餐饮');
  assert.equal(dining.expense, 50);
  assert.equal(dining.income, 0);
  assert.equal(app.formatAmount(dining.expense), '50.00');
  const salary = summary.categories.find((c) => c.category === '工资');
  assert.equal(salary.income, 0.3);
  assert.equal(app.formatAmount(salary.income), '0.30');

  // 空数据 -> 零值
  assert.deepEqual(app.computeSummary([]), { totalIncome: 0, totalExpense: 0, balance: 0, categories: [] });
});

test('消费预警：月度预算超支、单笔大额、结余低于下限', () => {
  const budgetCase = [
    { type: 'expense', amount: 150.5, date: currentMonthDate(5), category: '购物' },
    { type: 'expense', amount: 20, date: '2020-01-15', category: '餐饮' } // 非本月支出，不计入月度统计
  ];
  const budgetAlerts = app.computeAlerts(budgetCase, { monthlyBudget: 100 });
  assert.equal(budgetAlerts.length, 1);
  assert.equal(budgetAlerts[0].kind, 'monthly-budget');
  assert.ok(budgetAlerts[0].message.includes('150.50'), budgetAlerts[0].message);
  assert.ok(budgetAlerts[0].message.includes('100.00'), budgetAlerts[0].message);

  const singleAlerts = app.computeAlerts(
    [{ type: 'expense', amount: 200, date: '2020-01-15', category: '购物' }],
    { singleExpenseThreshold: 200 }
  );
  assert.equal(singleAlerts.length, 1);
  assert.equal(singleAlerts[0].kind, 'single-expense');
  assert.ok(singleAlerts[0].message.includes('200.00'), singleAlerts[0].message);

  const balanceAlerts = app.computeAlerts([
    { type: 'income', amount: 100, date: '2020-01-01', category: '工资' },
    { type: 'expense', amount: 250.25, date: '2020-01-02', category: '购物' }
  ], { minBalance: 10 });
  assert.equal(balanceAlerts.length, 1);
  assert.equal(balanceAlerts[0].kind, 'low-balance');
  assert.ok(balanceAlerts[0].message.includes('-150.25'), balanceAlerts[0].message);
  assert.ok(balanceAlerts[0].message.includes('10.00'), balanceAlerts[0].message);
});

test('空数据或未设置阈值时不产生任何预警（不误报）', () => {
  const records = [{ type: 'expense', amount: 999, date: currentMonthDate(10), category: '购物' }];
  assert.deepEqual(app.computeAlerts([], { monthlyBudget: 1, singleExpenseThreshold: 1, minBalance: 10000 }), []);
  assert.deepEqual(app.computeAlerts(records, {}), []);
  assert.deepEqual(
    app.computeAlerts(records, { monthlyBudget: null, singleExpenseThreshold: null, minBalance: null }), []);
  // 阈值内同样不误报
  assert.deepEqual(
    app.computeAlerts(records, { monthlyBudget: 1000, singleExpenseThreshold: 10000, minBalance: null }), []);
});

test('格式化：金额两位小数、日期 YYYY-MM-DD', () => {
  assert.equal(app.formatAmount(3), '3.00');
  assert.equal(app.formatAmount(12.5), '12.50');
  assert.equal(app.formatAmount(0), '0.00');
  assert.equal(app.formatAmount(1234.5), '1234.50');
  assert.equal(app.formatAmount(-42.5), '-42.50');
  assert.equal(app.normalizeDate(' 2026-11-17 '), '2026-11-17');
  assert.equal(app.normalizeDate('2026/11/17'), '');
  assert.equal(app.isValidDate('2026-11-17'), true);
  assert.equal(app.isValidDate('2026-11-31'), false);
});

test('阈值设置：负数 / 非数字报错，留空表示未设置，保存后可读取', () => {
  const bad = app.validateSettingsInput({ monthlyBudget: '-1', singleExpenseThreshold: 'abc', minBalance: '1.234' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.monthlyBudget.length > 0);
  assert.ok(bad.errors.singleExpenseThreshold.length > 0);
  assert.ok(bad.errors.minBalance.length > 0);

  const okSettings = app.validateSettingsInput({ monthlyBudget: '1000', singleExpenseThreshold: '500.5', minBalance: '' });
  assert.equal(okSettings.ok, true);
  assert.deepEqual(okSettings.settings, { monthlyBudget: 1000, singleExpenseThreshold: 500.5, minBalance: null });

  const storage = createMemoryStorage();
  const store = app.createRecordStore(storage);
  assert.deepEqual(store.loadSettings(), { monthlyBudget: null, singleExpenseThreshold: null, minBalance: null });
  store.saveSettings(okSettings.settings);
  // 模拟刷新后重新读取
  assert.deepEqual(app.createRecordStore(storage).loadSettings(), okSettings.settings);
});

test('静态结构：四个区域齐全，且无任何外部网络资源引用', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const id of ['record-form-section', 'records-section', 'summary-section', 'alerts-section',
    'record-form', 'record-list', 'summary-income', 'summary-expense', 'summary-balance',
    'alerts-list', 'settings-form']) {
    assert.ok(html.includes('id="' + id + '"'), '缺少元素 #' + id);
  }
  assert.equal(/(src|href)\s*=\s*["']https?:\/\//i.test(html), false, '页面不得引用外部 http(s) 资源');

  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.equal(/url\(/i.test(css), false, '样式不得引用外部资源');
  assert.ok(/@media/.test(css), '样式需包含响应式媒体查询');

  const js = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.equal(/(fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/.test(js), false, '脚本不得发起网络请求');
});
