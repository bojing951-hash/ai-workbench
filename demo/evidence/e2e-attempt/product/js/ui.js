// 本地消费记录小站 · 页面交互（DOM 渲染与事件绑定）
// 纯本地运行：不包含任何网络请求逻辑。
(function (global) {
  'use strict';

  var Store = global.ExpenseStore;

  function defaultStorage() {
    try { return global.localStorage; } catch (err) { return null; }
  }

  var store = Store.createStore(defaultStorage());
  var state = { preset: 'all', editingId: null };
  var els = {};

  function $(id) { return document.getElementById(id); }

  function cacheElements() {
    els = {
      form: $('record-form'),
      formTitle: $('form-title'),
      formError: $('form-error'),
      typeRadios: document.querySelectorAll('input[name="record-type"]'),
      amount: $('record-amount'),
      category: $('record-category'),
      date: $('record-date'),
      note: $('record-note'),
      submitBtn: $('submit-button'),
      cancelBtn: $('cancel-edit-button'),
      list: $('record-list'),
      rangeSelect: $('range-select'),
      customRange: $('custom-range'),
      rangeStart: $('range-start'),
      rangeEnd: $('range-end'),
      totalIncome: $('total-income'),
      totalExpense: $('total-expense'),
      totalBalance: $('total-balance'),
      summaryCount: $('summary-count'),
      alerts: $('alerts'),
      alertList: $('alert-list'),
      breakdown: $('category-breakdown'),
      settingsForm: $('settings-form'),
      settingBudget: $('setting-budget'),
      settingLarge: $('setting-large'),
      settingFloor: $('setting-floor'),
      settingsSaved: $('settings-saved')
    };
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function currentType() {
    for (var i = 0; i < els.typeRadios.length; i++) {
      if (els.typeRadios[i].checked) return els.typeRadios[i].value;
    }
    return 'expense';
  }

  function setType(type) {
    for (var i = 0; i < els.typeRadios.length; i++) {
      els.typeRadios[i].checked = els.typeRadios[i].value === type;
    }
  }

  function populateCategories(type, selected) {
    var categories = type === 'income' ? Store.INCOME_CATEGORIES : Store.EXPENSE_CATEGORIES;
    els.category.innerHTML = categories.map(function (name) {
      return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
    }).join('');
    if (selected) els.category.value = selected;
  }

  // ---------- 表单：新增 / 编辑 ----------

  function showFormError(message) {
    els.formError.textContent = message;
    els.formError.hidden = false;
  }

  function hideFormError() {
    els.formError.textContent = '';
    els.formError.hidden = true;
  }

  function onFormSubmit(event) {
    event.preventDefault();
    hideFormError();
    var input = {
      type: currentType(),
      amount: els.amount.value,
      category: els.category.value,
      date: els.date.value,
      note: els.note.value
    };
    var result = state.editingId
      ? store.updateRecord(state.editingId, input)
      : store.addRecord(input);
    if (!result.ok) {
      showFormError(result.errors.join('；'));
      return;
    }
    resetForm();
    renderAll();
  }

  function resetForm() {
    state.editingId = null;
    els.form.reset();
    els.date.value = Store.todayLocal();
    populateCategories(currentType());
    els.formTitle.textContent = '新增记录';
    els.submitBtn.textContent = '添加记录';
    els.cancelBtn.hidden = true;
    hideFormError();
  }

  function startEdit(id) {
    var record = store.getRecord(id);
    if (!record) return;
    state.editingId = id;
    setType(record.type);
    populateCategories(record.type, record.category);
    els.amount.value = String(record.amount);
    els.date.value = record.date;
    els.note.value = record.note;
    els.formTitle.textContent = '编辑记录';
    els.submitBtn.textContent = '保存修改';
    els.cancelBtn.hidden = false;
    hideFormError();
    if (typeof els.form.scrollIntoView === 'function') {
      els.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ---------- 记录列表（事件委托处理 编辑 / 删除） ----------

  function onListClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    var button = target.closest('button[data-action]');
    if (!button || !els.list.contains(button)) return;
    var id = button.getAttribute('data-id');
    var action = button.getAttribute('data-action');
    if (action === 'edit') {
      startEdit(id);
    } else if (action === 'delete') {
      store.deleteRecord(id);
      if (state.editingId === id) resetForm();
      renderAll();
    }
  }

  // ---------- 时间范围 ----------

  function onRangeChange() {
    state.preset = els.rangeSelect.value;
    els.customRange.hidden = state.preset !== 'custom';
    renderAll();
  }

  function currentRange() {
    if (state.preset === 'custom') {
      return Store.resolveRange('custom', { start: els.rangeStart.value, end: els.rangeEnd.value });
    }
    return Store.resolveRange(state.preset);
  }

  // ---------- 提示设置 ----------

  function onSettingsSubmit(event) {
    event.preventDefault();
    store.saveSettings({
      monthlyBudget: els.settingBudget.value,
      largeThreshold: els.settingLarge.value,
      balanceFloor: els.settingFloor.value
    });
    els.settingsSaved.hidden = false;
    renderSettings();
    renderAll();
  }

  // ---------- 渲染 ----------

  function renderAll() {
    renderSummary();
    renderAlerts();
    renderBreakdown();
    renderRecords();
  }

  function renderSummary() {
    var summary = Store.computeSummary(store.listRecords(), currentRange());
    els.totalIncome.textContent = Store.formatMoney(summary.income);
    els.totalExpense.textContent = Store.formatMoney(summary.expense);
    els.totalBalance.textContent = Store.formatMoney(summary.balance);
    if (els.summaryCount) {
      els.summaryCount.textContent = '当前时间范围共 ' + summary.count + ' 条记录';
    }
  }

  function renderAlerts() {
    var alerts = Store.evaluateAlerts(store.listRecords(), currentRange(), store.getSettings());
    if (alerts.length === 0) {
      els.alerts.hidden = true;
      els.alertList.innerHTML = '';
      return;
    }
    els.alerts.hidden = false;
    els.alertList.innerHTML = alerts.map(function (alert) {
      return '<li class="alert-item alert-' + escapeHtml(alert.type) + '">' + escapeHtml(alert.message) + '</li>';
    }).join('');
  }

  function renderBreakdown() {
    var totals = Store.computeCategoryTotals(store.listRecords(), currentRange());
    if (totals.length === 0) {
      els.breakdown.innerHTML = '<p class="empty">当前时间范围内暂无支出记录</p>';
      return;
    }
    els.breakdown.innerHTML = totals.map(function (item) {
      var width = Math.max(item.share, 2);
      return '<div class="category-row">'
        + '<span class="category-name">' + escapeHtml(item.category) + '</span>'
        + '<div class="category-bar"><div class="category-bar-fill" style="width:' + width + '%"></div></div>'
        + '<span class="category-amount">' + Store.formatMoney(item.total) + ' · ' + item.share.toFixed(1) + '%</span>'
        + '</div>';
    }).join('');
  }

  function renderRecords() {
    var records = Store.filterRecords(store.listRecords(), currentRange()).sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return 0;
    });
    if (records.length === 0) {
      els.list.innerHTML = '<p class="empty">暂无记录，快用上方表单记一笔吧</p>';
      return;
    }
    els.list.innerHTML = records.map(function (record) {
      var isIncome = record.type === 'income';
      var kindClass = isIncome ? 'income' : 'expense';
      var sign = isIncome ? '+' : '-';
      var typeLabel = isIncome ? '收入' : '支出';
      return '<div class="record-item" data-id="' + escapeHtml(record.id) + '">'
        + '<span class="record-date">' + escapeHtml(record.date) + '</span>'
        + '<span class="record-type type-' + kindClass + '">' + typeLabel + '</span>'
        + '<span class="record-category">' + escapeHtml(record.category) + '</span>'
        + '<span class="record-note">' + escapeHtml(record.note || '—') + '</span>'
        + '<span class="record-amount amount-' + kindClass + '">' + sign + Store.formatMoney(record.amount) + '</span>'
        + '<span class="record-actions">'
        + '<button type="button" class="btn edit-btn" data-action="edit" data-id="' + escapeHtml(record.id) + '">编辑</button>'
        + '<button type="button" class="btn danger delete-btn" data-action="delete" data-id="' + escapeHtml(record.id) + '">删除</button>'
        + '</span>'
        + '</div>';
    }).join('');
  }

  function renderSettings() {
    var settings = store.getSettings();
    els.settingBudget.value = settings.monthlyBudget > 0 ? String(settings.monthlyBudget) : '';
    els.settingLarge.value = settings.largeThreshold > 0 ? String(settings.largeThreshold) : '';
    els.settingFloor.value = settings.balanceFloor > 0 ? String(settings.balanceFloor) : '';
  }

  // ---------- 启动 ----------

  function init() {
    cacheElements();
    els.date.value = Store.todayLocal();
    for (var i = 0; i < els.typeRadios.length; i++) {
      els.typeRadios[i].addEventListener('change', function () {
        populateCategories(currentType());
      });
    }
    populateCategories(currentType());
    els.form.addEventListener('submit', onFormSubmit);
    els.cancelBtn.addEventListener('click', resetForm);
    els.list.addEventListener('click', onListClick);
    els.rangeSelect.addEventListener('change', onRangeChange);
    els.rangeStart.addEventListener('change', renderAll);
    els.rangeEnd.addEventListener('change', renderAll);
    els.settingsForm.addEventListener('submit', onSettingsSubmit);
    renderSettings();
    renderAll();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
