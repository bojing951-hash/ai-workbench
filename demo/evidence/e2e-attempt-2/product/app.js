/**
 * 本地消费记录小站 —— 应用逻辑与 localStorage 数据层
 *
 * 纯前端实现：无网络请求、无外部依赖。
 * 逻辑层（校验 / 存储 / 统计 / 预警）与 DOM 层分离，
 * Node 环境可直接 require 本文件对逻辑层进行单元测试。
 */
(function () {
  'use strict';

  var STORAGE_KEY_RECORDS = 'expense-tracker:records:v1';
  var STORAGE_KEY_SETTINGS = 'expense-tracker:settings:v1';
  var NOTE_MAX_LENGTH = 100;
  var MAX_AMOUNT = 100000000000; // 金额与阈值上限：拦截 Infinity / 超长数字串，避免写入损坏数据

  var CATEGORY_MAP = {
    expense: ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '学习', '其他'],
    income: ['工资', '奖金', '理财收益', '兼职', '红包', '其他']
  };

  /* ============================== 通用工具 ============================== */

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function round2(value) {
    var n = Number(value);
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  /** 任何金额展示统一两位小数，例如 12.5 -> '12.50' */
  function formatAmount(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '0.00';
    return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
  }

  function todayDateString(date) {
    var d = date instanceof Date ? date : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  var idCounter = 0;
  function createId() {
    idCounter += 1;
    return 'r-' + Date.now().toString(36) + '-' + idCounter.toString(36) + '-' +
      Math.floor(Math.random() * 1e6).toString(36);
  }

  /** 仅接受 YYYY-MM-DD 且真实存在的日期 */
  function isValidDate(value) {
    if (typeof value !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var parts = value.split('-');
    var year = Number(parts[0]);
    var month = Number(parts[1]);
    var day = Number(parts[2]);
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    var dt = new Date(Date.UTC(year, month - 1, day));
    return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
  }

  function normalizeDate(value) {
    var s = String(value == null ? '' : value).trim();
    return isValidDate(s) ? s : '';
  }

  /* ============================== 输入校验 ============================== */

  /**
   * 校验一条记录输入。
   * 返回 { ok: true, record } 或 { ok: false, errors: { 字段: 提示 } }。
   */
  function validateRecordInput(input) {
    input = input || {};
    var errors = {};

    var type = String(input.type == null ? '' : input.type).trim();
    if (type !== 'income' && type !== 'expense') {
      errors.type = '类型必须为“支出”或“收入”';
    }

    var amountRaw = String(input.amount == null ? '' : input.amount).trim();
    if (amountRaw === '') {
      errors.amount = '请输入金额';
    } else if (amountRaw.charAt(0) === '-') {
      errors.amount = '金额不能为负数';
    } else if (!/^\d+(\.\d+)?$/.test(amountRaw)) {
      errors.amount = '金额必须为数字，例如 12.50';
    } else if (Number(amountRaw) === 0) {
      errors.amount = '金额必须大于 0';
    } else if (!/^\d+(\.\d{1,2})?$/.test(amountRaw)) {
      errors.amount = '金额最多两位小数';
    } else if (!Number.isFinite(Number(amountRaw)) || Number(amountRaw) > MAX_AMOUNT) {
      errors.amount = '金额超出可记录范围（最大 ' + MAX_AMOUNT + '）';
    }

    var dateRaw = String(input.date == null ? '' : input.date).trim();
    if (dateRaw === '') {
      errors.date = '请输入日期，格式 YYYY-MM-DD';
    } else if (!isValidDate(dateRaw)) {
      errors.date = '日期非法：必须为 YYYY-MM-DD 格式且真实存在，例如 2026-11-17';
    }

    var category = String(input.category == null ? '' : input.category).trim();
    if (category === '') {
      errors.category = '请选择分类';
    }

    var noteRaw = String(input.note == null ? '' : input.note);
    if (noteRaw.length > NOTE_MAX_LENGTH) {
      errors.note = '备注不能超过 ' + NOTE_MAX_LENGTH + ' 个字符（当前 ' + noteRaw.length + ' 个）';
    }

    if (Object.keys(errors).length > 0) {
      return { ok: false, errors: errors };
    }

    return {
      ok: true,
      record: {
        id: input.id != null ? String(input.id) : createId(),
        type: type,
        amount: round2(amountRaw),
        date: dateRaw,
        category: category,
        note: noteRaw.trim(),
        createdAt: input.createdAt != null ? String(input.createdAt) : new Date().toISOString()
      }
    };
  }

  /** 校验预警阈值输入；留空表示不启用（null）。 */
  function validateSettingsInput(input) {
    input = input || {};
    var errors = {};
    var fields = [
      { key: 'monthlyBudget', label: '月度预算' },
      { key: 'singleExpenseThreshold', label: '单笔大额阈值' },
      { key: 'minBalance', label: '结余下限' }
    ];
    var settings = { monthlyBudget: null, singleExpenseThreshold: null, minBalance: null };

    fields.forEach(function (field) {
      var raw = String(input[field.key] == null ? '' : input[field.key]).trim();
      if (raw === '') return;
      if (raw.charAt(0) === '-') {
        errors[field.key] = field.label + '不能为负数';
        return;
      }
      if (!/^\d+(\.\d+)?$/.test(raw)) {
        errors[field.key] = field.label + '必须为数字';
        return;
      }
      if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
        errors[field.key] = field.label + '最多两位小数';
        return;
      }
      var numeric = Number(raw);
      if (!Number.isFinite(numeric) || numeric > MAX_AMOUNT) {
        errors[field.key] = field.label + '超出可记录范围（最大 ' + MAX_AMOUNT + '）';
        return;
      }
      settings[field.key] = round2(numeric);
    });

    if (Object.keys(errors).length > 0) return { ok: false, errors: errors };
    return { ok: true, settings: settings };
  }

  function normalizeSettings(value) {
    var settings = { monthlyBudget: null, singleExpenseThreshold: null, minBalance: null };
    if (!value || typeof value !== 'object') return settings;
    Object.keys(settings).forEach(function (key) {
      if (value[key] == null) return;
      var n = Number(value[key]);
      if (Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT) settings[key] = round2(n);
    });
    return settings;
  }

  /** 校验时间范围筛选输入（两个端点均可留空）。 */
  function validateFilterInput(input) {
    input = input || {};
    var errors = {};
    var start = String(input.start == null ? '' : input.start).trim();
    var end = String(input.end == null ? '' : input.end).trim();
    if (start !== '' && !isValidDate(start)) errors.start = '开始日期格式必须为 YYYY-MM-DD';
    if (end !== '' && !isValidDate(end)) errors.end = '结束日期格式必须为 YYYY-MM-DD';
    if (!errors.start && !errors.end && start !== '' && end !== '' && start > end) {
      errors.form = '开始日期不能晚于结束日期';
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors: errors };
    return { ok: true, errors: {}, value: { start: start, end: end } };
  }

  /* ============================== 存储层 ============================== */

  /**
   * 将持久化数据规范为安全记录：金额非法（null / Infinity / 非正数 / 超上限）、
   * 日期非 YYYY-MM-DD、缺失 id 的损坏条目直接剔除，避免渲染层异常。
   */
  function normalizeRecord(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.type !== 'income' && value.type !== 'expense') return null;
    var amount = round2(value.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
    var date = String(value.date == null ? '' : value.date).trim();
    if (!isValidDate(date)) return null;
    var id = value.id == null ? '' : String(value.id);
    if (id === '') return null;
    return {
      id: id,
      type: value.type,
      amount: amount,
      date: date,
      category: String(value.category == null ? '' : value.category).trim(),
      note: String(value.note == null ? '' : value.note),
      createdAt: value.createdAt == null ? new Date().toISOString() : String(value.createdAt)
    };
  }

  /** 基于传入的 storage（浏览器 localStorage 或等价对象）构造记录存取器。 */
  function createRecordStore(storage) {
    function readJson(key, fallback) {
      try {
        var raw = storage.getItem(key);
        if (raw == null || raw === '') return fallback;
        var parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
      } catch (err) {
        return fallback;
      }
    }

    return {
      loadRecords: function () {
        var value = readJson(STORAGE_KEY_RECORDS, []);
        if (!Array.isArray(value)) return [];
        var records = [];
        for (var i = 0; i < value.length; i += 1) {
          var record = normalizeRecord(value[i]);
          if (record) records.push(record);
        }
        return records;
      },
      saveRecords: function (records) {
        storage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(records));
      },
      loadSettings: function () {
        return normalizeSettings(readJson(STORAGE_KEY_SETTINGS, null));
      },
      saveSettings: function (settings) {
        storage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
      }
    };
  }

  function getRecords(storage) {
    return createRecordStore(storage).loadRecords();
  }

  /** 新增：仅当校验通过才写入 localStorage。 */
  function addRecord(storage, input) {
    var result = validateRecordInput(input);
    if (!result.ok) return result;
    var store = createRecordStore(storage);
    var records = store.loadRecords();
    records.push(result.record);
    store.saveRecords(records);
    return result;
  }

  /** 按 id 更新；校验失败或记录不存在时不写入。 */
  function updateRecord(storage, id, input) {
    if (id == null) return { ok: false, errors: { form: '缺少要修改的记录 ID' } };
    var store = createRecordStore(storage);
    var records = store.loadRecords();
    var index = records.findIndex(function (r) { return r.id === id; });
    if (index === -1) return { ok: false, errors: { form: '要修改的记录不存在' } };
    var merged = Object.assign({}, input, { id: id, createdAt: records[index].createdAt });
    var result = validateRecordInput(merged);
    if (!result.ok) return result;
    records[index] = result.record;
    store.saveRecords(records);
    return result;
  }

  /** 按 id 删除；返回是否真的删除。 */
  function deleteRecord(storage, id) {
    var store = createRecordStore(storage);
    var records = store.loadRecords();
    var next = records.filter(function (r) { return r.id !== id; });
    if (next.length === records.length) return false;
    store.saveRecords(next);
    return true;
  }

  /* ============================== 统计与预警 ============================== */

  /** 时间范围筛选（含端点）；start/end 为空表示该侧不限制。 */
  function filterRecords(records, range) {
    range = range || {};
    var start = String(range.start == null ? '' : range.start).trim();
    var end = String(range.end == null ? '' : range.end).trim();
    return records.filter(function (r) {
      if (start !== '' && r.date < start) return false;
      if (end !== '' && r.date > end) return false;
      return true;
    });
  }

  /** 汇总：总收入、总支出、结余与分类统计（内部按分计算，避免浮点误差）。 */
  function computeSummary(records) {
    var incomeCents = 0;
    var expenseCents = 0;
    var byCategory = {};

    (records || []).forEach(function (r) {
      if (!r || (r.type !== 'income' && r.type !== 'expense')) return;
      var cents = Math.round(Number(r.amount) * 100);
      if (!Number.isFinite(cents)) return;
      var bucket = byCategory[r.category] ||
        (byCategory[r.category] = { category: r.category, incomeCents: 0, expenseCents: 0 });
      if (r.type === 'income') {
        incomeCents += cents;
        bucket.incomeCents += cents;
      } else {
        expenseCents += cents;
        bucket.expenseCents += cents;
      }
    });

    var categories = Object.keys(byCategory).map(function (key) {
      return {
        category: byCategory[key].category,
        income: byCategory[key].incomeCents / 100,
        expense: byCategory[key].expenseCents / 100
      };
    }).sort(function (a, b) {
      return (b.expense + b.income) - (a.expense + a.income);
    });

    return {
      totalIncome: incomeCents / 100,
      totalExpense: expenseCents / 100,
      balance: (incomeCents - expenseCents) / 100,
      categories: categories
    };
  }

  /**
   * 三类预警：月度预算超支、单笔大额、结余低于下限。
   * 空数据或对应阈值未设置（null）时返回空数组，绝不误报。
   */
  function computeAlerts(records, settings, today) {
    var alerts = [];
    if (!Array.isArray(records) || records.length === 0) return alerts;

    var normalized = normalizeSettings(settings);
    var now = today instanceof Date ? today : new Date();
    var monthPrefix = now.getFullYear() + '-' + pad2(now.getMonth() + 1);

    var monthExpenseCents = 0;
    var largeExpenseCount = 0;
    var thresholdCents = normalized.singleExpenseThreshold == null
      ? null
      : Math.round(normalized.singleExpenseThreshold * 100);

    records.forEach(function (r) {
      if (!r || r.type !== 'expense') return;
      var cents = Math.round(Number(r.amount) * 100);
      if (String(r.date).slice(0, 7) === monthPrefix) monthExpenseCents += cents;
      if (thresholdCents != null && cents >= thresholdCents) largeExpenseCount += 1;
    });

    if (normalized.monthlyBudget != null) {
      var budgetCents = Math.round(normalized.monthlyBudget * 100);
      if (monthExpenseCents > budgetCents) {
        alerts.push({
          kind: 'monthly-budget',
          level: 'danger',
          message: '本月支出 ' + formatAmount(monthExpenseCents / 100) +
            ' 已超过月度预算 ' + formatAmount(normalized.monthlyBudget)
        });
      }
    }

    if (thresholdCents != null && largeExpenseCount > 0) {
      alerts.push({
        kind: 'single-expense',
        level: 'warning',
        message: '有 ' + largeExpenseCount + ' 笔支出达到单笔大额阈值 ' +
          formatAmount(normalized.singleExpenseThreshold)
      });
    }

    if (normalized.minBalance != null) {
      var balanceCents = Math.round(computeSummary(records).balance * 100);
      var floorCents = Math.round(normalized.minBalance * 100);
      if (balanceCents < floorCents) {
        alerts.push({
          kind: 'low-balance',
          level: 'danger',
          message: '当前结余 ' + formatAmount(balanceCents / 100) +
            ' 低于结余下限 ' + formatAmount(normalized.minBalance)
        });
      }
    }

    return alerts;
  }

  /* ============================== 公共 API ============================== */

  var api = {
    STORAGE_KEY_RECORDS: STORAGE_KEY_RECORDS,
    STORAGE_KEY_SETTINGS: STORAGE_KEY_SETTINGS,
    NOTE_MAX_LENGTH: NOTE_MAX_LENGTH,
    CATEGORY_MAP: CATEGORY_MAP,
    formatAmount: formatAmount,
    todayDateString: todayDateString,
    isValidDate: isValidDate,
    normalizeDate: normalizeDate,
    validateRecordInput: validateRecordInput,
    validateSettingsInput: validateSettingsInput,
    validateFilterInput: validateFilterInput,
    normalizeSettings: normalizeSettings,
    createRecordStore: createRecordStore,
    getRecords: getRecords,
    addRecord: addRecord,
    updateRecord: updateRecord,
    deleteRecord: deleteRecord,
    filterRecords: filterRecords,
    computeSummary: computeSummary,
    computeAlerts: computeAlerts
  };

  var globalScope = typeof window !== 'undefined' ? window : globalThis;
  globalScope.ExpenseApp = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  /* ============================== DOM 层 ============================== */

  function createMemoryStorage() {
    var data = {};
    return {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
      setItem: function (key, value) { data[key] = String(value); },
      removeItem: function (key) { delete data[key]; }
    };
  }

  function safeLocalStorage() {
    try {
      var ls = window.localStorage;
      ls.setItem('expense-tracker:probe', '1');
      ls.removeItem('expense-tracker:probe');
      return ls;
    } catch (err) {
      return createMemoryStorage();
    }
  }

  function initDom(app) {
    var byId = function (id) { return document.getElementById(id); };

    var form = byId('record-form');
    if (!form) return;

    var typeInput = byId('record-type');
    var amountInput = byId('record-amount');
    var dateInput = byId('record-date');
    var categoryInput = byId('record-category');
    var noteInput = byId('record-note');
    var submitBtn = byId('record-submit');
    var cancelBtn = byId('record-cancel');
    var formMessage = byId('record-form-message');

    var filterForm = byId('filter-form');
    var filterStart = byId('filter-start');
    var filterEnd = byId('filter-end');
    var filterError = byId('filter-error');

    var recordsBody = byId('record-list');

    var settingsForm = byId('settings-form');
    var budgetInput = byId('setting-monthly-budget');
    var singleInput = byId('setting-single-expense');
    var minBalanceInput = byId('setting-min-balance');
    var settingsMessage = byId('settings-message');

    var FIELD_ERROR_IDS = {
      type: 'record-type-error',
      amount: 'record-amount-error',
      date: 'record-date-error',
      category: 'record-category-error',
      note: 'record-note-error'
    };
    var SETTINGS_ERROR_IDS = {
      monthlyBudget: 'setting-monthly-budget-error',
      singleExpenseThreshold: 'setting-single-expense-error',
      minBalance: 'setting-min-balance-error'
    };

    var state = { editingId: null, filter: { start: '', end: '' } };
    var storage = safeLocalStorage();
    var store = app.createRecordStore(storage);

    function setFieldErrors(errors) {
      Object.keys(FIELD_ERROR_IDS).forEach(function (key) {
        var el = byId(FIELD_ERROR_IDS[key]);
        if (el) el.textContent = errors && errors[key] ? errors[key] : '';
      });
    }

    function fillCategoryOptions(type, selected) {
      if (!categoryInput) return;
      while (categoryInput.firstChild) categoryInput.removeChild(categoryInput.firstChild);
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '请选择分类';
      categoryInput.appendChild(placeholder);
      (app.CATEGORY_MAP[type] || []).forEach(function (name) {
        var opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (selected === name) opt.selected = true;
        categoryInput.appendChild(opt);
      });
    }

    function resetForm() {
      form.reset();
      state.editingId = null;
      if (submitBtn) submitBtn.textContent = '添加记录';
      if (cancelBtn) cancelBtn.hidden = true;
      if (dateInput) dateInput.value = app.todayDateString();
      fillCategoryOptions(typeInput ? typeInput.value : 'expense', '');
      setFieldErrors(null);
    }

    function setEditing(record) {
      state.editingId = record.id;
      if (typeInput) typeInput.value = record.type;
      fillCategoryOptions(record.type, record.category);
      if (amountInput) amountInput.value = app.formatAmount(record.amount);
      if (dateInput) dateInput.value = record.date;
      if (noteInput) noteInput.value = record.note || '';
      if (submitBtn) submitBtn.textContent = '保存修改';
      if (cancelBtn) cancelBtn.hidden = false;
      setFieldErrors(null);
    }

    function renderRecords(records) {
      if (!recordsBody) return;
      while (recordsBody.firstChild) recordsBody.removeChild(recordsBody.firstChild);
      if (records.length === 0) {
        var emptyTr = document.createElement('tr');
        emptyTr.className = 'empty-row';
        var emptyTd = document.createElement('td');
        emptyTd.colSpan = 6;
        emptyTd.textContent = '暂无记录';
        emptyTr.appendChild(emptyTd);
        recordsBody.appendChild(emptyTr);
        return;
      }
      var sorted = records.slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });
      sorted.forEach(function (record) {
        var tr = document.createElement('tr');
        tr.className = 'record-row ' + (record.type === 'income' ? 'record-income' : 'record-expense');
        tr.dataset.id = record.id;

        var typeTd = document.createElement('td');
        typeTd.textContent = record.type === 'income' ? '收入' : '支出';

        var amountTd = document.createElement('td');
        amountTd.className = 'amount-cell ' +
          (record.type === 'income' ? 'amount-income' : 'amount-expense');
        amountTd.textContent = (record.type === 'income' ? '+' : '-') + app.formatAmount(record.amount);

        var dateTd = document.createElement('td');
        dateTd.className = 'date-cell';
        dateTd.textContent = record.date;

        var categoryTd = document.createElement('td');
        categoryTd.textContent = record.category;

        var noteTd = document.createElement('td');
        noteTd.className = 'note-cell';
        noteTd.textContent = record.note || '';

        var actionsTd = document.createElement('td');
        actionsTd.className = 'actions-cell';
        var editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn btn-small btn-ghost';
        editBtn.dataset.action = 'edit';
        editBtn.textContent = '编辑';
        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn btn-small btn-danger';
        deleteBtn.dataset.action = 'delete';
        deleteBtn.textContent = '删除';
        actionsTd.appendChild(editBtn);
        actionsTd.appendChild(deleteBtn);

        tr.appendChild(typeTd);
        tr.appendChild(amountTd);
        tr.appendChild(dateTd);
        tr.appendChild(categoryTd);
        tr.appendChild(noteTd);
        tr.appendChild(actionsTd);
        recordsBody.appendChild(tr);
      });
    }

    function renderSummary(records) {
      var summary = app.computeSummary(records);
      var incomeEl = byId('summary-income');
      var expenseEl = byId('summary-expense');
      var balanceEl = byId('summary-balance');
      if (incomeEl) incomeEl.textContent = app.formatAmount(summary.totalIncome);
      if (expenseEl) expenseEl.textContent = app.formatAmount(summary.totalExpense);
      if (balanceEl) {
        balanceEl.textContent = app.formatAmount(summary.balance);
        balanceEl.classList.toggle('balance-negative', summary.balance < 0);
      }
      var listEl = byId('summary-categories');
      if (!listEl) return;
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      if (summary.categories.length === 0) {
        var emptyLi = document.createElement('li');
        emptyLi.className = 'empty-placeholder';
        emptyLi.textContent = '暂无数据';
        listEl.appendChild(emptyLi);
        return;
      }
      summary.categories.forEach(function (item) {
        var li = document.createElement('li');
        li.className = 'category-item';
        var name = document.createElement('span');
        name.className = 'category-name';
        name.textContent = item.category;
        var value = document.createElement('span');
        value.className = 'category-value';
        value.textContent = '支出 ' + app.formatAmount(item.expense) +
          ' / 收入 ' + app.formatAmount(item.income);
        li.appendChild(name);
        li.appendChild(value);
        listEl.appendChild(li);
      });
    }

    function renderAlerts(records, settings) {
      var listEl = byId('alerts-list');
      if (!listEl) return;
      var alerts = app.computeAlerts(records, settings);
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      if (alerts.length === 0) {
        var emptyLi = document.createElement('li');
        emptyLi.className = 'empty-placeholder';
        emptyLi.textContent = '暂无预警';
        listEl.appendChild(emptyLi);
        return;
      }
      alerts.forEach(function (alert) {
        var li = document.createElement('li');
        li.className = 'alert-item alert-' + alert.level;
        li.textContent = alert.message;
        listEl.appendChild(li);
      });
    }

    function refresh() {
      var records = store.loadRecords();
      var visible = app.filterRecords(records, state.filter);
      renderRecords(visible);
      renderSummary(visible);
      renderAlerts(records, store.loadSettings());
    }

    /* ---------- 记录表单 ---------- */
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = {
        type: typeInput ? typeInput.value : '',
        amount: amountInput ? amountInput.value : '',
        date: dateInput ? dateInput.value : '',
        category: categoryInput ? categoryInput.value : '',
        note: noteInput ? noteInput.value : ''
      };
      var editingId = state.editingId;
      var result = editingId
        ? app.updateRecord(storage, editingId, input)
        : app.addRecord(storage, input);

      if (!result.ok) {
        setFieldErrors(result.errors);
        if (formMessage) formMessage.textContent = '录入有误，请按提示修改后重试。';
        return;
      }
      var message = editingId ? '记录已更新。' : '记录已添加。';
      resetForm();
      if (formMessage) formMessage.textContent = message;
      refresh();
    });

    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        resetForm();
        if (formMessage) formMessage.textContent = '';
      });
    }

    if (typeInput) {
      typeInput.addEventListener('change', function () {
        fillCategoryOptions(typeInput.value, '');
      });
    }

    /* ---------- 记录列表操作 ---------- */
    if (recordsBody) {
      recordsBody.addEventListener('click', function (event) {
        var btn = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
        if (!btn) return;
        var tr = btn.closest('tr');
        var id = tr ? tr.dataset.id : null;
        if (!id) return;
        if (btn.dataset.action === 'delete') {
          if (window.confirm('确定删除这条记录吗？')) {
            app.deleteRecord(storage, id);
            if (state.editingId === id) resetForm();
            refresh();
          }
        } else if (btn.dataset.action === 'edit') {
          var record = store.loadRecords().find(function (r) { return r.id === id; });
          if (record) setEditing(record);
        }
      });
    }

    /* ---------- 时间范围筛选 ---------- */
    if (filterForm) {
      filterForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var result = app.validateFilterInput({
          start: filterStart ? filterStart.value : '',
          end: filterEnd ? filterEnd.value : ''
        });
        if (!result.ok) {
          if (filterError) {
            filterError.textContent = result.errors.start || result.errors.end ||
              result.errors.form || '筛选条件有误';
          }
          return;
        }
        if (filterError) filterError.textContent = '';
        state.filter = result.value;
        refresh();
      });
      var resetBtn = byId('filter-reset');
      if (resetBtn) {
        resetBtn.addEventListener('click', function () {
          if (filterStart) filterStart.value = '';
          if (filterEnd) filterEnd.value = '';
          if (filterError) filterError.textContent = '';
          state.filter = { start: '', end: '' };
          refresh();
        });
      }
    }

    /* ---------- 阈值设置 ---------- */
    if (settingsForm) {
      settingsForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var result = app.validateSettingsInput({
          monthlyBudget: budgetInput ? budgetInput.value : '',
          singleExpenseThreshold: singleInput ? singleInput.value : '',
          minBalance: minBalanceInput ? minBalanceInput.value : ''
        });
        Object.keys(SETTINGS_ERROR_IDS).forEach(function (key) {
          var el = byId(SETTINGS_ERROR_IDS[key]);
          if (el) el.textContent = result.ok ? '' : (result.errors[key] || '');
        });
        if (!result.ok) {
          if (settingsMessage) settingsMessage.textContent = '设置有误，请按提示修改。';
          return;
        }
        store.saveSettings(result.settings);
        if (settingsMessage) settingsMessage.textContent = '阈值设置已保存。';
        refresh();
      });
    }

    /* ---------- 初始化 ---------- */
    var saved = store.loadSettings();
    if (budgetInput) budgetInput.value = saved.monthlyBudget == null ? '' : app.formatAmount(saved.monthlyBudget);
    if (singleInput) singleInput.value = saved.singleExpenseThreshold == null ? '' : app.formatAmount(saved.singleExpenseThreshold);
    if (minBalanceInput) minBalanceInput.value = saved.minBalance == null ? '' : app.formatAmount(saved.minBalance);
    resetForm();
    refresh();
  }

  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    var boot = function () { initDom(api); };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
})();
