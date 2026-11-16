# 独立 Supervisor（v2.4）

Supervisor 不依赖正在被守护的 Workbench 进程：它启动 Workbench、做 `/api/health` 健康检查、检测进程退出/无响应、指数退避重启（熔断上限）、记录崩溃，并在健康恢复后调用受管项目的 `POST /api/supervisor/recover` 完成对账与续跑。只有项目配置 `supervisor_managed=true` 的项目会被自动恢复；A/B 不会被触碰。

## 运行

```bash
node supervisor/workbench-supervisor.mjs --root "$PWD" --port 4477
node supervisor/workbench-supervisor.mjs --root "$PWD" --status
```

状态/日志：`data/supervisor/state.json`、`data/supervisor/supervisor.log`、`data/supervisor/workbench.log`。

## macOS launchd（独立于 Workbench）

```bash
ROOT="$PWD"
sed "s#__ROOT__#$ROOT#g" supervisor/com.aiworkbench.supervisor.plist > ~/Library/LaunchAgents/com.aiworkbench.supervisor.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aiworkbench.supervisor.plist
launchctl kickstart -k gui/$(id -u)/com.aiworkbench.supervisor
```

卸载：`launchctl bootout gui/$(id -u)/com.aiworkbench.supervisor`

## Linux systemd

```bash
sudo sed "s#__ROOT__#$PWD#g" supervisor/ai-workbench-supervisor.service > /etc/systemd/system/ai-workbench-supervisor.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-workbench-supervisor
```

## 恢复协议

1. Supervisor 启动/重启 Workbench。
2. 健康检查通过后调用 `POST /api/supervisor/recover`。
3. Workbench 仅在 `supervisor_managed=true` 项目中：
   - 对账 passed 任务 → PASS 审计 → 计划分支 commit 祖先关系；
   - 仅恢复 `interrupted` 的 run/loop；paused/failed/audit-resource-blocked 不自动续跑；
   - 记录 `run_reconciled` / `run_reconciliation_failed`。
4. 恢复失败保留状态，不盲目执行下一任务。

## 限制

- 进程守护自身若被 SIGKILL，需要 launchd/systemd（或另行运行）重新拉起；普通后台运行需要宿主进程管理器。
- 24h 验收只有在真实 24h 窗口完成后才算通过；本仓库不预生成未来结果。
