# AI Workbench v2.2 验收矩阵

| 验收项 | 状态 | 证据 |
|---|---|---|
| v2.1 原有 186 项测试保留且通过 | PASS | `npm test` 198 全绿；原 186 未删除 |
| 新增功能真实回归测试 | PASS | container 6、model identity 6（共新增 12），测试用例真实执行 |
| Docker 容器测试执行实际可用 | PASS | `run_mwhwfr2v37fcbdab` 容器测试 exit=0；`isolation.backend=docker/network=none`；审计 PASS 100 |
| Docker 容器 Coding Agent 实际可用 | PASS | 同 run 由容器内 Claude Code 创建 hello.txt；commit 44995153 |
| 容器最小权限/禁止 privileged/docker.sock/宿主根 | PASS | 参数/挂载拒绝单测；容器内不可见宿主 /Users |
| 容器 Agent 网络最小授权 | UNKNOWN/PARTIAL | Agent 使用 bridge，未实现域名/IP egress allowlist；测试容器 network=none |
| Docker 不可用时 fail-closed | PASS | 单测/代码路径；本轮 daemon 可用未制造故障 |
| GLM 按实际供应商标识并豁免 | PASS | model-identity 4 类测试；Claude+GLM 端点→glm；未知→unknown 不豁免 |
| 非 GLM 预算未被削弱 | PASS | DeepSeek 2,927,688/3,000,000 上限；unknown 计入预算 |
| 真实 token/cache/费用完整记录且分 provider | PASS | /api/budget /api/usage/providers；GLM 2,519,937 tokens/¥14.35；DeepSeek ¥6.20；总 ¥20.54/30 |
| 连续三个不同真实开发任务 | PASS（结果）/ PARTIAL（自主性） | 3 commits；round1 Agent 自主，round2/3 因 agent 失败/预算由 Supervisor 修复后真实测试+审计 |
| SIGKILL 后恢复未完成任务 | PASS | 22:04:22 SIGKILL；loop interrupted→resume；round2 完成测试+审计 PASS 92 |
| 恢复后不重复轮次/commit | PASS | loop completion idempotency + history 仅 3 条；3 个唯一 commit |
| 无有效任务时停止 | PASS | loop_mwhx6pz3d6b1c474 queue 空→completed，无 run |
| 授权/能力阻塞时保存并停止 | PASS（能力阻塞）/ BLOCKED（A/B 授权） | loop_mwhx6t32acb5f0a9 paused；A/B 本轮禁止访问，无法测试其授权阻塞 |
| 任务完成必须测试+审计+commit+版本 | PASS | 循环只在 passed+LOCAL_VERIFIED/CI_PASSED 推进；UNKNOWN 拒绝 |
| Git checkout/分支更新失败不继续 | PASS | 代码校验 rev-parse + checkout 退出码，失败暂停；未制造真实失败环境（逻辑+单测路径） |
| 候选版本独立 DB/配置/端口，不访问 A/B | PASS | candidate 副本排除 data/projects/.env/.git；独立数据目录/端口；候选测试+实例+真实 E2E |
| 稳定控制器未被替换 | PASS | 候选流程只读验证，未替换运行进程 |
| Draft PR、不合并、不部署 | PASS（待最终 PR 编号） | 仅 draft PR；无 merge/deploy |
| A/B 代码/研发状态/工作区/进程保持不变 | PASS（基于操作记录） | 本轮未访问/操作 A/B；candidate 结构排除 projects/data；未读取 A/B 状态做二次证明 |
| 失败不被掩盖 | PASS | Agent 自主率 1/3、网络策略 UNKNOWN、DeepSeek 预算耗尽均如实记录 |
