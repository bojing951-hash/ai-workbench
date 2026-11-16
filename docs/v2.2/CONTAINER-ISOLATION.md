# 容器执行隔离验证（v2.2）

## 镜像

`docker/runtime.Dockerfile` → `ai-workbench-runtime:2.2`
- Node 24 + git + Claude Code 2.1.104
- 非 root 用户；无凭据烘焙进镜像
- 镜像 ID：`sha256:41725418634a86cc2d6018793233aa42143ffcdad08bd8e4e4ec4b6229e64e5d`

## 安全参数（代码 `src/container.js`）

`--rm --network none(test) --cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp --tmpfs /run --pids-limit --memory --cpus --user hostUid:hostGid`
挂载仅 `worktree:/workspace:rw`；Agent 额外 `claudeConfig:/config:rw`；**无宿主根/HOME/docker.sock**；密钥使用 0600 env-file 而非 `-e` 暴露。

## 真实验证

- 运行 `run_mwhwfr2v37fcbdab`（临时 W 项目 `proj_mwhw9bbk5724f714`）：
  - 容器内 Claude Code 创建 hello.txt；
  - 容器内测试读取并校验 hello.txt，exit=0；
  - 审计证据含 `isolation.backend=docker`、`network=none`；
  - 独立审计 DeepSeek **PASS 100**；commit `44995153`。
- `tests/container.test.js`：真实容器执行 `node -e`；容器内无法看到宿主 `/Users`、`/Applications`；拒绝挂载 `/`、`$HOME`、docker.sock；Docker/镜像缺失 fail-closed。

## 限制（不冒充）

- Agent 容器使用 bridge 网络访问模型端点；**未实现 egress allowlist**，网络最小授权为 UNKNOWN/PARTIAL。
- DSH 无法在容器运行；要求容器 Agent 且 Agent=DSH 时阻塞。
