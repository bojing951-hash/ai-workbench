# AI Workbench v2.3 — 无人监督自主研发验收报告

- 日期：2026-11-15 / 2026-11-16（Asia/Hong_Kong）
- 范围：**仅 W**。未对 A/B 发起项目级请求、进程操作、文件/分支/推送；未读取其工作区或研发状态。
- 版本：v2.3.0（独立分支 `v2.3.0`）
- 测试：**202/202**（v2.1 186 + v2.2 12 + v2.3 新增 4）
- 最终 Draft PR：#5 https://github.com/bojing951-hash/ai-workbench/pull/5（draft，**未合并 main、未部署生产**）
- CI：https://github.com/bojing951-hash/ai-workbench/actions/runs/43731398017（success，head `303db05`）

## 0. 最终判定（严格遵守用户唯一完成条件）

> **24 小时无人监督验收：FAIL / UNKNOWN（未完整执行 24h）**
> 实际执行的独立无人监督验收窗口为 **24 分 22 秒**（2026-11-15 23:14:20 → 23:38:42 HKT），不是 24 小时。
> 因此**不宣布产品已达到“24 小时无人干预连续研发”的目标**；仅报告本次加速验收中可验证的结果。

- 本次加速验收：**5/5 任务完成、100% Coding Agent 自主、0 次人工代码干预、2/2 故障恢复成功、5/5 测试与独立审计通过**。
- 未满足的条件：24 小时持续时间；非 GLM 预算已接近上限（剩余 11,908），继续长跑需要用户决定预算/审计模型；因此无法在当前预算下完成真实 24h 连续验收。
- 未把加速验收结果冒充 24h 验收。

## 1. 独立无人监督验收设计

- 独立 W 测试项目：`projects/v2.3/acceptance-run4`（与主工作树隔离，不涉及 A/B）。
- 验收测试由本工程在启动前**冻结**：`tests/task1..5.test.js`（共 10 个断言测试）；Agent 被禁止修改测试/package.json/.github。
- 5 个互有依赖的研发任务：events → state → ledger → report → CLI；每个任务只运行自己的冻结测试，最后统一复跑 10/10。
- 项目配置：Claude Code（GLM，豁免内部预算）为主 Agent；DSH 为备选但预算不足时自动跳过；独立审计 DeepSeek；maxAttempts=4；watchdog 300s；`low_budget_finalize=true`。
- 验收期间**没有任何 Supervisor 修改 `src/` 代码**；外部只执行了故障注入和监控。

## 2. 故障注入与恢复

| 故障 | 注入 | 系统行为 | 结果 |
|---|---|---|---|
| Coding Agent 无进展 | 任务 2 对 Claude 子进程 `SIGSTOP`（23:18:40 HKT） | 工作树 300s 无推进 → watchdog 终止进程、分类 `stalled`、清理会话、切换/新建会话重试；任务 2 第二次尝试成功 | **恢复成功** |
| Workbench 进程崩溃 | 任务 4 执行中 `SIGKILL`（23:33:00 HKT） | 重启后 run/loop=`interrupted`，3 条 history 保留；任务 4 原 attempt 标记 interrupted（费用未知）；`resume {retryCurrent}` 后重新执行并完成 | **恢复成功** |

- 恢复成功率：**2/2**。
- 恢复后无重复轮次/重复 commit：3 条已有 history 保留，最终 5 个唯一 commit。
- 中断 attempt 的厂商用量无法获得时标记 `cost_source=unknown`，不伪造 0。
- 无人工修复代码；任务成功由 Agent 完成。

## 3. 本轮修复的自主执行根因

### 3.1 Agent 无进展检测（原：只看进程存活/超时过长）
- `runAgentWithWatchdog()`：每 5-30s 读取 worktree 的 git status/diff 变化；超过 `agent_stall_timeout_ms` 无进展 → abort 子进程；结果标记 `stalled`。
- 项目可配置 stall 超时；本次 300s；Claude 读取阶段较长不再被 120s 误杀。
- 实测：SIGSTOP 后 watchdog 终止并触发新会话；任务完成。

### 3.2 Agent 失败分类与替代/重试路径
- `classifyAgentFailure()`：`stalled / agent_timeout / agent_aborted / budget / agent_no_output / infrastructure / agent_error`，写入 `attempts.failure_class`。
- `resolveAgentCandidates()`：主 Agent + 配置备选；非 GLM 备选在剩余预算 <100k 时自动跳过（避免把预算浪费在不可用 Agent）。
- 主 Agent 失败后切换备选；备选也失败则**回到主 Agent 全新会话**继续（不降低验收标准，受 maxAttempts 限制）。
- 本次任务 2 正是 watchdog→新会话成功；DSH 因预算不足未被无效重试。

