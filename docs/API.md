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
- `GET /api/health` → `{ok, version, verification}`
  - `verification: {ciRequiredByDefault: true, note}` — 与 `/api/state` 中的 verification 同义：默认要求远端 CI 通过才可验收（`ciRequiredByDefault`），`note` 为验收策略说明字符串。

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
