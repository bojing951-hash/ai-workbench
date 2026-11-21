// 时间范围过滤、汇总计算、分类支出趋势 测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import api from '../js/store.js';

const { filterRecords, computeSummary, computeCategoryTotals, resolveRange } = api;

const records = [
  { id: '1', type: 'expense', amount: 100, category: '餐饮', date: '2026-11-01', note: '' },
  { id: '2', type: 'expense', amount: 300.5, category: '交通', date: '2026-11-05', note: '' },
  { id: '3', type: 'income', amount: 8000, category: '工资', date: '2026-11-05', note: '' },
  { id: '4', type: 'expense', amount: 99.9, category: '餐饮', date: '2026-10-20', note: '' },
  { id: '5', type: 'income', amount: 500, category: '兼职', date: '2026-10-15', note: '' }
];

test('filterRecords: 按起止日期闭区间过滤，空范围返回全部', () => {
  assert.deepEqual(filterRecords(records, {}).map((r) => r.id), ['1', '2', '3', '4', '5']);
  assert.deepEqual(
    filterRecords(records, { start: '2026-11-01', end: '2026-11-05' }).map((r) => r.id),
    ['1', '2', '3'],
    '边界日期应包含在内'
  );
  assert.deepEqual(filterRecords(records, { start: '2026-10-16', end: '2026-10-31' }).map((r) => r.id), ['4']);
  assert.deepEqual(filterRecords(records, { start: '2027-01-01', end: '2027-12-31' }), []);
});

test('computeSummary: 收入合计、支出合计、结余与条数', () => {
  const all = computeSummary(records);
  assert.equal(all.income, 8500);
  assert.equal(all.expense, 500.4);
  assert.equal(all.balance, 7999.6);
  assert.equal(all.count, 5);

  const november = computeSummary(records, { start: '2026-11-01', end: '2026-11-30' });
  assert.equal(november.income, 8000);
  assert.equal(november.expense, 400.5);
  assert.equal(november.balance, 7599.5);
  assert.equal(november.count, 3);

  const october = computeSummary(records, { start: '2026-10-01', end: '2026-10-31' });
  assert.equal(october.income, 500);
  assert.equal(october.expense, 99.9);
  assert.equal(october.balance, 400.1);
  assert.equal(october.count, 2);

  assert.deepEqual(computeSummary([], {}), { income: 0, expense: 0, balance: 0, count: 0 });
});

test('computeCategoryTotals: 仅统计支出、同分类合并、按金额降序并给出占比', () => {
  const all = computeCategoryTotals(records);
  assert.equal(all.length, 2);
  assert.equal(all[0].category, '交通');
  assert.equal(all[0].total, 300.5);
  assert.equal(all[1].category, '餐饮');
  assert.equal(all[1].total, 199.9); // 100 + 99.9 同分类合并
  assert.ok(Math.abs(all[0].share + all[1].share - 100) < 0.01, '占比合计应约等于 100%');
  assert.ok(all[0].share > all[1].share);

  const november = computeCategoryTotals(records, { start: '2026-11-01', end: '2026-11-30' });
  assert.equal(november.length, 2);
  assert.equal(november[0].category, '交通');
  assert.equal(november[1].total, 100);

  assert.deepEqual(computeCategoryTotals(records, { start: '2027-01-01', end: '2027-12-31' }), []);
});

test('resolveRange: 全部/本月/近30天/本年/自定义 预设解析正确', () => {
  const today = '2026-11-17';
  assert.deepEqual(resolveRange('all', { today }), { start: null, end: null });
  assert.deepEqual(resolveRange('month', { today }), { start: '2026-11-01', end: '2026-11-30' });
  assert.deepEqual(resolveRange('30d', { today }), { start: '2026-10-19', end: '2026-11-17' });
  assert.deepEqual(resolveRange('year', { today }), { start: '2026-01-01', end: '2026-12-31' });
  assert.deepEqual(
    resolveRange('custom', { today, start: '2026-10-01', end: '2026-10-31' }),
    { start: '2026-10-01', end: '2026-10-31' }
  );
  assert.deepEqual(
    resolveRange('custom', { today, start: 'bad', end: '' }),
    { start: null, end: null },
    '自定义日期非法时该侧不限制'
  );
  // 闰年与月末边界
  assert.deepEqual(resolveRange('month', { today: '2024-02-10' }), { start: '2024-02-01', end: '2024-02-29' });
});

test('端到端: createStore 记录 + resolveRange + computeSummary 组合可用', () => {
  const { createStore } = api;
  const store = createStore(null);
  store.addRecord({ type: 'income', amount: '6000', category: '工资', date: '2026-11-05', note: '' });
  store.addRecord({ type: 'expense', amount: '45', category: '餐饮', date: '2026-11-02', note: '' });
  store.addRecord({ type: 'expense', amount: '320', category: '购物', date: '2026-11-10', note: '' });

  const range = resolveRange('month', { today: '2026-11-17' });
  const summary = computeSummary(store.listRecords(), range);
  assert.equal(summary.income, 6000);
  assert.equal(summary.expense, 365);
  assert.equal(summary.balance, 5635);
  assert.equal(computeCategoryTotals(store.listRecords(), range)[0].category, '购物');
});
