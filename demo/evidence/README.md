# 真实验收证据索引

这些 JSON 由 demo 脚本/证据收集器写入，记录真实运行结果（含失败与修复轨迹）。
注意：发布前已将证据中的本机绝对路径脱敏为 `<workbench-root>`；GitHub PR 链接指向维护者的私有演示仓库，公开读者可能无法访问。

## phase1-1794730530865.json — 阶段一：单项目 + 审计失败自动修复
- 运行状态：**awaiting_acceptance**；尝试 2 次；commit `d196a834ee76`
- 审计历史：fail(75) → pass(96)
- 隐藏验收：[hidden] 仓库根目录新增 CHANGELOG.md，包含 "v1.0.0" 条目并描述本次实现的四个方法，且 README.md 中提供指向 CHANGELOG.md 的链接。
- 消耗：219045 tokens / ¥0.2067

## phase2-1794731070449.json — 阶段二：多任务规划 + 进程崩溃恢复
- 规划任务：#1 服务骨架与健康检查；#2 笔记 CRUD；#3 笔记搜索
- 中断方式：SIGKILL workbench server process；重启后状态：interrupted
- 中断快照：#1=passed，#2=coding，#3=queued
- 最终：awaiting_acceptance；尝试：#1:1，#2:2，#3:2
- 消耗：712530 tokens / ¥0.6393

## phase3-1794732193498.json — 阶段三：多项目并行 + 跨 Agent + GitHub PR/CI
- 并行运行：run_mwhkyo160dbb665d / run_mwhkyo3x127e63e3
- 任务级 Agent：Log Audit #实现日志行解析: dsh；Log Audit #实现日志统计与过滤: claude；Notes API 并行 #实现 Notes API 健康检查: dsh
- 项目 A：awaiting_acceptance；审计 pass(97)；pass(95)
- 项目 B：awaiting_acceptance
- PR：（私有演示仓库 PR #1，链接已脱敏）（draft，未合并）
- GitHub Actions：success
- 消耗：1096639 tokens / ¥1.6926
