# AI Workbench v2.2 隔离执行镜像：Node + git + Claude Code（Coding Agent 可运行）
FROM node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.104 \
 && npm cache clean --force

ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    NODE_ENV=production

# 以非 root 用户运行；任务目录由宿主 --user 映射
RUN useradd -m -u 10001 workbench
USER workbench
WORKDIR /workspace
