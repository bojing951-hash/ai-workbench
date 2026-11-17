// 记录增删改 + localStorage 持久化 测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import api from '../js/store.js';

const { RECORDS_KEY, SETTINGS_KEY, createStore, validateRecordInput } = api;

// localStorage 内存模拟（与浏览器同构：字符串键值）
function createMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); }
  };
}

const validInput = {
  type: 'expense',
  amount: '25.5',
  category: '餐饮',
  date: '2026-11-01',
  note: ' 午饭 '
};

test('addRecord: 合法输入保存成功并规范化字段', () => {
  const store = createStore(createMemoryStorage());
  const result = store.addRecord(validInput);
  assert.equal(result.ok, true);
  assert.equal(result.record.type, 'expense');
  assert.equal(result.record.amount, 25.5);
  assert.equal(result.record.category, '餐饮');
  assert.equal(result.record.date, '2026-11-01');
  assert.equal(result.record.note, '午饭'); // 去除首尾空白
  assert.ok(typeof result.record.id === 'string' && result.record.id.length > 0);
  assert.equal(store.listRecords().length, 1);
});

test('addRecord: 金额四舍五入到两位小数', () => {
  const store = createStore(createMemoryStorage());
  const result = store.addRecord({ ...validInput, amount: '10.456' });
  assert.equal(result.ok, true);
  assert.equal(result.record.amount, 10.46);
});

test('addRecord: 非法输入被拒绝并给出错误信息', () => {
  const store = createStore(createMemoryStorage());

  const badType = store.addRecord({ ...validInput, type: 'other' });
  assert.equal(badType.ok, false);

  for (const amount of ['0', '-5', 'abc', '']) {
    const bad = store.addRecord({ ...validInput, amount });
    assert.equal(bad.ok, false, 'amount=' + amount + ' 应被拒绝');
    assert.ok(bad.errors.some((e) => e.includes('金额')), 'amount=' + amount + ' 应提示金额错误');
  }

  const badDate = store.addRecord({ ...validInput, date: '2026-13-01' });
  assert.equal(badDate.ok, false);
  assert.ok(badDate.errors.some((e) => e.includes('日期')));

  const noCategory = store.addRecord({ ...validInput, category: '   ' });
  assert.equal(noCategory.ok, false);
  assert.ok(noCategory.errors.some((e) => e.includes('分类')));

  const longNote = store.addRecord({ ...validInput, note: 'x'.repeat(101) });
  assert.equal(longNote.ok, false);
  assert.ok(longNote.errors.some((e) => e.includes('备注')));

  assert.equal(store.listRecords().length, 0, '所有非法输入都不应写入');
});

test('validateRecordInput: 直接返回错误数组', () => {
  assert.deepEqual(validateRecordInput(validInput), []);
  assert.ok(validateRecordInput(null).length >= 3);
});

test('updateRecord: 修改金额/分类/日期/备注后生效且 id 不变', () => {
  const store = createStore(createMemoryStorage());
  const added = store.addRecord(validInput);

  const updated = store.updateRecord(added.record.id, {
    type: 'income',
    amount: '88.88',
    category: '工资',
    date: '2026-11-02',
    note: ' 十一月工资 '
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.record.id, added.record.id);
  assert.equal(updated.record.amount, 88.88);
  assert.equal(updated.record.category, '工资');
  assert.equal(updated.record.date, '2026-11-02');
  assert.equal(updated.record.note, '十一月工资');

  const current = store.getRecord(added.record.id);
  assert.equal(current.type, 'income');
  assert.equal(current.amount, 88.88);
  assert.equal(store.listRecords().length, 1);
});

test('updateRecord: 记录不存在或数据非法时失败', () => {
  const store = createStore(createMemoryStorage());
  const missing = store.updateRecord('no-such-id', validInput);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes('不存在')));

  const added = store.addRecord(validInput);
  const invalid = store.updateRecord(added.record.id, { ...validInput, amount: '-1' });
  assert.equal(invalid.ok, false);
  assert.equal(store.getRecord(added.record.id).amount, 25.5, '失败更新不得污染原记录');
});

