# AI 开发工作台 — HTTP API 契约（前端使用）

所有接口返回 JSON：`{ ok: true, data }` 或 `{ ok: false, error: { code, message, details } }`。
服务地址默认 `http://127.0.0.1:4477`。

## 认证（v2）

- 除 `GET /api/health` 外，所有 `/api/*` 请求需要认证：
  - 浏览器：首次加载 `/` 时服务器写入 `HttpOnly; SameSite=Strict` 的 `wb_token` Cookie，同源 fetch / EventSource 自动携带；
  - 脚本/CLI：读取 `data/api-token`（0600）并通过 `x-workbench-token` 或 `Authorization: Bearer <token>` 发送。
- 所有写请求还校验 Host / Origin / Sec-Fetch-Site，并有限流。


## 状态

- `GET /api/state` → 聚合状态
  ```
  {
    version, server: {startedAt, uptimeSec},
    budget: {maxTokens, usedTokens, maxCostCny, usedCostCny, remainingTokens, remainingCostCny, tokensPercent, costPercent, breakdown},
    audit: {preferred, active:{name,label,model}|null, gptConfigured, glmConfigured, deepseekConfigured, note},
    agents: [{id,label,ok,detail,capabilities}],
    projects: [{id,name,description,repo_url,local_path,default_branch,test_command,language,agent_kind,audit_provider,protected_paths,status,created_at,latestRun,runs}],
    runs: [...],
    tasks: [...],
    taskStatusCounts, activeRunIds, agentSlots, usage,
    approvals: [{id,type,status,title,details_json,created_at}],
    verification: {ciRequiredByDefault, note},
    github: {configured, owner, autoCreateRepo, note},
    policy: {neverMerge, autoPush, protectedPaths, maxAttempts, allowUnsafeAgentPermissions}
  }
  ```
- `GET /api/health` → `{ok, version}`

## 项目

- `GET /api/projects` → 项目数组
- `POST /api/projects` body:
  `{name, repo, testCommand?, protectedPaths?: string[], protectTests?: boolean, agentKind?: "auto"|"dsh"|"claude", auditProvider?: "auto"|"openai"|"glm"|"deepseek", description?, defaultBranch?,
    contractFiles?: string[], allowLocalAcceptance?: boolean, ciRequired?: boolean, remotePushAuthorized?: boolean,
    allowedTestCommands?: string[]|string, testEnvAllowlist?: string[], agentPermission?: string,
    budget?: {max_tokens_per_run?, max_cost_cny_per_run?, max_tokens_per_task?, max_attempts?, max_wall_clock_ms?}, publish?: boolean}`
  - `repo`：GitHub URL / `owner/repo` / 本地路径
- `GET /api/projects/:id` → 项目 + `runs` + `plans`
- `PATCH /api/projects/:id` → 更新字段

## 运行

- `POST /api/projects/:id/runs` body:
  `{goal, acceptance?: string[]|string, mode?: "single"|"plan", tasks?: [{title,description,acceptance,agent?,testCommand?}]}`
  → `{runId, planId, tasks, projectId}`
- `GET /api/runs` / `GET /api/runs/:id`
  - run 详情含 `tasks[]`（含 audits、attempts、artifacts）、`events[]`、`actions[]`、`result_json`
- `GET /api/runs/:id/events?after=0` → 事件数组
- `POST /api/runs/:id/pause` body `{reason?}`
- `POST /api/runs/:id/resume` body `{retryFailed?: boolean}`
- `POST /api/runs/:id/cancel`
- `POST /api/runs/:id/accept` body `{confirmLocalOnly?: boolean}`（人工验收，不合并；远端交付要求 `verification_status=CI_PASSED` 且绑定 `verified_sha`；本地交付需显式 confirmLocalOnly 且项目允许）
- `POST /api/runs/:id/ci-refresh`（刷新 GitHub Actions 状态）
- run 详情新增：`verification_status`（LOCAL_VERIFIED/CI_PENDING/CI_PASSED/CI_FAILED）、`verified_sha`、`ci_status`、`ci_url`、`approvals[]`

## Provider 用量（v2.1）

