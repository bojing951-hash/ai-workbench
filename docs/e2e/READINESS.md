# 真实零人工 E2E 验收状态

生成时间：2026-11-17T05:30Z（Asia/Hong_Kong 13:30）
Workbench：v3.3.0
Git：分支 `v3.3.0`，源码提交 `1ff8307`
Draft PR：https://github.com/bojing951-hash/ai-workbench/pull/15

## 结论

**REAL_E2E_FAILED / RELIABILITY_REMEDIATED_NOT_RETRIED**

用户已于 2026-11-17 明确批准预算并授权安装 Docker。真实 E2E 已实际执行，但 Coding Agent 在 15 分钟无进展 watchdog 边界被中止，自动修复耗尽，产品未达到最终审计/验收。不是 PASS，也不是 BLOCKED；是真实的 FAILED。

## 运行状态

| 项目 | 结果 |
|---|---|
| 服务 | v3.3.0 healthy |
| SQLite | integrity ok |
| Active Loop | 0 running；失败 Loop 已 paused |
| Active project lease | 0 |
| Experiment | 2 个均 `failed`（实验 1/重试实验 2） |
| 未结算预留 | 已全部转 UNKNOWN，不视为免费 |
| Docker | 29.9.3，镜像 `ai-workbench-runtime:2.2` 可用 |
| 容器测试 | `tests/container.test.js` 5/5 PASS（含真实容器执行） |
| 全局预算 | max 3,620,000；remaining 121,011.8；费用 remaining ¥24.7544 |
| 工程回归 | **333 tests / 333 pass / 0 skipped / 0 fail**（Docker 可用） |

## 真实 E2E 结果

- Conversation：`conv_mwk6imxy5gfaz`
- Project：`proj_mwk6j7n9bbd7f450`
- Loop：`loop_mwk6j7rw263f3c67`
- Chat：真实 DeepSeek，一次输入成功；
- Coding：真实 Claude Code/GLM，在 Docker 容器内实际运行；
- 已生成部分产品源码：`demo/evidence/e2e-attempt/product/`
- 部分产品测试：25 tests / 24 pass / 1 fail
- 无最终产品级 DSH PASS、无最终 Git SHA、无 accepted；
- 失败原因：Coding Agent 产出较慢，15m watchdog 中止；auto-repair 2 次同样中止；第二次恢复遇到租约/并发容器清理问题。

详见 `REAL-E2E-ATTEMPT.md`。

## 启动新 E2E 需要

- **新的明确用户授权/新的 experiment contract**（旧契约 failed，不能复用）；
- 仍需保留的预算余量：全局 121,011.8 tokens / ¥24.7544；GLM 约 2.65M tokens / ¥31 剩余；
- Docker 已可用；
- 建议放宽 watchdog（≥45 分钟）并修复 server 重启时容器回收/租约恢复后再重试；
- 不自动合并、不部署。
