# 贡献指南

欢迎提交 Issue 与 Pull Request。本项目目标是保持**零运行时依赖**、可审计、可恢复、对用户安全边界诚实。

## 开发环境

```bash
# Node.js >= 24、Git；macOS / Linux（Windows 未验证）
git clone <repo-url> ai-dev-workbench
cd ai-dev-workbench
cp .env.example .env       # 至少配置一个 Coding Agent + 一个审计模型
npm test                   # 84 个离线用例，不需要任何 API Key
npm start                  # 打开 http://127.0.0.1:4477
```

## 原则

1. **零运行时依赖**：只用 Node 内置模块（`node:sqlite`、`node:http`、`fetch` 等）。不引入 npm 运行时依赖；
   如需加依赖请先在 Issue 中说明理由。
2. **不伪造结果**：任何测试/审计/CI 失败都必须如实记录；不允许为了让流程通过而跳过验证、放宽验收或降级为假成功。
3. **不修改 Harness 核心**：DSH 通过 CLI 子进程集成；不要修改 DeepSeek Harness 安装目录。
4. **保持可恢复性**：状态迁移必须持久化、可重入；新增步骤要考虑进程崩溃后的恢复语义。
5. **安全默认值**：默认监听 127.0.0.1；密钥不进入日志/事件/前端；不添加自动合并主分支的能力。
6. **中文界面与文档为主**，代码注释可用中文或英文。

## 目录

| 目录 | 说明 |
|---|---|
| `src/orchestrator.js` | 统一编排器（状态机/修复循环/发布/恢复） |
| `src/agents/` | Coding Agent 适配器（dsh / claude / custom） |
| `src/auditors/` | 独立审计器（GPT / GLM + 结论硬校验） |
| `src/` | 数据库、策略、Git/GitHub、LLM、HTTP 服务 |
| `web/` | 零依赖可视化 SPA |
| `tests/` | 离线单元 + 编排器集成测试 |
| `demo/` | 三阶段真实验收项目与证据 |
| `scripts/` | 演示、证据收集、截图脚本 |

## 修改流程

1. Fork + 新建分支（`feat/...` / `fix/...`）；
2. 修改源代码，补测试（新逻辑应有回归用例）；
3. `npm test` 全绿；
4. 涉及真实 Agent/审计逻辑的改动，建议小预算跑一次 `demo/` 中的验收项目（会消耗真实 token，请在 PR 描述中说明是否执行）；
5. PR 描述里写清：变更点、测试结果、是否涉及安全边界/预算/权限、是否需要迁移数据。

## PR 检查清单

- [ ] `npm test` 通过（84+ 用例）
- [ ] 没有提交 `.env`、`data/`、`projects/`、密钥、个人绝对路径
- [ ] 新增的失败路径不会伪造成功（审计/测试/CI 失败必须阻塞）
- [ ] 未引入自动合并主分支、自动付款、生产环境操作
- [ ] 文档（README/docs）与行为一致

## 安全漏洞

请勿在公开 Issue 中披露可利用细节，按 [SECURITY.md](SECURITY.md) 私下报告。