- `GET /api/usage/providers` → `{ok:true,data:{byProvider,glm,nonGlm,budget,note}}`（只读，沿用 `/api/*` Token/Cookie 认证）
  - 路由实现位置：`src/server.js` 中 `pathname === '/api/usage/providers'` 分支；该分支把 `orchestrator.budget()` 的快照
    **显式归一化**为下列字段，因此字段形状可直接与源码逐项核对。
  - `byProvider`：按 provider 聚合的原始用量明细，键为 provider 名（如 `glm`、`deepseek`、`openai`、`unknown`），
    每项固定为 `{tokensIn,tokensOut,tokensCache,tokens,costCny}`；`tokens = tokensIn + tokensOut + tokensCache`，不做预算折算。
  - `glm`：GLM 的 `{tokensIn,tokensOut,tokensCache,tokens,costCny}` 单列；无 GLM 调用时返回同结构的零值对象。
    GLM 调用不受工作台内部 token/费用上限（用户授权），但真实 tokens/cache/cost 完整记录；不会被计入 `nonGlm`。
  - `nonGlm`：剔除预算豁免 provider（`exemptProviders`，默认仅 `glm`）后，其余 provider 的
    `{tokensIn,tokensOut,tokensCache,tokens,costCny,names}` 汇总；`names` 列出被汇总的 provider（不含 `glm`），仍受原预算约束。
  - `budget`：约束口径的用量与余量：
    `{maxTokens,usedTokens,remainingTokens,maxCostCny,usedCostCny,remainingCostCny,cacheTokenWeight,tokensPercent,costPercent}`。
    路由遍历 `byProvider`，**跳过 `exemptProviders`（默认 `glm`）**后按
    `tokensIn + tokensOut + tokensCache × cacheTokenWeight` 汇总 `usedTokens`（四舍五入为整数；
    `remainingTokens` 与百分比按未取整的加权用量计算），
    `usedCostCny` 为同一批 provider 的 `costCny` 之和（保留 4 位小数）；`remainingTokens` / `remainingCostCny`
    分别为 `maxTokens` / `maxCostCny` 减去对应用量并下限截断为 0；`tokensPercent` / `costPercent`
    为用量占上限的百分比（保留 1 位小数，上限截断为 100；上限为 0 时记 0）。
  - `note`：固定口径说明字符串，内容为「GLM 用量完整记录并在 glm 单列，不受工作台内部 token/费用上限约束；
    nonGlm 汇总其余非豁免 provider，budget 为其预算约束口径的用量与余量（缓存 token 按 cacheTokenWeight 折算）；
    byProvider 为各 provider 的原始 tokens/cost 明细。」
  - 响应示例（默认预算配置 `maxTokens=3000000`、`maxCostCny=30`，含一次 GLM 调用与一次 DeepSeek 调用）：
    ```json
    {
      "ok": true,
      "data": {
        "byProvider": {
          "glm": { "tokensIn": 100, "tokensOut": 50, "tokensCache": 1000, "tokens": 1150, "costCny": 1.5 },
          "deepseek": { "tokensIn": 100, "tokensOut": 50, "tokensCache": 1000, "tokens": 1150, "costCny": 0.1 }
        },
        "glm": { "tokensIn": 100, "tokensOut": 50, "tokensCache": 1000, "tokens": 1150, "costCny": 1.5 },
        "nonGlm": { "tokensIn": 100, "tokensOut": 50, "tokensCache": 1000, "tokens": 1150, "costCny": 0.1, "names": ["deepseek"] },
        "budget": {
          "maxTokens": 3000000,
          "usedTokens": 250,
          "remainingTokens": 2999750,
          "maxCostCny": 30,
          "usedCostCny": 0.1,
          "remainingCostCny": 29.9,
          "cacheTokenWeight": 0.1,
          "tokensPercent": 0,
          "costPercent": 0.3
        },
        "note": "GLM 用量完整记录并在 glm 单列，不受工作台内部 token/费用上限约束；nonGlm 汇总其余非豁免 provider，budget 为其预算约束口径的用量与余量（缓存 token 按 cacheTokenWeight 折算）；byProvider 为各 provider 的原始 tokens/cost 明细。"
      }
    }
    ```

## 研发循环（v2.1）

- `GET /api/loops?projectId=` → 循环列表（status/round/maxRounds/history/stopReason）
- `POST /api/projects/:id/loops` body `{goal,maxRounds,mode:"plan"|"queue",queue?,contractFiles?}` → 创建并启动循环
- `GET /api/loops/:id`、`POST /api/loops/:id/pause|resume|cancel`
- `GET /api/state` 新增 `loops` 字段。
- 循环每轮使用单任务 run；通过内部验证后自动进入下一轮；无真实任务/达到上限/失败/授权阻塞时停止，不制造任务。

## 执行能力（v2.2）

