# Phase 0 现状审计（2026-11-15）

详细项目分析见 [phase0-project-A.md](phase0-project-A.md) / [phase0-project-B.md](phase0-project-B.md)，P0 代码审计见 [P0-AUDIT.md](P0-AUDIT.md)。

## 1. 环境

| 项 | 事实 |
|---|---|
| OS / 宿主 | macOS (Apple Silicon)，嵌套运行环境 |
| Node / 测试 | Node.js v24.13.1；`npm test` 基线 84 项（v2 后 180 项） |
| Coding Agent | DeepSeek Harness headless（workspace-write 文件工具可用，bash 因宿主 sandbox 不可用被拒绝）；Claude Code 2.1.104（GLM-5.3 Anthropic 兼容端点，需隔离配置 bootstrap） |
| 审计模型 | GLM-5.3（Anthropic 端点，思考 token 较大，已提高 max tokens）；DeepSeek（OpenAI 兼容）作为独立审计备选 |
| 系统 sandbox | `sandbox-exec` 不可用 → 无法提供真正内核级隔离；按 fail-closed 处理，禁止自动降级 danger-full-access |
| 运行中的服务 | AI Workbench 本地服务 127.0.0.1:4477（v2 代码）；GitHub Actions 正常 |
| 预算 | 原始 token 累计与折算预算（缓存读取权重 0.1）分别展示；详细见运行记录 |

## 2. 三个项目的真实状态

### W：AI Workbench
- 仓库：https://github.com/bojing951-hash/ai-workbench（public，v1.0.0 已发布，v2.0.0 本地分支）
- 基线：v1.0.0（commit 1f809fa）；v2 开发分支 `v2.0.0`（commit 8a22ed5）
- 结论：**可管理自身**；候选版本验证通过（测试+隔离实例），真实任务（Claude Code）与 draft PR #1 / CI 已生成。

### A：Global Opportunity Engine
- 仓库：https://github.com/bojing951-hash/global-opportunity-engine（public，Python）
- 权威本地树：`~/Downloads/金融系统/global-opportunity-engine`，活跃分支 `architecture/research-v2`；审计时 HEAD 曾从 `50b60a1` 推进到 `5c055cc`（另一进程提交/工作），工作区副本冻结在该 commit。
- 真实测试：离线 pytest（`-m "not network"`），全量约 95-190s；历史基线 231 项，Phase 0 实测通过。
- CI：`.github/workflows/verify-release.yml`（重放最新 release proof + 用例集合哈希），可作为离线闸门但不覆盖 network/realdata。
- A→B：`HANDOFF_SCHEMA v1.0` JSON + `goe handoff` / `ia_cli research-run --out-dir`；已有单测与文档级真实联调记录，无跨仓库自动化门。
- 结论：**只读接入 + 工作区隔离副本**；远端 main 落后于本地分支 100+ 提交，远端推送未授权 → PR/CI 标记 BLOCKED；本地开发/测试/审计可执行。

### B：Investment Agent
- 仓库：https://github.com/bojing951-hash/investment-agent（public，Python，611+ commits）
- 权威研发树：`~/investment-agent-dev`；审计窗口内另一操作者会话推进到 R36 本地 main `ee4fbb6`（未推送），工作区克隆基线 `0f53463`。
- 研发循环：`~/agent-loop` 无 headless 锁/STOP（上一轮空闲），但操作者席会话活跃、无第三方可安全持有的写锁/租约；按 READ_ONLY 处理。
- 测试：官方口径逐套件 `python3 -B tests/test_*.py`（跳过 `test_model_live`），干净 clone 全库 157/157（约 8.6min）；本机依赖已预装。
- 结论：**READ_ONLY**；仅工作区隔离克隆可做沙箱分支，禁止写权威树/推送/main/LIVE/付费数据。
- A→B：接收面 `ia_cli.py research-run --question --out-dir`，产物 report.json+md；已有单测，无跨仓库自动化门。

## 3. 整改任务矩阵（Phase 2 已完成情况）

| 编号 | 问题 | 整改 | 状态 |
|---|---|---|---|
| P0-1 | Agent 危险权限 | Claude 默认 acceptEdits+工具白名单，DSH 默认 workspace-write，危险模式显式开关+失败关闭 | PASS（本机无内核沙箱 → 深度隔离 BLOCKED） |
| P0-2 | 密钥继承 | Agent/测试最小环境；测试 env allowlist | PASS（41+ 测试） |
| P0-3 | 审计可靠性 | 精确匹配+证据+三态+diff 分块+SHA 绑定+独立模型选择 | PASS（36+ 测试 + 真实验证） |
| P0-4 | CI 闸门 | verification_status、verified_sha、CI 等待与 accept 校验 | PASS（W PR CI_PASSED 实证） |
| P0-5 | 本地服务安全 | Token/Cookie 认证、Host/Origin/CSRF、路径/symlink、artifact 白名单、命令 allowlist | PASS（12 测试） |
| P0-6 | 预算/失败控制 | 全局/项目/运行/任务预算、墙钟、运行锁、重复失败、费用来源 | PASS（测试+真实预算中断/恢复） |

## 4. Phase 0 结论

- 可直接进入 Phase 1：W/A/B 三个项目已在工作台注册（A/B 只读配置，W 可写）。
- 需用户/操作者授权的硬阻塞：A 远端推送与 PR；B 任何权威树写入/推送/LIVE/付费数据；W 生产部署。
- 本机无法提供的真正沙箱能力：标记 BLOCKED，不伪造。
