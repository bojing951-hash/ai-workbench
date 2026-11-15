# 使用说明

## 0. 你的使用方式（最短路径）

> 打开工作台 → 添加项目 → 输入目标 → 启动自动开发 → 查看进度 → 最终验收

```bash
cd ai-dev-workbench
npm start
# 浏览器打开 http://127.0.0.1:4477
```

1. 首次使用先按 [CONFIG.md](CONFIG.md) 配置 `.env`（至少一个 Coding Agent 凭据 + 审计 Key + 规划 Key）。
2. 左侧「添加项目」：填 GitHub 仓库地址（如 `owner/repo`、`https://github.com/owner/repo.git`）或本机已有目录的绝对路径；填测试命令（留空会自动探测）。
3. 选中项目，在「目标」中写业务需求，在「验收标准」中逐行写可验证标准，选择：
   - **单任务**：一个 Coding Agent 完成整个目标；
   - **自动规划**：规划器读取 README/TASKS.md 后拆成多个任务，逐任务自动推进。
4. 点击「启动自动开发」。
5. 在运行详情中查看：任务流水线、每轮尝试、测试日志、diff、独立审计结论、失败修复反馈、token/成本、PR/CI。
6. 全部任务通过后运行进入「等待验收」，检查代码与 PR 后点击「验收」。**验收不会合并主分支**，合并需在 GitHub 人工操作。

## 1. 界面说明

| 区域 | 内容 |
|---|---|
| 顶栏 | 全局预算进度（tokens / ¥）、当前审计提供方（GPT 优先，未配置显示 GLM 降级）、Agent 在线状态、GitHub 状态、实时连接状态 |
| 左栏 | 项目列表、最新运行状态、添加项目 |
| 主区 | 目标输入/启动；运行详情；任务卡片（状态、尝试次数、Agent、审计分数、commit）；实时事件流 |
| 任务详情 | 验收标准逐条状态与证据、审计 findings 与修复要求、尝试记录、产物（prompt/diff/test/audit/commit） |
| 控制 | 暂停、恢复（含重试失败任务）、取消、验收、刷新 CI 状态 |

状态颜色：绿色=通过，蓝色=进行中，黄色=暂停/阻塞，红色=失败，青色=等待验收。

## 2. CLI（可选）

```bash
node bin/workbench.js agents                 # 查看 Agent 可用性 / 审计提供方
node bin/workbench.js status                 # 预算、项目、最近运行
node bin/workbench.js project add --name demo --repo /path/to/repo --test "npm test" --protect "tests/**,package.json"
node bin/workbench.js run --project <id> --goal "实现 X" --acceptance "a,b" --mode plan
node bin/workbench.js resume <runId> --retry-failed
node bin/workbench.js accept <runId>
node bin/workbench.js events <runId>
```

## 3. 添加项目时的注意事项

- **GitHub 私有仓库**：配置 `GITHUB_TOKEN`，工作台通过 Token 克隆/推送。公开仓库可不配 Token（仅本地开发）。
- **本地目录**：若不是 Git 仓库，工作台会自动 `git init` 并建立基线提交；已有未提交改动会作为基线提交。
- **测试命令**：必须能在项目根目录执行并通过；工作台以测试退出码作为质量门禁的一部分。
- **保护路径**：建议勾选「保护测试目录」；还可把 `package.json`、`.github/**` 等加入保护，Agent 修改会被还原并记录违规。
- 项目加入后，工作台会为每次运行创建独立计划分支与任务 worktree，不会污染你的当前工作区/main 分支。

## 4. 验收标准怎么写

好的验收标准是**第三方可独立验证的客观事实**：

- ✅ `GET /health 返回 200，JSON 为 {"status":"ok"}`
- ✅ `new TaskStore(path) 持久化后重新加载，任务与完成状态保持`
- ✅ `README 新增 "## API" 章节，逐条说明四个方法参数与返回值`
- ❌ `代码质量好`、`功能正常`、`性能优秀`（不可验证）

如需防止 Coding Agent "照着验收标准过拟合"，可将个别验收标准写成 `[hidden] ...`：它对 Coding Agent 隐藏，独立审计仍会核对；失败后修复反馈会揭示未满足项，从而触发自动修复。该机制用于演示"审计发现真实缺失 → 自动修复"闭环，也可用于真实项目。

## 5. 暂停 / 中断 / 恢复

- **暂停**：当前 Agent 调用会被取消，运行状态 `paused`；恢复时可选择「重试失败任务」。
- **进程崩溃/重启**：启动时自动把中断运行标记为 `interrupted`，计划分支与已通过任务保留；点击「恢复运行」或 `workbench resume <runId>` 后，中间态任务会重建 worktree 并继续。
- **预算耗尽**：运行自动 `paused`，在 `.env` 调高预算或缩短范围后恢复；不会超预算继续调用。

## 6. Git / PR / CI

- 每次运行产生计划分支 `wb/plan-*`，每个任务产生提交（含验收与审计信息）。
- 全部任务通过后，若配置了 `GITHUB_TOKEN`：
  - 本地项目可自动创建私有仓库（`GITHUB_AUTO_CREATE_REPO=true`）；
  - 推送计划分支，创建**草稿 PR**（不合并）；
  - 轮询该提交的 GitHub Actions 结果并在界面展示。
- 项目配置 `publish:false` 时只本地完成（用于不希望推远端的项目）。

## 7. 三阶段演示

```bash
npm start                # 终端 A
npm run demo:phase1      # 阶段一：单项目 + 审计失败自动修复

# 阶段二会主动 SIGKILL 并重启工作台进程，需先停止终端 A 的服务：
npm run demo:phase2
npm start                # 阶段二结束，重新启动

npm run demo:phase3      # 阶段三：多项目并行 + 跨 Agent + GitHub PR/CI
```

每个脚本都会输出逐步事件、最终摘要，并把证据写入 `demo/evidence/`。

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| 启动报错 `EADDRINUSE` | 端口被占用：`WORKBENCH_PORT=4478 npm start`，或停止旧进程 |
| Agent 不可用 | 运行 `node bin/workbench.js agents` 检查 CLI 路径与 Key；DSH 需 `DEEPSEEK_API_KEY` |
| DSH 提示 sandbox 不可用 | 在嵌套沙箱/受限环境把 `DSH_PERMISSION_MODE=danger-full-access`（工作台仍限定工作副本与预算） |
| 审计报"没有可用的独立审计模型" | 配置 `OPENAI_API_KEY`（GPT）或 `GLM_API_KEY`（GLM） |
| 任务一直 paused | 看运行 `stop_reason` 与事件流：常见原因为测试命令缺失、预算耗尽、审计不可用、Agent 未产生变更 |
| GitHub 推送/PR 显示"待授权" | 配置 `GITHUB_TOKEN` 后重试；工作台不会伪造成功 |
| 想查看某次产物 | 任务详情中点击产物，或 `GET /api/artifacts?path=...`；文件在 `data/artifacts/<runId>/` |