test('deleteRecord: 删除后列表与存储同步', () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  const first = store.addRecord(validInput);
  store.addRecord({ ...validInput, date: '2026-11-02' });
  assert.equal(store.listRecords().length, 2);

  assert.equal(store.deleteRecord(first.record.id), true);
  assert.equal(store.listRecords().length, 1);
  assert.equal(store.getRecord(first.record.id), null);
  const persisted = JSON.parse(storage.getItem(RECORDS_KEY));
  assert.equal(persisted.length, 1);
  assert.ok(!persisted.some((r) => r.id === first.record.id), 'localStorage 中不应再包含被删记录');

  assert.equal(store.deleteRecord(first.record.id), false, '重复删除返回 false');
});

test('持久化: 新建 store（等价刷新页面）从 localStorage 读回全部记录', () => {
  const storage = createMemoryStorage();
  const a = createStore(storage);
  a.addRecord(validInput);
  a.addRecord({ type: 'income', amount: '8000', category: '工资', date: '2026-11-05', note: '' });

  const raw = JSON.parse(storage.getItem(RECORDS_KEY));
  assert.equal(raw.length, 2);

  const refreshed = createStore(storage); // 模拟刷新后重新初始化
  assert.equal(refreshed.listRecords().length, 2);
  assert.deepEqual(
    refreshed.listRecords().map((r) => r.amount).sort((x, y) => x - y),
    [25.5, 8000]
  );

  refreshed.deleteRecord(raw[0].id);
  assert.equal(createStore(storage).listRecords().length, 1, '删除结果同样持久化');
});

test('持久化: 损坏的存储数据被安全过滤', () => {
  const broken = createStore(createMemoryStorage({ [RECORDS_KEY]: '{not-json' }));
  assert.deepEqual(broken.listRecords(), []);

  const goodRecord = { id: 'ok-1', type: 'expense', amount: 25.5, category: '餐饮', date: '2026-11-01', note: '午饭' };
  const mixed = createStore(createMemoryStorage({
    [RECORDS_KEY]: JSON.stringify([
      { id: 'bad-1', type: 'expense', amount: -1, category: '餐饮', date: '2026-11-01' },
      { id: 'bad-2', type: 'other', amount: 5, category: '餐饮', date: '2026-11-01' },
      'not-a-record',
      goodRecord
    ])
  }));
  assert.equal(mixed.listRecords().length, 1);
  assert.equal(mixed.listRecords()[0].id, 'ok-1');
});

test('设置: 保存与读回预警阈值，非法值归零', () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  assert.deepEqual(store.getSettings(), { monthlyBudget: 0, largeThreshold: 0, balanceFloor: 0 });

  const saved = store.saveSettings({ monthlyBudget: '2000', largeThreshold: '500', balanceFloor: '100.5' });
  assert.deepEqual(saved, { monthlyBudget: 2000, largeThreshold: 500, balanceFloor: 100.5 });
  assert.deepEqual(
    JSON.parse(storage.getItem(SETTINGS_KEY)),
    { monthlyBudget: 2000, largeThreshold: 500, balanceFloor: 100.5 }
  );
  assert.deepEqual(createStore(storage).getSettings(), saved, '设置在“刷新”后仍保留');

  assert.deepEqual(
    store.saveSettings({ monthlyBudget: 'abc', largeThreshold: -3, balanceFloor: '' }),
    { monthlyBudget: 0, largeThreshold: 0, balanceFloor: 0 }
  );
});

test('内存模式: 不传 storage 也可正常增删改（不访问 localStorage）', () => {
  const store = createStore(null);
  const result = store.addRecord(validInput);
  assert.equal(result.ok, true);
  assert.equal(store.listRecords().length, 1);
  assert.equal(store.deleteRecord(result.record.id), true);
  assert.equal(store.listRecords().length, 0);
});
