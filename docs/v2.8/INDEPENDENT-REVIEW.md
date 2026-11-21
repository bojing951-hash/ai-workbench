# 独立只读审查记录（v28-reviewer）

审查者：`v28-reviewer`，独立只读子代理；未修改文件，未重启生产 Workbench 4477，未触碰 CDL/Reading Queue/其他产品仓库。

## 首轮结论

- 确认 **1 个 P0**：auto-repair 把失败 Run 留在 paused 后清 `current_run_id`，下一次 `startRun` 被 `activeRunForProject(PROJECT_BUSY)` 拒绝；原测试用 mock 未覆盖 tick→startRun。
- 确认 **2 个 P1**：
  1. clause 矩阵位置优先匹配，错位 criteria 可冒充缺失条款 PASS；
  2. contract-only 项目自动生成 requirements 但 quality_command 为空，启用不可通过的 quality gate 导致 loop blocked。
- P2/UNKNOWN：半创建 Run、claim 移除、recover 返回值、Docker env allowlist、cancel 分类、审计预算 preflight、test_setup evidence、文档过时等。

## 整改

- P0：`maybeAutoRepair` 在清 `current_run_id` 前将失败 Run 置 `failed`（ended_at/current_task_id 清空）；新增真实 `Orchestrator.startRun` 回归测试。
- P1 clause：文本精确/包含匹配优先；位置回退仅在 criterion 文本为空时；新增错位 criteria 测试。
- P1 contract-only：无 `quality_command` 时只存 `quality_plan`，不启用 quality gate；有命令才启用。
- P2：半创建 Run 失败清理、claim queue removal 失败回滚、recover claim 结果检查、agent unavailable 分类、Docker env allowlist、ABORTED 分类、auto retry audit preflight。

## 复审结论

**无剩余确认 P0/P1。** 复审用原 repro：
- auto-repair：tick2 loop running，新 repair Run 创建，旧 run `failed`，activeRunForProject null；
- 错位 clause：R1.2 UNKNOWN，requirement UNKNOWN，allPass false；
- contract-only：quality gate disabled，loop 可继续。
- 半创建 Run cleanup 通过。

## 剩余 P2（未阻塞）

- `test_setup_command` 元数据未写入 task evidence（只有日志文件）。
- Docker 质量 worktree 没有项目依赖/浏览器（仅当前测试 command 无依赖）；复杂依赖质量命令需显式 mounts/commit 依赖。
- auto UNKNOWN retry preflight 失败后会继续进入代码修复路径（有界，但未区分 infra）。
- 条款级可执行检查仍由受信 quality command/mount 提供；未自动生成可执行测试。
- 所有 Git/质量写路径穷举 fencing 仍 UNKNOWN。

## 复审后剩余 P2（最终）

- test_setup 元数据在最后一轮已补入 task test evidence；P2 残余为 Docker 质量 worktree 的依赖挂载限制（复杂依赖需 mounts/commit）、自动生成可执行测试未完成、audits 表无直接 commit 字段、全部写路径穷举 fencing UNKNOWN。
- 最终全量测试：256/256（干净本地/Docker 可用环境）；CI 仍需在无 Docker 环境使用 skip 分支（质量隔离不可用用例会 fail-closed/跳过）。