- `GET /api/executor` → `{ok:true,data:{isolation,container,fallback,note}}`（只读，沿用 `/api/*` Token/Cookie 认证）
  - 路由实现位置：`src/server.js` 中 `pathname === '/api/executor'` 分支；该分支**复用 `/api/isolation` 的同一套能力探测**
    （`detectIsolationCapabilities()` 缓存快照 + `containerCapabilities(config)`），不新增依赖，并把响应**显式归一化**为下列字段，
    因此字段形状可直接与源码逐项核对。
  - `isolation`：宿主隔离能力快照：
    `{platform, kernelIsolation, kernelAvailable, docker:{available,engine,version,reason}, sandboxExec:{available,engine,reason}, restrictedRuntime, note}`。
    `kernelIsolation` 为 `docker | sandbox-exec | BLOCKED`；`kernelAvailable` 表示是否有内核级隔离；
    `restrictedRuntime` 为受限独立运行环境的 `{available, controls[], limitations[]}`（无内核级隔离时的实际执行环境）。
  - `container`：Docker 容器执行可用性：
    `{testExecution, agentExecution, docker:{available,version,reason}, image:{name,available,id,reason}, agentBackends, network:{test,agent}, security[], note}`。
    - `testExecution`（布尔）：容器内执行测试命令可用（Docker daemon 与运行时镜像 `ai-workbench-runtime:2.2` 齐备）；
      项目配置 `test_isolation=docker` 时以此为门禁，不可用则 fail-closed 阻塞。
    - `agentExecution`（布尔）：容器内执行 Claude Code Agent 可用（同一 Docker/镜像条件）；项目配置 `agent_isolation=docker` 时
      以此为门禁，不可用则 fail-closed 阻塞（仅 Claude 支持容器执行，见 `agentBackends`）。
    - `network`：测试容器默认 `none`（无网络），Agent 容器默认 `bridge`（模型端点需要网络）。
    - `security`：容器安全边界清单（`--cap-drop ALL`、只读 rootfs、最小挂载、非 root、资源限制等）。
  - `fallback`：容器不可用或项目未要求容器时的执行方式 `{mode:"restricted", available:true, note}`——宿主受限独立运行环境
    （独立 HOME/TMPDIR、最小环境变量）；项目显式要求 docker 隔离时不降级、直接阻塞。
  - `note`：固定口径说明字符串。
  - 响应示例（Docker daemon 与镜像均可用）：
    ```json
    {
      "ok": true,
      "data": {
        "isolation": {
          "platform": "darwin",
          "kernelIsolation": "docker",
          "kernelAvailable": true,
          "docker": { "available": true, "engine": "docker", "version": "28.3.0", "reason": "" },
          "sandboxExec": { "available": false, "engine": "sandbox-exec", "reason": "嵌套沙箱中被拒绝" },
          "restrictedRuntime": { "available": true, "controls": ["..."], "limitations": ["..."] },
          "note": "检测到 Docker daemon，可在配置允许时使用容器执行"
        },
        "container": {
          "testExecution": true,
          "agentExecution": true,
          "docker": { "available": true, "version": "28.3.0", "reason": "" },
          "image": { "name": "ai-workbench-runtime:2.2", "available": true, "id": "sha256:…", "reason": "" },
          "agentBackends": ["claude"],
          "network": { "test": "none", "agent": "bridge" },
          "security": ["--network none(test)", "--cap-drop ALL", "…"],
          "note": "Docker 容器执行可用（测试/Claude Agent）"
        },
        "fallback": { "mode": "restricted", "available": true, "note": "容器执行不可用或项目未要求容器时，…" },
        "note": "GET /api/executor 汇报执行能力：…"
      }
    }
    ```

## 审批中心

- `GET /api/approvals?status=pending|all` → 待人工审批项（CI 闸门、远端推送等）
- `POST /api/approvals/:id/approve` / `reject` body `{decidedBy?}` → 记录人工决定；**不会自动合并/部署**


## 任务 / 产物

- `GET /api/tasks/:id` → 任务详情：`attempts[]`（含 prompt）、`audits[]`、`artifacts[]`（含 content）
- `GET /api/artifacts?path=<相对 data 目录>` → 文本内容

## 事件流

- `GET /api/stream` → SSE。事件格式：
  ```
  id: 123
  data: {"id":123,"runId":"run_x","taskId":"","type":"task_passed","level":"info","message":"...","data":{...},"createdAt":"..."}
  ```
  事件类型包括：`run_created/run_started/run_paused/run_resumed/run_awaiting_acceptance/run_accepted/run_cancelled/run_error/ci_gate_blocked/approval_decided`、
  `task_started/worktree_ready/agent_started/agent_progress/agent_finished/agent_failed/no_changes/protected_path_violation`、
  `test_started/test_passed/test_failed/audit_started/audit_passed/audit_failed/repair_requested/task_passed/task_failed/task_requeued`、
  `branch_pushed/pr_created/ci_update/publish_blocked/project_created`。

## 配置

- `GET /api/config` → `{version, budget, agents, github, policy}`
- `GET /api/agents` → Agent 可用性
- `GET /api/budget` → 预算

## 运行状态枚举

run.status：`queued | running | paused | interrupted | awaiting_acceptance | accepted | failed | cancelled`
task.status：`queued | preparing | coding | testing | auditing | repairing | committing | passed | failed | blocked`
