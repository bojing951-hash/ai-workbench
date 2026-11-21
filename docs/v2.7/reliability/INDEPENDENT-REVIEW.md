# 独立只读审查记录（reliability-reviewer）

审查者：`reliability-reviewer`，只读子代理；未修改代码；审查时的生产 Workbench 4477 未重启。
审查快照：2026-11-16 约 15:05 HKT（工作树仍有并发编辑；md5 见审查会话）。

## 首轮结论

- 无 P0。
- 确认 4 个 P1：
  1. `src/loop.js` 先出队持久化、后 `startRun`；startRun 抛错/进程死亡会丢修复任务。
  2. 启动恢复只对租约判断死亡 owner，`recoverOrphans()`/`LoopManager.recover()` 仍会把**另一个活 Workbench 进程**的 running run/loop 标 interrupted。
  3. `acceptRun`/`resumeRun` 获取控制租约后，校验失败路径不释放，泄漏 30 分钟写租约。
  4. `tests/fencing-http.test.js` 依赖真实 Agent 生命周期，non-owner cancel 断言不稳定；PASS 不具确定性。
- 确认已修复：质量环境隔离/非零退出/超时/无效 JSON/异步；控制写所有权；dead-owner 租约清理；证据一致性和 clause artifact shape。
- P2：质量取消 signal 未接入、质量临时 HOME 泄漏、fault artifacts 重名/错标、clause artifact 手工链接弱、supervisor `nextRestartAt` 陈旧。
- UNKNOWN：完整 237 测试在干净 CI 的复现、FS/network 沙箱、修复前故障注入代码版本、全部 Git/质量写路径 fencing、plan 模式真实 Agent E2E。

## 整改

| 审查项 | 整改 | 回归 |
|---|---|---|
| P1 任务丢失 | `src/loop.js` startRun 失败 catch 恢复 `queue_json`；任务不静默丢失 | `tests/quality-plan-mode.test.js` tick 失败保留任务 |
| P1 活 owner 被恢复踩踏 | `recoverOrphans` 跳过活 owner run；`LoopManager.recover` 跳过活 owner loop；attempts 只标记 recovered run | `tests/fencing.test.js` 活 owner run/loop 保护 |
| P1 控制租约泄漏 | `acceptRun`/`resumeRun` try/finally 释放；失败控制测试 | `tests/control-lease.test.js` |
| P1 HTTP 测试不稳定 | HTTP 测试 agent=custom（无模型调用）；删除依赖 Agent 生命周期的 non-owner cancel 断言；所有权改用确定性 `control-lease` 测试 | 重复全量 237/237 通过 |
| P2 重复/错标 fault 文件 | 删除重复 `fault-injection-run.json`/`-supervisor-state.json`/旧日志；保留 before-fix log 与 after-fix run/state | 证据文件清单 |
| P2 clause 链接弱 | 补充 artifact 指向实际 product test/hidden/CLI 文件；仍为手工追踪 | `tests/evidence-consistency.test.js` |
| P2 quality cancel/temp | 已知未修；取消 signal 未接入、临时 HOME 清理未做 | 标记 UNKNOWN/P2 |

## 复审（第二遍，只读）

**结论：无剩余 P0/P1；四个 P1 均被独立验证修复。**

- 任务丢失：独立 probe `startRun` 抛 `PROJECT_LEASE_HELD` → loop paused、队列保留；再次 tick 正常消费，无重复。
- 活 owner 恢复：probe 活 owner run 保持 running、`skipped:["rl"]`；run/loop 均有回归测试。
- 控制租约泄漏：失败 `acceptRun` 后 `write_owner:''`；`tests/control-lease.test.js` 2/2。
- HTTP 测试：`CLAUDE_BIN=/nonexistent DSH_BIN=/nonexistent` 下 1/1 pass；不过当时测试仍写 `agent:'claude'`，复审指出文档与代码不一致；已在最终代码改为 `agent:'custom'`。
- P2 重名/错标 fault 文件已清理；clause artifact 路径已指向实际产品测试；证据计数 237/237。
- 剩余 P2：质量取消 signal 未接入、质量临时 HOME 未清理、手工 clause 追踪、supervisor `nextRestartAt` 陈旧；`bin/workbench.js` 的 `loops.recover()` 返回形状日志问题已在最终代码修复。
- 未复查：完整 CI 的 237/237（复审者只跑 targeted；最终干净 worktree 与 GitHub Actions 均为 237/237 success）；plan 模式真实 Agent E2E；FS/network 沙箱；完整 Git/质量写路径 fencing。

