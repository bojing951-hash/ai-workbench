# 自我升级机制（Self-Upgrade, P3）

## 问题

运行中的控制进程不能直接加载自己刚改过的代码继续执行——否则未经验证的候选版本会立刻接管稳定版本，失败时无法回退。

## 机制

稳定版本保持运行；升级走独立候选流程：

```
v2.0.0 源码（候选分支）
   │
   ├─ src/upgrade.js createCandidate()
   │    复制候选目录（排除 .env / data / projects / .git / node_modules / docs/images / demo/evidence）
   ├─ verifyCandidate()
   │    1) 候选目录内运行完整离线测试（node --test tests/*.test.js）
   │    2) 随机空闲端口 + 独立 WORKBENCH_DATA_DIR 启动候选实例
   │    3) 健康检查 /api/health + 认证后的 /api/state、/api/agents 冒烟
   ├─ （可选）--real-e2e
   │    在候选实例上创建一个真实 demo 项目，跑 DSH 真实任务
   │    编码 → 测试 → 独立审计 → 等待验收（消耗真实 token，显式开关）
   └─ 证据写入 demo/evidence/upgrade-*.json
        稳定实例全程不受影响；失败不替换、不推送
```

通过候选验证后才允许把候选分支推送并创建升级 PR；合并/部署必须人工完成。
当前脚本 `scripts/self-upgrade.mjs` **不会**自动替换稳定进程、不会合并主分支。

## 真实执行记录

- 候选目录：`data/candidates/cand_mwhoh8p2_nv5a`（由 v2.0.0 分支生成）
- 离线测试：**PASS**（180 项，约 4.5s）
- 隔离候选实例：**PASS**（端口 65335，独立数据目录，`/api/health` + 认证 `/api/state` 通过）
- 证据：`demo/evidence/upgrade-1794737689980.json`
- 稳定工作台实例（4477）在候选验证期间持续可用，未替换。

## 升级 PR

候选分支 `v2.0.0` 提交后，由维护者显式推送并创建 draft PR；本仓库工作台侧的 GitHub 任务也可生成 PR，但始终 draft、不合并。
