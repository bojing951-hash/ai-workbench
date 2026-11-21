// 本地消费记录小站 · 核心数据模块
// 职责：收支记录的增删改查、localStorage 持久化、时间范围过滤、汇总与分类统计、消费预警计算。
// 本项目纯本地运行：本文件不包含任何网络请求逻辑。
(function (global) {
  'use strict';

  var RECORDS_KEY = 'expense-tracker.records.v1';
  var SETTINGS_KEY = 'expense-tracker.settings.v1';

  var EXPENSE_CATEGORIES = ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '通讯', '其他'];
  var INCOME_CATEGORIES = ['工资', '奖金', '投资', '兼职', '其他'];

  // 三项提示阈值默认 0 = 未设置（关闭对应提示）
  var DEFAULT_SETTINGS = { monthlyBudget: 0, largeThreshold: 0, balanceFloor: 0 };

  function roundAmount(value) {
    return Math.round(value * 100) / 100;
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function toISODate(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function todayLocal() {
    return toISODate(new Date());
  }

  // 严格校验 YYYY-MM-DD（含月份/日期真实存在性）
  function isValidISODate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var year = Number(value.slice(0, 4));
    var month = Number(value.slice(5, 7));
    var day = Number(value.slice(8, 10));
    var date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function createId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // 返回错误信息数组；为空表示输入合法
  function validateRecordInput(input) {
    var errors = [];
    var value = input || {};
    if (value.type !== 'income' && value.type !== 'expense') {
      errors.push('记录类型必须是收入或支出');
    }
    var amount = Number(value.amount);
    if (!isFinite(amount) || amount <= 0) {
      errors.push('金额必须是大于 0 的数字');
    } else if (roundAmount(amount) <= 0) {
      errors.push('金额过小，必须大于 0');
    }
    var category = typeof value.category === 'string' ? value.category.trim() : '';
    if (!category) {
      errors.push('请选择分类');
    }
    if (!isValidISODate(value.date)) {
      errors.push('日期格式必须为 YYYY-MM-DD');
    }
    var note = typeof value.note === 'string' ? value.note.trim() : '';
    if (note.length > 100) {
      errors.push('备注不能超过 100 个字符');
    }
    return errors;
  }

  // 统一输出标准记录对象（金额为两位小数数字，备注去除首尾空白）
  function normalizeRecord(input) {
    var note = typeof input.note === 'string' ? input.note.trim() : '';
    return {
      id: typeof input.id === 'string' && input.id ? input.id : createId(),
      type: input.type,
      amount: roundAmount(Number(input.amount)),
      category: String(input.category).trim(),
      date: input.date,
      note: note
    };
  }

  function copyRecord(record) {
    return {
      id: record.id,
      type: record.type,
      amount: record.amount,
      category: record.category,
      date: record.date,
      note: record.note
    };
  }

  // 从 localStorage 读回时的防线：过滤掉损坏/不完整的数据
  function isStoredRecord(value) {
    return Boolean(value) && typeof value === 'object'
      && (value.type === 'income' || value.type === 'expense')
      && typeof value.amount === 'number' && isFinite(value.amount) && value.amount > 0
      && typeof value.category === 'string' && value.category.trim() !== ''
      && isValidISODate(value.date);
  }

  function toSettingNumber(value) {
    var number = Number(value);
    if (!isFinite(number) || number < 0) return 0;
    return roundAmount(number);
  }

  function normalizeSettings(value) {
    var source = value && typeof value === 'object' ? value : {};
    return {
      monthlyBudget: toSettingNumber(source.monthlyBudget),
      largeThreshold: toSettingNumber(source.largeThreshold),
      balanceFloor: toSettingNumber(source.balanceFloor)
    };
  }

  // 创建一个数据仓库：storage 需实现 getItem/setItem（浏览器传 window.localStorage，
  // 测试可传入内存模拟；传 null 时退化为纯内存模式）
  function createStore(storage) {
    var hasStorage = Boolean(storage);
    var records = loadRecords();
    var settings = loadSettings();

    function loadRecords() {
      if (!hasStorage) return [];
      var raw = null;
      try { raw = storage.getItem(RECORDS_KEY); } catch (err) { return []; }
      if (!raw) return [];
      var parsed;
      try { parsed = JSON.parse(raw); } catch (err) { return []; }
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isStoredRecord).map(copyRecord);
    }

    function persistRecords() {
      if (!hasStorage) return;
      try { storage.setItem(RECORDS_KEY, JSON.stringify(records)); } catch (err) {
        // 存储不可用（如隐私模式配额）时静默退化为内存模式
      }
    }

    function loadSettings() {
      if (!hasStorage) return normalizeSettings(DEFAULT_SETTINGS);
      var raw = null;
      try { raw = storage.getItem(SETTINGS_KEY); } catch (err) { return normalizeSettings(DEFAULT_SETTINGS); }
      if (!raw) return normalizeSettings(DEFAULT_SETTINGS);
      var parsed;
      try { parsed = JSON.parse(raw); } catch (err) { return normalizeSettings(DEFAULT_SETTINGS); }
      return normalizeSettings(parsed);
    }

    function indexOfId(id) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].id === id) return i;
      }
      return -1;
    }

    function listRecords() {
      return records.map(copyRecord);
    }

    function getRecord(id) {
      var index = indexOfId(id);
      return index === -1 ? null : copyRecord(records[index]);
    }

    function addRecord(input) {
      var errors = validateRecordInput(input);
      if (errors.length) return { ok: false, errors: errors };
      var record = normalizeRecord(input);
      records.push(record);
      persistRecords();
      return { ok: true, record: copyRecord(record) };
    }

    function updateRecord(id, input) {
      var index = indexOfId(id);
      if (index === -1) return { ok: false, errors: ['要修改的记录不存在'] };
      var errors = validateRecordInput(input);
      if (errors.length) return { ok: false, errors: errors };
      var updated = normalizeRecord(input);
      updated.id = records[index].id;
      records[index] = updated;
      persistRecords();
      return { ok: true, record: copyRecord(updated) };
    }

    function deleteRecord(id) {
      var index = indexOfId(id);
      if (index === -1) return false;
      records.splice(index, 1);
      persistRecords();
      return true;
    }

    function getSettings() {
      return {
        monthlyBudget: settings.monthlyBudget,
        largeThreshold: settings.largeThreshold,
        balanceFloor: settings.balanceFloor
      };
    }

    function saveSettings(patch) {
      settings = normalizeSettings(patch);
      if (hasStorage) {
        try { storage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (err) { /* 同上，静默降级 */ }
      }
      return getSettings();
    }

    // 重新从存储读取，等价于“刷新页面后”的状态
    function reload() {
      records = loadRecords();
      settings = loadSettings();
    }

    return {
      listRecords: listRecords,
      getRecord: getRecord,
      addRecord: addRecord,
      updateRecord: updateRecord,
      deleteRecord: deleteRecord,
      getSettings: getSettings,
      saveSettings: saveSettings,
      reload: reload
    };
  }

  // 时间范围过滤（闭区间，起/止任一侧可为 null 表示不限制）
  function filterRecords(records, range) {
    var limit = range || {};
    var start = typeof limit.start === 'string' && limit.start ? limit.start : null;
    var end = typeof limit.end === 'string' && limit.end ? limit.end : null;
    return (records || []).filter(function (record) {
      if (start && record.date < start) return false;
      if (end && record.date > end) return false;
      return true;
    });
  }

  // 汇总：收入合计、支出合计、结余、记录条数
  function computeSummary(records, range) {
    var income = 0;
    var expense = 0;
    var count = 0;
    filterRecords(records, range).forEach(function (record) {
      count += 1;
      if (record.type === 'income') income += record.amount;
      else expense += record.amount;
    });
    return {
      income: roundAmount(income),
      expense: roundAmount(expense),
      balance: roundAmount(income - expense),
      count: count
    };
  }

  // 分类支出趋势：仅统计支出，按金额降序，并给出占比（百分比，保留两位）
  function computeCategoryTotals(records, range) {
    var totals = {};
    var expenseSum = 0;
    filterRecords(records, range).forEach(function (record) {
      if (record.type !== 'expense') return;
      totals[record.category] = (totals[record.category] || 0) + record.amount;
      expenseSum += record.amount;
    });
    return Object.keys(totals).map(function (category) {
      var total = roundAmount(totals[category]);
      return {
        category: category,
        total: total,
        share: expenseSum > 0 ? Math.round((total / expenseSum) * 10000) / 100 : 0
      };
    }).sort(function (a, b) { return b.total - a.total; });
  }

  function formatMoney(value) {
    return '¥' + Number(value).toFixed(2);
  }

  // 消费预警：基于所选时间范围计算，阈值 <=0 表示关闭对应提示
  function evaluateAlerts(records, range, settings) {
    var options = settings || {};
    var summary = computeSummary(records, range);
    var inRange = filterRecords(records, range);
    var alerts = [];

    if (options.monthlyBudget > 0 && summary.expense > options.monthlyBudget) {
      alerts.push({
        type: 'budget',
        message: '支出已超过预算：本期支出 ' + formatMoney(summary.expense)
          + '，预算 ' + formatMoney(options.monthlyBudget)
          + '，超出 ' + formatMoney(roundAmount(summary.expense - options.monthlyBudget))
      });
    }

    if (options.largeThreshold > 0) {
      var largeOnes = filterRecords(records, range).filter(function (record) {
        return record.type === 'expense' && record.amount > options.largeThreshold;
      });
      if (largeOnes.length > 0) {
        var max = largeOnes.reduce(function (a, b) { return b.amount > a.amount ? b : a; });
        alerts.push({
          type: 'large',
          message: '存在 ' + largeOnes.length + ' 笔大额支出（单笔超过 ' + formatMoney(options.largeThreshold)
            + '）：最大一笔 ' + formatMoney(max.amount) + '（' + max.date + ' · ' + max.category + '）'
        });
      }
    }

    // 本期没有任何记录时不触发结余预警（空数据不等于“结余低于下限”）。
    if (options.balanceFloor > 0 && inRange.length > 0 && summary.balance < options.balanceFloor) {
      alerts.push({
        type: 'floor',
        message: '结余低于下限：本期结余 ' + formatMoney(summary.balance)
          + '，低于设定下限 ' + formatMoney(options.balanceFloor)
      });
    }

    return alerts;
  }

  function shiftDays(iso, days) {
    var date = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
    date.setDate(date.getDate() + days);
    return toISODate(date);
  }

  function lastDayOfMonthFrom(iso) {
    var date = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0);
    return toISODate(date);
  }

  // 把范围选择解析为 {start, end}（YYYY-MM-DD 或 null）
  // preset: 'all' | 'month' | '30d' | 'year' | 'custom'
  function resolveRange(preset, options) {
    var opts = options || {};
    var today = isValidISODate(opts.today) ? opts.today : todayLocal();
    if (preset === 'custom') {
      return {
        start: isValidISODate(opts.start) ? opts.start : null,
        end: isValidISODate(opts.end) ? opts.end : null
      };
    }
    if (preset === 'month') {
      return { start: today.slice(0, 8) + '01', end: lastDayOfMonthFrom(today) };
    }
    if (preset === '30d') {
      return { start: shiftDays(today, -29), end: today };
    }
    if (preset === 'year') {
      return { start: today.slice(0, 4) + '-01-01', end: today.slice(0, 4) + '-12-31' };
    }
    return { start: null, end: null };
  }

  var api = {
    RECORDS_KEY: RECORDS_KEY,
    SETTINGS_KEY: SETTINGS_KEY,
    EXPENSE_CATEGORIES: EXPENSE_CATEGORIES,
    INCOME_CATEGORIES: INCOME_CATEGORIES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    createStore: createStore,
    validateRecordInput: validateRecordInput,
    normalizeRecord: normalizeRecord,
    filterRecords: filterRecords,
    computeSummary: computeSummary,
    computeCategoryTotals: computeCategoryTotals,
    evaluateAlerts: evaluateAlerts,
    resolveRange: resolveRange,
    formatMoney: formatMoney,
    roundAmount: roundAmount,
    toISODate: toISODate,
    todayLocal: todayLocal,
    isValidISODate: isValidISODate
  };

  global.ExpenseStore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
