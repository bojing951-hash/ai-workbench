# 本地消费记录小站

面向个人用户的纯前端本地消费记账小站，无需后端与网络请求，数据保存在浏览器 localStorage。功能包含：收入/支出记录的增删改查（金额、日期、分类、备注校验，支持时间范围筛选）；汇总看板（总收入、总支出、结余、分类统计，金额统一两位小数）；消费预警（月度预算超支、单笔大额、结余低于下限，阈值可设置，空数据或无设置时不误报）。页面响应式，日期格式 YYYY-MM-DD，非法输入给出明确错误提示。

由 AI Workbench Chat 创建；验收契约见 CONTRACT.md。

## 运行

纯静态页面，无构建步骤：直接用浏览器打开 `index.html` 即可，所有数据保存在当前浏览器的 localStorage 中。

## 运行测试

```bash
npm test        # 等价于 node --test tests/
```

测试基于 Node 内置的 `node:test`（Node >= 18），无需安装任何依赖：

- `tests/app.test.js` —— 产品测试：输入校验（金额/日期/分类/备注）、localStorage 增删改查与持久化、时间范围筛选、汇总统计与分类统计、三类消费预警、金额两位小数与日期格式、页面静态结构与无外链检查。
- `tests/dom-wiring.test.js` —— 产品测试：页面接线（app.js 引用的 DOM id 均存在于 index.html）、无 innerHTML / 内联事件、资源全部为相对路径、响应式媒体查询与内置分类可写入。
- `tests/dom-level.test.js` —— 产品测试：基于内置假 DOM 的端到端流程（提交合法记录→持久化→模拟刷新后重新渲染、非法输入显示错误且不写入、Infinity 级超大金额/阈值拦截、编辑回填两位小数、删除、时间筛选、阈值设置与预警渲染、损坏 localStorage 数据规范化）。
- `tests/acceptance/workbench-contract.test.mjs` —— Workbench 冻结契约测试（只读）。
