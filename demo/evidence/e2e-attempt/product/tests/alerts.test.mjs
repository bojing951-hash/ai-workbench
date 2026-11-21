// 消费预警判断 测试：预算超支 / 大额支出 / 结余低于下限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import api from '../js/store.js';

const { evaluateAlerts } = api;

const records = [
  { id: 'a', type: 'expense', amount: 45, category: '餐饮', date: '2026-11-02', note: '' },
  { id: 'b', type: 'expense', amount: 320, category: '购物', date: '2026-11-10', note: '大件' },
  { id: 'c', type: 'income', amount: 6000, category: '工资', date: '2026-11-05', note: '' },
  { id: 'd', type: 'expense', amount: 80, category: '交通', date: '2026-10-08', note: '' }
];
// 全部范围：支出 445，收入 6000，结余 5555

test('预算预警: 支出超过预算时提示，未超过或未设置时不提示', () => {
  const over = evaluateAlerts(records, {}, { monthlyBudget: 400 });
  assert.equal(over.length, 1);
  assert.equal(over[0].type, 'budget');
  assert.ok(over[0].message.includes('445.00'), '应包含本期支出金额');
  assert.ok(over[0].message.includes('45.00'), '应包含超出金额');

  assert.deepEqual(evaluateAlerts(records, {}, { monthlyBudget: 500 }), []);
  assert.deepEqual(evaluateAlerts(records, {}, { monthlyBudget: 0 }), [], '0 表示关闭预算提示');
  assert.deepEqual(evaluateAlerts(records, {}, {}), []);
});

test('大额预警: 单笔支出超过阈值时提示并指出最大一笔', () => {
  const alerts = evaluateAlerts(records, {}, { largeThreshold: 300 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'large');
  assert.ok(alerts[0].message.includes('1 笔'));
  assert.ok(alerts[0].message.includes('320.00'));
  assert.ok(alerts[0].message.includes('购物'));

  assert.deepEqual(evaluateAlerts(records, {}, { largeThreshold: 1000 }), []);
  // 多笔超阈值
  const two = evaluateAlerts(records, {}, { largeThreshold: 40 });
  assert.equal(two.length, 1);
  assert.ok(two[0].message.includes('3 笔'));
});

test('结余预警: 结余低于下限时提示', () => {
  const low = evaluateAlerts(records, {}, { balanceFloor: 6000 });
  assert.equal(low.length, 1);
  assert.equal(low[0].type, 'floor');
  assert.ok(low[0].message.includes('5555.00'));

  assert.deepEqual(evaluateAlerts(records, {}, { balanceFloor: 5000 }), []);
});

test('组合预警: 三类同时触发时全部给出', () => {
  const alerts = evaluateAlerts(records, {}, {
    monthlyBudget: 400,
    largeThreshold: 300,
    balanceFloor: 6000
  });
  assert.deepEqual(alerts.map((a) => a.type), ['budget', 'large', 'floor']);
});

test('预警跟随所选时间范围计算', () => {
  const settings = { monthlyBudget: 50, largeThreshold: 75, balanceFloor: 1 };
  const november = { start: '2026-11-01', end: '2026-11-30' };
  const october = { start: '2026-10-01', end: '2026-10-31' };

  const novAlerts = evaluateAlerts(records, november, settings);
  // 11 月：支出 365 > 50 触发预算；320 > 75 触发大额；结余 5635 > 1 不触发结余
  assert.deepEqual(novAlerts.map((a) => a.type), ['budget', 'large']);

  const octAlerts = evaluateAlerts(records, october, settings);
  // 10 月：支出 80 > 50 触发预算；80 > 75 触发大额；结余 -80 < 1 触发结余
  assert.deepEqual(octAlerts.map((a) => a.type), ['budget', 'large', 'floor']);
  assert.ok(octAlerts[2].message.includes('-80.00'), '结余为负也应正确显示');
});

test('无记录或无设置时无任何提示', () => {
  assert.deepEqual(evaluateAlerts([], {}, { monthlyBudget: 100, largeThreshold: 100, balanceFloor: 100 }), []);
  assert.deepEqual(evaluateAlerts(records, { start: '2027-01-01', end: '2027-12-31' }, {
    monthlyBudget: 1, largeThreshold: 1, balanceFloor: 1
  }), []);
});
