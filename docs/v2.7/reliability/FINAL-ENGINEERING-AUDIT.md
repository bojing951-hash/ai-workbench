# v2.7 可靠性整改工程审计

- 基线：`v2.7.0` / `8d56700`（PR #9）
- 本轮范围：仅 Workbench 可靠性、质量执行、Fencing/故障恢复、证据一致性；不新增产品功能、不升级版本、不合并 main。
- 独立审查：`reliability-reviewer`（只读子代理，两轮）；首轮 4 个 P1 已全部整改并复审确认无剩余 P0/P1；详见 `INDEPENDENT-REVIEW.md`。
- 未触碰：Global Opportunity Engine、Investment Agent、Consumption Decision Lab；生产 Workbench 4477 仅在阅读/测试，不重启其研发任务。

## 问题与整改

| ID | 原审计问题 | 根因 | 整改 | 验证 | 状态 |
|---|---|---|---|---|---|
| P0 | 质量命令继承完整宿主环境，使用 spawnSync | `runQualityCommand` 直接 `/bin/sh` + `...process.env` | `src/quality.js` 改为异步 `execCapture`；使用 `buildTestEnv` + 项目 `env_allowlist` + 显式 `allowed_commands`；不传 API Key/GitHub Token；超时/取消；macOS 下尝试 sandbox-exec（deny network/敏感 file）；沙箱不可用时显式 env-only 降级并记录 | `tests/quality-execution.test.js`：宿主 LEAK_SECRET 不泄漏；正常检查 PASS | **PARTIAL**：凭据/环境隔离 PASS；本宿主 `sandbox_apply: Operation not permitted`，文件/网络强制沙箱 **BLOCKED/UNVERIFIED** |
| P1-A | plan 模式质量修复任务只能 queue 模式 | `src/loop.js` 仅 `loop.mode === 'queue'` 入队；plan 模式直接 blocked | plan/queue 共享质量修复队列；有 `qualityIssueId` 的修复任务优先于普通规划；`max_cycles` 边界保留；无证据假设不入队 | `tests/quality-plan-mode.test.js`：plan 模式质量 FAIL→修复任务入队；原 queue 集成测试保持 | **IMPLEMENTED + TESTED（代码级）**；真实 plan 模式 Agent E2E **UNKNOWN** |
| P1-B | 非零退出码但 JSON 可解析可能被当成功 | 原逻辑只看 `parseJsonOutput` | 非零退出、spawn error、timeout、无效 JSON 分别分类；全部 `ok:false/commandFailed:true`；基础设施失败不变成产品缺陷（hypothesis） | `tests/quality-execution.test.js` 四类失败 | **PASS** |
| P1-C | 同步质量命令阻塞事件循环/健康检查 | `spawnSync` 同步等待最长 300s | 改用异步 `execCapture`，支持 abort signal、超时 kill；loop 中 `await`；不新增队列框架 | 异步测试检查 interval ticks≥3；质量命令 300–500ms 期间事件循环继续 | **PASS（单元级）**；长测试时真实 HTTP health 未单独压力测 |
| P1-D | Fencing 未覆盖所有控制写入/完整 HTTP 服务竞争 | `pause/resume/cancel` 无所有权保护；启动恢复只清 **过期** 租约，不识别已死亡 owner；loop completeRound 无写租约 | 新增 `ensureControlLease`；pause/resume/cancel/accept 校验 owner；dead-owner 启动清理；loop 历史写入持租约；真实双 HTTP 竞争测试 | `tests/fencing-http.test.js`：两服务只一个建 run（agent=custom，无模型依赖）；`tests/control-lease.test.js`：非 owner 控制写拒绝、失败不泄漏租约；`tests/fencing.test.js` dead/live owner 清理；`fault-injection` 活跃任务 SIGKILL 恢复 | **PARTIAL PASS**：双 HTTP run 创建/控制/PID 死亡恢复 PASS；所有 Git/质量写路径完整 fencing 仍 **UNKNOWN** |
| P1-E | 覆盖矩阵只到需求编号，证据 JSON 旧状态矛盾 | 质量检查只返回 requirement 级；验收 JSON 残留旧 blocked/loopId/时长单位 | 新增 clause 级补充追踪 `reading-queue-clause-coverage.json`；修正 `v2.7-evidence.json` 状态/loop/run/成本/时长为一致；新增证据一致性测试 | `tests/evidence-consistency.test.js`：状态、矩阵、attempts、audit、成本、时间、commit、24h 互相一致 | **PASS（现有产品证据）**；质量引擎自动逐 clause 判定仍 **PARTIAL** |

## 失败驱动修复记录（真实故障）

1. 活跃任务 SIGKILL 后，重启的 Workbench 拒绝恢复：
   `项目写租约由其他执行者持有（wb:53050:..., fence=1）`。
   根因：启动只清理过期租约，旧进程已死但 30 分钟租约未过期。
   修复：`clearLeasesFromDeadProcesses()` 按 owner 的 pid 判断死亡，只清新死亡 owner；活 owner 保留；活跃 SIGKILL 重测 `resumed:true`。
2. 两个独立 Workbench HTTP 服务启动时同时迁移 SQLite 导致 `database is locked`；测试改为先启动 A 健康再启动 B（生产单实例启动不涉及并发迁移；这是测试启动顺序，不是产品代码缺陷）。
3. quality sandbox-exec 在当前受限宿主返回 `sandbox_apply: Operation not permitted`；不能把基础设施失败错判为产品缺陷，已实现明确 fallback 和审计标注，未声称完整文件沙箱。

## 未完成/UNKNOWN

- 新一次完整产品 E2E（本修复后）未执行：新的独立验收项目没有新的 DSH ¥30 授权，按用户预算边界 **BLOCKED**；不把旧产品的 PASS 当作修复后 E2E。
- plan 模式真实 Coding Agent 修复 E2E 未执行（只有队列/代码级测试）。
- 所有 Git checkout/分支推进/质量历史写入路径的完整跨进程 fencing 未全部验证；只验证 run 创建、控制 API、dead-owner 恢复和 loop completeRound 租约。
- 24H 未执行。
