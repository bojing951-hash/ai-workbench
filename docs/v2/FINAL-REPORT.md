# AI Workbench v2.0 工程验收报告

- 执行时间：2026-11-15（Asia/Hong_Kong）
- 控制版本：AI Workbench v2.0.0（分支 `v2.0.0`，基于公开 v1.0.0）
- 工作台：http://127.0.0.1:4477 （本地，仅回环）
- 证据目录：`demo/evidence/`、SQLite `data/workbench.db`、GitHub PR/Actions

## 1. 交付摘要

| 交付物 | 状态 |
|---|---|
| 更新后的 Workbench 源码（v2.0.0） | 完成（未合并 main，待人工批准） |
| P0 安全/可靠性整改 | 完成，PASS（深度内核隔离 BLOCKED，见 §5） |
| W、A、B 接入 | 完成：W 可写；A 只读+沙箱分支；B READ_ONLY |
| 真实验收任务 | W：Claude Code 任务 PASS + PR/CI；A：DSH + Claude 两个真实任务 PASS；B：DSH 任务在隔离克隆执行（验证中/见矩阵） |
| 自我升级机制 | 完成；候选版本离线测试+隔离实例+真实任务 E2E 通过 |
| GitHub PR | W：draft PR #1，CI success；A/B 推送按授权 BLOCKED |
| 自动化测试 | 180 项离线测试全通过（原 84 + 新增 96） |
| 验收矩阵 | `docs/v2/ACCEPTANCE-MATRIX.md` |

## 2. 三项目真实执行

### W：AI Workbench v2.0
- 任务：`/api/health` 增加 verification 字段并更新 `docs/API.md`
- Agent：Claude Code（受限 acceptEdits+工具白名单，未 bypass）
- 测试：`npm test` 180/180 通过
- 独立审计：DeepSeek（与 Claude/GLM 编码模型族独立）**PASS 88**
- GitHub：草稿 PR #1（draft/open/未合并），Actions CI **success**，verification_status=**CI_PASSED**，verified_sha=`a8d4fe61…`
- W 任务证据 PR（早期 draft）：https://github.com/bojing951-hash/ai-workbench/pull/1
- **最终 v2.0.0 候选 PR（draft）**：https://github.com/bojing951-hash/ai-workbench/pull/2 ，Actions CI success（https://github.com/bojing951-hash/ai-workbench/actions/runs/43707764842）
- W 任务 CI：https://github.com/bojing951-hash/ai-workbench/actions/runs/43704371912

### A：Global Opportunity Engine
- 接入：只读配置 + 工作区隔离副本（权威树未被修改）；基线 `architecture/research-v2` 快照
- 任务 1（DSH）：新增 `tests/test_pit_lookahead.py`（3 个 PIT 前视偏差测试，调用真实 `no_lookahead_diff`/FeatureBuilder），全量离线 pytest 通过；独立审计 **GLM PASS 92**；commit `8dd43985…`
- 任务 2（Claude Code）：新增 `docs/WORKBENCH_INTEGRATION.md`（只读/沙箱边界、测试命令、A→B handoff、远端授权状态），全量 pytest 通过；独立审计 **DeepSeek PASS 92**；commit `d5f849a2…`
- 既有测试/验收文件未修改；A→B 接口契约只读核对通过（HANDOFF_SCHEMA v1.0 + `ia_cli research-run --out-dir`）
- 远端 PR：**BLOCKED**（A 本地分支领先远端 main 100+ 提交、未授权推送）

### B：Investment Agent
- 接入：READ_ONLY（权威树/agent-loop/LIVE 零写入；无外部研发进程可安全持有的写锁）
- 隔离克隆任务（DSH）：新增 `tests/test_workbench_handoff_contract.py`（36/36 通过），覆盖 `ia_cli research-run --out-dir` 单 JSON 信封、report.json/md 双落盘、L3/L4 declared-not-produced、SKIP 契约、临时目录隔离；状态门 7/7、thresholds G1-G4 通过；独立审计 **GLM PASS 92**；commit `15e0aa4e…`
- 全量 157 套件在 Workbench 隔离 worktree 中执行出现环境相关失败（缺原始数据/运行环境，非代码回归）；Phase 0 已用干净 clone 独立复跑 157/157，如实记录为 UNKNOWN，不冒充 PASS
- 远端推送/权威树写入：**BLOCKED**（项目红线：推送=公开发布，需用户逐波批准；LIVE/launchd 禁止）

