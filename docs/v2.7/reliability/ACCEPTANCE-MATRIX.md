# v2.7 可靠性整改验收矩阵

| 要求 | 状态 | 证据 |
|---|---|---|
| P0 质量命令不继承宿主环境 | **PASS** | `tests/quality-execution.test.js` LEAK_SECRET 不泄漏 |
| P0 质量命令不泄露 API Key/GitHub Token | **PASS** | 使用 `buildTestEnv`，仅显式 `env_allowlist`；代码/测试 |
| P0 质量命令受控执行/文件网络隔离 | **BLOCKED** | macOS sandbox-exec 在宿主 EPERM；已显式 env-only fallback；不能宣称 FS/network 强制隔离 |
| P0 正常质量检查仍 PASS | **PASS** | `v2.7-postfix-quality-run.json` hidden 4/4 |
| P0 安全阻塞不误判产品缺陷 | **PASS** | commandFailed/hypothesis 分类；quality 测试 |
| P1-A plan 模式生成修复任务 | **PASS（代码级）** | `tests/quality-plan-mode.test.js` |
| P1-A plan 模式真实 Agent→测试→审计→PASS E2E | **UNKNOWN/BLOCKED** | 新一轮 DSH 预算未授权；未执行 |
| P1-A queue 模式真实质量修复 | **PASS（历史）** | Reading Queue v2.7 真实 E2E：隐藏缺陷→修复→DSH PASS 90→4/4 |
| P1-B 非零退出/超时/无效 JSON/部分缺失分类 | **PASS** | `tests/quality-execution.test.js`；NONZERO_EXIT/TIMEOUT/INVALID_JSON |
| P1-C 异步质量检查不阻塞事件循环 | **PASS（单元）** | quality-execution async ticks 测试 |
| P1-C 长检查期间真实 HTTP health/Supervisor 不误杀 | **UNKNOWN** | 未单独压测 |
| P1-D 双完整 HTTP 服务只一个创建 run | **PASS** | `tests/fencing-http.test.js`（agent=custom，无外部模型依赖） |
| P1-D 非 owner 控制写拒绝 | **PASS（确定性单元）** | `tests/control-lease.test.js`：pause/cancel/resume 均 PROJECT_LEASE_HELD |
| P1-D 旧 owner 失租约不能续写 | **PASS（store）** | `tests/fencing.test.js` |
| P1-D 活跃任务 SIGKILL→Supervisor 重启→恢复 | **PASS（修复后）** | `fault-injection-after-fix.log` resumed:true；修复前 `fault-injection-before-fix.log` resumed:false 作为失败证据 |
| P1-D 所有 Git/质量写路径完整 fencing | **UNKNOWN** | 未穷举 |
| P1-E 需求条款级证据 | **PASS（补充追踪）** | `reading-queue-clause-coverage.json` 8/8 clause |
| P1-E 证据文件状态/时间/成本/SHA 一致 | **PASS** | `tests/evidence-consistency.test.js` |
| P1-E 原始验收契约未被降低 | **PASS** | 未修改 CONTRACT/可见测试/隐藏规则 |
| 独立只读审查（两轮） | **PASS** | 首轮 4 P1 → 全整改；复审无剩余 P0/P1 |
| 真实新 E2E（修复后） | **BLOCKED** | 无新 DSH ¥30 授权；不挪旧项目预算 |
| 24 小时连续研发 | **NOT_VERIFIED** | 未执行真实 24h 窗口 |
