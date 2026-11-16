# v2.1 真实研发缺口（用于持续研发循环）

> 本文件是 Planner 的权威候选清单：只包含当前代码中真实缺失、可由单个 Coding Agent 完成、且有可验证产物的能力。
> 已实现的能力不得重复立项；完成项由循环历史与 Git 记录证明。

1. **[API] Provider 用量接口**
   - 现状：`orchestrator.budget()` 已按 provider 统计，但没有公开 API 直接返回 GLM / DeepSeek / OpenAI 的分离用量。
   - 目标：新增 `GET /api/usage/providers`，返回 `{ byProvider, glm, nonGlm, budget, note }`；保持现有 `/api/state` 行为不变。
   - 验收：接口返回 200 且 JSON 包含 `byProvider` 与 `glm`；GLM 与其余模型分开；不修改现有 API；`npm test` 通过；更新 `docs/API.md`。
   - 风险：低；禁止修改 `tests/**`、`package.json`、`.github/**`。

2. **[UI] 研发循环面板**
   - 现状：后端已提供 `/api/loops` 与循环状态，但 Web 界面尚未展示持续研发循环的轮次、进度、停因与历史。
   - 目标：在项目总览或运行视图中增加"研发循环"面板，显示 status/round/maxRounds/stopReason/recent history，并支持刷新；不引入外部依赖。
   - 验收：`web/index.html` 存在面板容器，`web/app.js` 从 `/api/state.loops` 渲染循环状态且对空状态有提示；不修改后端与测试；`npm test` 通过。
   - 风险：低；保持现有暗色设计语言。

3. **[CLI] 循环控制命令**
   - 现状：循环只能通过 HTTP API 控制；命令行没有 loop 子命令。
   - 目标：为 `bin/workbench.js` 增加 `loop start/list/status/pause/resume/cancel` 子命令（复用 HTTP API 或直接 LoopManager），并在 `docs/USAGE.md` 记录用法。
   - 验收：`node bin/workbench.js loop --help` 输出用法；至少实现 list/status/pause/resume；不改变现有 serve/run 命令行为；`npm test` 通过。
   - 风险：低；禁止自动合并/部署。