## 3. P0 整改（详见 `docs/v2/SECURITY-REMEDIATION.md`）

- P0-1：Claude 默认 acceptEdits+工具白名单，移除 `--dangerously-skip-permissions`；DSH 默认 workspace-write；危险模式需显式 `WORKBENCH_ALLOW_UNSAFE_AGENT=1`，否则阻塞。
- P0-2：Agent/测试进程最小环境；测试只接受项目 allowlist 环境变量，不继承 GitHub Token/无关模型 Key。
- P0-3：逐条精确验收、结构化证据、PASS/FAIL/UNKNOWN、diff 分块、测试/审计/提交 tree hash 绑定、审计模型族独立；证据不足不 PASS。
- P0-4：verification_status（LOCAL_VERIFIED/CI_PENDING/CI_PASSED/CI_FAILED）、verified_sha、CI 等待与验收硬校验；CI 失败/超时暂停并生成审批。
- P0-5：API Token + SameSite Cookie、Host/Origin/CSRF、测试命令 allowlist、artifact 白名单/大小/二进制检查、realpath/symlink 越界防护。
- P0-6：四级预算、墙钟、每项目运行锁、重复失败签名、费用来源（vendor/estimated/UNKNOWN）；未知成本不显示为 0。
- 回归测试：`tests/security.test.js`（41）、`audit-hardening.test.js`（36）、`upgrade.test.js`（7）、`server-security.test.js`（12），总计 180 全绿。

## 4. 自我升级（P3）

- 机制：`src/upgrade.js` + `scripts/self-upgrade.mjs`（候选副本→离线测试→隔离端口/数据目录实例→API 冒烟→可选真实任务）。
- 实测：候选目录 `cand_mwhq264d_id8k`，离线测试 PASS（180），隔离实例 PASS（version=2.0.0），真实 E2E 任务 awaiting_acceptance/ LOCAL_VERIFIED。
- 证据：`demo/evidence/upgrade-1794740416372.json`；稳定实例全程未替换。

## 5. BLOCKED / UNKNOWN（如实披露）

| 项 | 状态 | 原因 |
|---|---|---|
| 真正 OS 级沙箱/文件网络隔离 | BLOCKED | 宿主机嵌套环境 `sandbox-exec` 不可用；未用 danger-full-access 绕过 |
| A 远端 PR/CI | BLOCKED | 本地分支领先远端 main 100+ 提交，推送未授权 |
| B 权威树/远端/LIVE 写入 | BLOCKED | 项目红线；需用户逐波批准；当前 READ_ONLY |
| B 全量离线套件（Workbench 隔离 worktree） | UNKNOWN（环境） | 全量 157 套件在隔离 worktree 中因缺少原始数据/环境失败；Phase 0 干净 clone 基线 157/157；不以失败结果冒充通过 |
| 预算原始 token 超 3M | 披露 | 原始 token 8.1M 中约 7.xM 为缓存读取（按 0.1 折算后预算 1.32M）；实际成本 ¥9.24 < ¥30。若按原始 token 严格解释则超出授权上限——不宣称满足该项 |
| GPT 独立审计 | UNKNOWN | 无 OPENAI_API_KEY；真实审计使用 GLM/DeepSeek（均与编码模型族独立） |

## 6. 验证入口

- 工作台：`npm start` → http://127.0.0.1:4477
- 测试：`npm test`（180）
- 候选：`node scripts/self-upgrade.mjs --real-e2e`（消耗真实 token）
- 验收矩阵：`docs/v2/ACCEPTANCE-MATRIX.md`
- Phase 0：`docs/v2/PHASE0-AUDIT.md`、`phase0-project-A/B.md`
- P0 审计：`docs/v2/P0-AUDIT.md`
- 证据：`demo/evidence/`

## 7. 下一轮可恢复队列

1. 人工验收 W/A/B 运行（工作台界面「验收」；W 验收远端 CI_PASSED；A/B 本地验收需确认）。
2. W：合并/发布 PR #1 需用户批准（工作台不合并）。
3. A：授权后可推送沙箱分支并创建 draft PR（需确认 A 远端基线）；A→B 真实联调需写 output，需授权。
4. B：若用户/操作者允许，可把沙箱分支 patch 交给 B 的研发流程；权威树合并/推送/LIVE 仍禁止。
5. 预算：如需继续真实 Agent 任务，建议重置/提高 token 预算，或保持缓存折算口径并明确批准。
6. 真正的内核隔离需迁移到有 sandbox/容器能力的宿主机；本机无法提供。