### 3.3 任务状态 JSON 指数膨胀（关键隐藏根因）
- 现象：任务 2 运行时出现 `Invalid string length`，run/task 异常中断；DB 中 `tasks.verification_json` 达到 268MB。
- 根因：`getTask/listTasks` 未 JSON.parse `verification_json`，`updateTask` 每次把已序列化字符串再次 `JSON.stringify`，随状态更新指数级转义膨胀。
- 修复：解析 verification_json；`updateTask` 防御性 parse；新增回归测试（20 次更新后 <2KB）；修复了已膨胀记录。
- 这是此前"恢复后异常/无法继续"的真实隐藏根因之一。

### 3.4 预算结算阻塞最终验收（低预算 finalize）
- 现象：任务 2 已通过测试+审计，但 run finalize 前因"保留 20k tokens"被 paused，循环无法进入下一任务。
- 修复：**先判断是否还有需要模型调用的排队任务**；没有排队任务时允许在项目显式 `low_budget_finalize=true` 下完成本地 finalize；默认行为保持不变（既有 186 项测试中的预算暂停契约仍通过）。
- 同时保留非 GLM 硬预算上限；GLM 仍按用户授权豁免。`minReserveTokens` 默认从 20k 降到 2k（仅安全余量，不改变上限）。
- 结果：任务 2/3/4/5 的审计继续完成，全程成本 ¥28.76/¥30。

### 3.5 其他
- 容器/测试/模型身份等 v2.2 能力保持；本轮未新增无关功能。
- 任务完成判定仍要求真实测试、独立审计、commit、验证状态；UNKNOWN 不推进。

## 4. 客观评价

| 指标 | 值 |
|---|---|
| 自动完成任务数 / 总任务数 | **5 / 5** |
| Coding Agent 自主完成率 | **100%**（所有 5 个 src 文件最终版本由 Agent 会话写入；无 Supervisor 代码修改） |
| 人工代码干预次数 | **0** |
| 卡死注入次数 / 恢复结果 | 1 次 / 恢复成功 |
| Workbench 崩溃注入 / 恢复结果 | 1 次 / 恢复成功 |
| 故障恢复成功率 | **2/2** |
| 每任务冻结测试 | 5/5 通过；合并测试 10/10 通过 |
| 独立审计 | 5/5 DeepSeek **PASS**（88/92/92/92/92） |
| Agent 尝试次数 | 任务 1/3/5 一次成功；任务 2 两次（stall→新会话）；任务 4 两次（崩溃→重试） |
| 验收窗口 | **24m22s**（不是 24h） |
| GLM 用量/费用（验收窗口） | 612,971 tokens / ¥5.59（内部预算豁免，真实记录） |
| DeepSeek 审计用量/费用 | 10,366 tokens / ¥0.023（受原预算约束） |
| 全局成本 | ¥28.76 / ¥30；非 GLM 预算剩余 11,908 |
| 未解决阻塞 | 24h 时长未执行；非 GLM 预算接近上限；容器 Agent egress allowlist；A/B 未触碰 |

### 任务与 commit

| 轮 | 任务 | Commit | 测试 | 独立审计 |
|---|---|---|---|---|
| 1 | events.js | `8f0888a4` | task1 PASS | DeepSeek PASS 88 |
| 2 | state.js（故障恢复） | `7d4fc364` | task2 PASS | DeepSeek PASS 92 |
| 3 | ledger.js | `8e87a521` | task3 PASS | DeepSeek PASS 92 |
| 4 | report.js（崩溃恢复） | `d9aabca5` | task4 PASS | DeepSeek PASS 92 |
| 5 | cli.js | `86bd2f28` | task5 PASS | DeepSeek PASS 92 |

## 5. 结论

- **核心自主能力**：在本次加速验收中，Workbench 能在无人干预下连续执行 5 个真实、互有依赖的开发任务；遇到 Agent 无进展和进程崩溃均能自动恢复并完成；无人工代码干预。
- **严格目标未达成**：没有真实执行 24 小时，且非 GLM 预算不足；因此 **24h 无人监督验收判定 FAIL/UNKNOWN**，不能宣布产品已达到最终目标。
- 已修复根因均带测试/证据；剩余问题需用户预算决定或更长窗口。
- 交付：v2.3.0 分支、Draft PR #5、证据 `demo/evidence/v2.3-autonomy-final.json`、可复现验收夹具 `docs/v2.3/acceptance-fixtures/`。
