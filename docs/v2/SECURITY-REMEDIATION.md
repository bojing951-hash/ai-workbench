# P0 安全与可靠性整改报告（v2.0.0）

对照 `docs/v2/P0-AUDIT.md`（独立只读审计，基于 v1.0.0 HEAD `1f809fa`）逐项整改。

| P0 | 整改内容 | 关键代码 | 验证 |
|---|---|---|---|
| P0-1 Agent 权限 | Claude 默认改为 `acceptEdits` + 工具白名单（Read/Edit/Write/Glob/Grep/LS），禁用 Bash/WebFetch/WebSearch/Task；DSH 默认 `workspace-write`；危险模式需 `WORKBENCH_ALLOW_UNSAFE_AGENT=1` 显式开启；隔离 Claude 配置目录写入 onboarding/key 批准记录，避免交互挂起但没有启用 bypass | `src/agents/claude.js`、`src/agents/dsh.js`、`src/security.js` | 新增 12 项 permission/env 测试；真实受限 Claude 探针（无 Bash，成功写文件） |
| P0-2 密钥/测试隔离 | Agent 子进程只接收该 Agent 必需的环境；测试进程只接收安全基础变量 + 项目声明的 allowlist；`GITHUB_TOKEN`、无关 API Key 不进入测试/Agent 环境 | `src/security.js` `buildAgentEnv` / `buildTestEnv` | `tests/security.test.js`（41 用例） |
| P0-3 独立审计 | 验收标准精确匹配、禁止下标兜底；PASS 必须有结构化具体证据；缺失/重复/unproven → UNKNOWN；显式 fail/high finding → FAIL；diff 超限分块审计（无法完整覆盖 → UNKNOWN）；测试/审计/提交绑定 worktree tree hash；审计模型选择排除编码模型族（DSH→GLM，Claude/GLM→DeepSeek），无独立模型则阻塞 | `src/auditors/index.js`、`src/policy.js`、`src/orchestrator.js` | `tests/audit-hardening.test.js`（36 用例）+ 真实 GLM/DeepSeek 审计 |
| P0-4 CI 闸门 | 新增 `verification_status`（LOCAL_VERIFIED/CI_PENDING/CI_PASSED/CI_FAILED）、`verified_sha`、`ci_status`；远端交付必须 CI_PASSED 且 SHA 一致；CI 失败/超时/不存在会暂停并生成审批，不进入 awaiting_acceptance；`acceptRun` 校验状态与 commit | `src/orchestrator.js` `finalizeRun/waitForCi/acceptRun`、`src/policy.js` `verificationState` | 单测 + 真实 GitHub Actions（W 项目任务，待执行记录） |
| P0-5 本地服务安全 | API Token 认证（启动生成 `data/api-token` 0600；浏览器 SameSite=Strict HttpOnly Cookie）；Host/Origin/Sec-Fetch-Site 校验；写操作限流；静态与 artifact realpath+symlink 越界防护；artifact 只允许 `artifacts/` 已登记产物、≤5MB、非二进制；测试命令 allowlist（防 planner/LLM 注入任意 shell） | `src/server.js`、`src/security.js`、`src/orchestrator.js` | `tests/server-security.test.js`（12 用例） |
| P0-6 预算与失败控制 | 全局/项目/运行/任务四级 token 与成本上限；墙钟上限；每项目单写运行锁；尝试上限；重复失败签名检测；费用来源记录（vendor/estimated/UNKNOWN，未知不显示为 0）；超限暂停可恢复 | `src/policy.js`、`src/orchestrator.js`、`src/db.js` | 单测 + 真实 A 任务预算中断/恢复证据 |

## 残余风险与 BLOCKED

1. **本机无法提供真正 OS 级沙箱**：`sandbox-exec` 在嵌套运行环境中不可用，DSH `workspace-write` 下 shell 工具被拒绝、文件写入可限制在工作副本；无法隔离文件系统/网络/宿主密钥读取。该能力标记 **BLOCKED（环境）**，不以 danger-full-access 绕过。
2. Claude 受限模式不再 bypass 权限；但 Claude CLI 自身仍能读其允许目录内的文件（受 cwd/工具白名单约束），无内核级隔离。
3. 本地 API 的 Cookie 认证适合单用户本机；若监听非回环地址必须由用户自行加反向代理/鉴权，工作台默认拒绝非本机 Host。
4. 真实子进程测试可能因测试自身调用 git/网络而受环境影响；工作台只保证不注入宿主凭据，不能保证第三方测试安全。
