# v2.4 验收矩阵

| 验收项 | 状态 | 证据 |
|---|---|---|
| 独立 Supervisor 进程守护 | PASS | `supervisor/workbench-supervisor.mjs` + launchd/systemd；真实启动 |
| Workbench SIGKILL 自动拉起 | PASS | 16:00:47Z SIGKILL → 16:00:52Z 重启 → 16:00:58Z 恢复 |
| 崩溃后自动续跑受管任务（无人 restart/resume/改码） | PASS | run/loop resumed；任务测试+审计+commit 完成 |
| 健康无响应检测/恢复 | PASS | SIGSTOP 16:05:26Z → 3 次失败 → 自动重启 → 16:05:54Z 恢复 |
| 有界重启/退避/熔断 | PASS | 指数退避、重启窗口上限、circuitOpen 状态；重复重启竞态已修复 |
| 崩溃/重启/恢复记录 | PASS | `data/supervisor/state.json`、supervisor.log |
| 持久化写租约/单写所有权 | PASS | SQLite 租约 + 测试 |
| 恢复前 DB/Git/审计对账 | PASS | reconcileInterruptedRun + 测试；对账失败拒绝续跑 |
| 原子/幂等任务恢复、不重复 commit | PASS | v2.3 loop 幂等 + 唯一 commit；v2.4 测试 |
| Agent 无进展检测（事件 + worktree，不只文件） | PASS | watchdog + 事件进度测试 + SIGSTOP 实测 |
| 失败分类/有界重试/备选 Agent/新会话 | PASS | failure_class、候选过滤、主 Agent 新会话；v2.3 实测 |
| Provider-aware 审计资源预检 | PASS | 编码前阻塞；无独立审计不 PASS；测试 |
| GLM 授权豁免，非 GLM 预算不削弱 | PASS | 真实身份分账；深剩余 9,869；未提升授权 |
| 24 小时无人监督验收 | **NOT VERIFIED / BLOCKED** | 预冻结项目 `proj_mwi146ob721765e6`/loop `loop_mwi146ofabcdd6a2` 已启动；任务1编码前因审计预算 9869<8000+2000 暂停；未执行 24h，标记 `24H_AUTONOMY_NOT_VERIFIED` |
| 24h 内 Agent 自主完成率（加速验收） | PASS（5/5，100%） | v2.3 证据；非 24h |
| 人工代码干预 | PASS（0 次加速验收） | v2.3 证据；v2.4 supervisor 任务无人工代码 |
| Docker 执行安全 | PASS（v2.2 证据）/ UNKNOWN egress | 容器测试/Agent 真实运行；egress 未实现 |
| v2.3 原测试保留 | PASS | 206/206，186 原测试全保留 |
| Draft PR/不合并/不部署 | PASS | PR #6 draft；无 merge/deploy |
| A/B 零干扰 | PASS（操作层面） | 无 A/B 项目级请求/进程/文件/分支/推送 |
