# 开源发布检查清单

把本工作台公开到 GitHub 前的操作清单。当前仓库已经完成大部分基础加固，仍建议逐项确认。

## 1. 许可证

- 仓库已附带 **Apache-2.0** `LICENSE` 与 `NOTICE`（版权人：bojing951-hash）。
- Apache-2.0 已包含专利授权、NOTICE 署名与商标保留条款；如需更强的"衍生必须开源"，可改 AGPL-3.0。
- 在 README 增加许可证说明（已包含）。

## 2. 敏感信息（最重要）

```bash
# 工作区扫描
git grep -nE "ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|95e3b2|sk-a7daf" || echo "clean"
# 全历史扫描（防止旧提交泄露）
git rev-list --all | while read c; do git grep -nE "ghp_|github_pat_|sk-[A-Za-z0-9]{20,}" "$c" -- . 2>/dev/null; done
# 确认 .env / data / projects 从未被提交
git log --all --oneline -- .env data projects
```

- `.env`、`data/`、`projects/` 已在 `.gitignore` 中；检查后如发现历史泄露，使用 `git filter-repo` 清理并**轮换密钥**。
- 证据 JSON 中的本机绝对路径已替换为 `<workbench-root>`；截图会在发布前做路径脱敏（见下）。
- `demo/evidence/` 中保留了真实运行的 GitHub PR 链接（维护者私有演示仓库）。如需完全匿名，可把
  `<github-owner>` 替换为占位符，或在 README/测试报告中注明链接不可公开访问。

## 3. 截图与演示数据

- 截图保存于 `docs/images/`，由 `scripts/screenshot.mjs` 通过 Chrome CDP 抓取；脚本默认把本机绝对路径替换为 `~/ai-workbench`。
- 截图中的项目/任务/审计数据来自真实运行，不含模型 Key、GitHub Token、数据库敏感字段。
- 如需重新生成：`npm start` 后用 `node scripts/screenshot.mjs <url> <out.png>`。

## 3.1 仓库名限制（重要）

GitHub 仓库名只允许 ASCII 字母、数字、`.`、`-`、`_`；中文会被自动替换为连字符，因此**不能**直接把仓库名设为
「AI全自动工作台」。推荐用 ASCII slug（例如 `ai-full-auto-workbench`），在仓库 **About/description** 与 README 标题中
展示中文名「AI 全自动工作台」。GitHub 的仓库所有者、README、About 与提交记录共同构成项目归属标识。

## 3.2 许可证选择（保护强度）

| 许可证 | 允许闭源商用 | 衍生必须开源 | 专利授权 | 署名要求 | 适用目标 |
|---|---|---|---|---|---|
| MIT | 是 | 否 | 无明确条款 | 保留版权与许可声明 | 最大采用率 |
| Apache-2.0 | 是 | 否 | 有明确专利授权 | 保留 LICENSE + NOTICE | 署名、专利保护、商业友好 |
| AGPL-3.0 | 否（网络服务也必须开源） | 是 | 有 | 保留声明与源码 | 防止被闭源产品拿走 |

> 开源代码本身是可见的，许可证不能阻止他人阅读、学习或 fork；只能约束合法使用方式（署名、开源义务、专利）。
> 品牌/名称保护需另行注册商标与 ™ 声明；Apache-2.0 明确不授予商标权。

## 4. 仓库元信息

建议 GitHub 仓库设置：

- 名称：`ai-workbench`（短名；中文展示名写在 About 与 README）
- About：`AI 全自动软件开发工作台：多项目/多 Coding Agent/独立审计/自动修复/断点恢复/可视化`
- Topics：`ai-agents` `coding-agent` `automation` `deepseek` `claude-code` `github-actions` `workbench` `nodejs`
- 默认分支 `main`；开启 **Require pull request before merging** 与 CI `AI Workbench CI`。
- 开启 Secret scanning / Dependabot（本项目零依赖，主要防 Action 版本漂移）。
- 将 `SECURITY.md` 中的私有漏洞报告打开（Settings → Code security → Private vulnerability reporting）。

## 5. 非官方声明

DeepSeek Harness / Claude Code 等为各自厂商产品；本项目是独立第三方集成，与厂商无隶属或官方授权关系。
README 已包含该声明。

## 6. 发布步骤（维护者）

```bash
# 确认干净状态
git status
npm test

# 创建 GitHub 仓库（公开）
# 方式 A：用 GitHub CLI
gh repo create ai-workbench --public --source=. --remote=origin --push

# 方式 B：在 GitHub 网页创建空仓库后
git remote add origin git@github.com:<owner>/ai-workbench.git
git branch -M main
git push -u origin main

# 打 tag（可选）
git tag -a v1.0.0 -m "AI Development Workbench v1.0.0"
git push origin v1.0.0
```

- 推送后检查 GitHub Actions 的 `AI Workbench CI` 是否在 ubuntu 上跑通 `npm test`
  （本机为 macOS，CI 首次运行需要留意 Linux 兼容性）。
- 不要在公开仓库中提交真实 `.env`；不要将私有演示仓库转为公开之前检查其内容。
- 演示用的 GitHub Token 与模型 Key：发布后建议轮换/撤销，避免出现在个人配置备份中。

## 7. 发布后建议

- 用 1–2 个真实小项目跑一遍 `npm start` 流程，确认外部用户路径可用。
- 在 Issues 中提供模板：环境信息（OS/Node/Agent 版本）、复现步骤、事件日志（注意脱敏）。
- 明确“项目处于早期阶段、API 可能变化”；当前版本为 v1.0.0。
