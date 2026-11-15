# TaskVault

TaskVault 是一个轻量任务管理库，供内部工具复用。

## 开发状态

- `src/store.js` 目前只有占位实现，尚未提供任何功能。
- `tests/store.test.js` 是已经评审通过的验收测试，**禁止修改**。
- 测试命令：`npm test`（等价于 `node --test`）。

## 约束

- 不引入第三方依赖，仅使用 Node.js 内置模块。
- 不修改 `tests/` 下的验收测试。
- 实现需同时支持内存模式与可选 JSON 文件持久化。
