// SPDX-License-Identifier: Apache-2.0
/**
 * 规划器：把产品目标 + 仓库上下文转换为有序任务计划（含可验证验收标准）。
 * 规划由独立 LLM 完成（默认 DeepSeek），失败不会伪造成功。
 */
import fs from 'node:fs';
import path from 'node:path';
import { completeJson, availableProviders } from './llm.js';
import { parseList, truncate } from './util.js';
import { PolicyError } from './policy.js';

const PLANNER_SYSTEM = `你是一名资深软件架构师与交付经理。你的职责是把产品目标拆解为可由自动化 Coding Agent 逐个实现的、可验证的任务计划。

硬性规则：
1. 只输出一个 JSON 对象，不要 Markdown 围栏、不要解释。
2. 任务按依赖顺序排列，后一个任务可以建立在前一个任务的代码之上。
3. 每个任务必须有 1-5 条"验收标准"，每条都必须是第三方可独立验证的客观事实（例如具体接口路径、返回字段、边界行为、文档要求），禁止使用"代码质量好""功能正常"这类不可验证表述。
4. 任务粒度：一个 Coding Agent 单次会话可以完成；优先沿用仓库已有测试与约定。
5. 如果仓库中存在 TASKS.md 或类似任务说明，必须与其保持一致，不要发明冲突的任务。
6. agent 字段用于指定执行者：auto（默认，由调度器决定）、dsh、claude。只有明确需要跨 Agent 演示或任务性质不同才指定。
7. test_command 可选：若某任务只应运行仓库的部分测试，给出具体命令；否则留空表示使用项目默认测试命令。
8. 不要规划需要人工审批、对外发布、合并主分支或涉及真实付款的操作。

输出 JSON 结构：
{
  "title": "计划标题（简短）",
  "tasks": [
    {
      "title": "任务标题",
      "description": "实现说明，包含关键文件/接口/约束",
      "acceptance": ["可独立验证的验收标准 1", "……"],
      "agent": "auto",
      "test_command": ""
    }
  ]
}`;

export async function buildRepoContext(config, project, { maxTree = 120, maxFileChars = 6000 } = {}) {
  const repo = project.local_path;
  const parts = [];
  const pick = (name) => path.join(repo, name);
  for (const name of ['README.md', 'readme.md', 'TASKS.md', 'tasks.md', 'AGENTS.md', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
    const file = pick(name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const content = fs.readFileSync(file, 'utf8');
      parts.push(`### 文件 ${name}\n${truncate(content, maxFileChars)}`);
    }
  }
  const { listTree } = await import('./git.js');
  const tree = await listTree(repo, 'HEAD', { max: maxTree });
  if (tree.length) parts.push(`### 仓库文件（部分）\n${tree.join('\n')}`);
  return {
    text: parts.join('\n\n') || '（仓库为空或无法读取上下文）',
    testCommand: project.test_command || '',
    defaultBranch: project.default_branch || 'main',
  };
}

function validateTasks(rawTasks) {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new PolicyError('PLAN_INVALID', '规划器未返回任何任务');
  }
  if (rawTasks.length > 8) {
    throw new PolicyError('PLAN_INVALID', `规划器返回任务过多（${rawTasks.length}），最多 8 个`);
  }
  return rawTasks.map((t, idx) => {
    const title = String(t?.title || '').trim();
    const description = String(t?.description || '').trim();
    const acceptance = parseList(t?.acceptance);
    if (!title) throw new PolicyError('PLAN_INVALID', `第 ${idx + 1} 个任务缺少 title`);
    if (acceptance.length === 0) throw new PolicyError('PLAN_INVALID', `任务「${title}」缺少验收标准`);
    const agent = ['auto', 'dsh', 'claude'].includes(String(t?.agent || '')) ? String(t.agent) : 'auto';
    return {
      seq: idx + 1,
      title: title.slice(0, 200),
      description: description || title,
      acceptance: acceptance.slice(0, 6),
      agent,
      testCommand: String(t?.test_command || '').trim(),
    };
  });
}

export async function planTasks({ config, project, goal, acceptance = [], mode = 'single', tasks = [] }) {
  const acceptanceList = parseList(acceptance);

  // 显式任务模式（阶段二既定计划 / 阶段一单任务）
  if (Array.isArray(tasks) && tasks.length > 0) {
    const normalized = validateTasks(
      tasks.map((t, i) => ({
        title: t.title || `任务 ${i + 1}`,
        description: t.description || t.title || '',
        acceptance: t.acceptance || acceptanceList,
        agent: t.agent || t.agent_kind || 'auto',
        test_command: t.testCommand || t.test_command || '',
      })),
    );
    return {
      title: `手动计划：${goal.slice(0, 60)}`,
      tasks: normalized,
      plannerMeta: { mode: 'explicit', provider: 'human', createdAt: new Date().toISOString() },
    };
  }

  if (mode === 'single') {
    const singleAcceptance = acceptanceList.length ? acceptanceList : [goal];
    return {
      title: goal.slice(0, 80),
      tasks: [
        {
          seq: 1,
          title: goal.slice(0, 140),
          description: goal,
          acceptance: singleAcceptance,
          agent: 'auto',
          testCommand: '',
        },
      ],
      plannerMeta: { mode: 'single', provider: 'user', createdAt: new Date().toISOString() },
    };
  }

  // 多任务自动规划
  const providers = availableProviders(config);
  const plannerProvider = config.planner.provider;
  const usable =
    providers.find((p) => p.name === plannerProvider) ||
    providers.find((p) => p.name === 'deepseek') ||
    providers.find((p) => p.name === 'openai') ||
    null;
  if (!usable) {
    throw new PolicyError(
      'PLANNER_UNAVAILABLE',
      '缺少可用的规划模型（DeepSeek/OpenAI/GLM）：请在 .env 配置 API Key，或使用 single 模式并手工提供任务',
    );
  }

  const repoContext = await buildRepoContext(config, project);
  const userPrompt = [
    `## 产品目标\n${goal}`,
    acceptanceList.length ? `## 用户补充的验收标准\n${acceptanceList.map((a, i) => `${i + 1}. ${a}`).join('\n')}` : '',
    `## 项目信息\n名称：${project.name}\n默认分支：${project.default_branch}\n默认测试命令：${project.test_command || '（未配置）'}`,
    `## 仓库上下文\n${repoContext.text}`,
    '请输出任务计划 JSON。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await completeJson({
    config,
    provider: usable.name,
    model: usable.model,
    system: PLANNER_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 3500,
    temperature: 0,
    timeoutMs: config.planner.timeoutMs,
  });

  const normalized = validateTasks(result.json?.tasks);
  return {
    title: String(result.json?.title || goal).slice(0, 120),
    tasks: normalized,
    plannerMeta: {
      mode: 'auto',
      provider: result.provider,
      providerLabel: result.providerLabel,
      model: result.model,
      usage: result.usage,
      costCny: result.costCny,
      createdAt: new Date().toISOString(),
    },
    usage: result.usage,
    costCny: result.costCny,
  };
}

const NEXT_TASK_SYSTEM = `你是 AI 研发循环的 Planner。你的任务是基于项目的权威目标、当前状态、契约文件与已完成历史，选出**一个**最小、真实、可验证的下一项工程任务。

硬性规则：
1. 只输出 JSON，不要 Markdown 围栏或解释。
2. 只能选择当前代码/文档中确实缺失或未验证的能力；不得重复已完成任务，不得制造任务维持循环。
3. 优先选择低风险、能在单次 Agent 会话完成、可用仓库现有测试命令验证的任务；禁止修改保护路径（测试/验收/CI）、禁止推送/合并/部署、禁止付费数据源。
4. 若找不到真实且安全的下一任务，返回 {"action":"no_task","rationale":"..."}；若被权限/外部依赖阻塞，返回 {"action":"blocked","rationale":"...","blocked_reason":"..."}。
5. 任务必须给出 1-5 条可独立验证的验收标准，以及建议的 agent（auto/dsh/claude）。
6. 不要建议"运行测试""优化代码"这类无具体产物的空任务。

输出格式（三选一）：
{"action":"task","rationale":"为什么这是当前最重要的真实缺口","task":{"title":"...","description":"...","acceptance":["..."],"agent":"auto","test_command":""}}
{"action":"no_task","rationale":"..."}
{"action":"blocked","rationale":"...","blocked_reason":"..."}`;

export async function planNextTask({ config, project, goal, history = [], contractFiles = [], previousTasks = [] }) {
  const providers = availableProviders(config);
  const usable = providers.find((p) => p.name === config.planner.provider) || providers.find((p) => p.name === 'deepseek') || providers[0];
  if (!usable) throw new PolicyError('PLANNER_UNAVAILABLE', '缺少规划模型，无法生成下一任务');
  const repoContext = await buildRepoContext(config, project);
  const contractBlocks = [];
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const file of contractFiles.slice(0, 8)) {
    try {
      const abs = path.join(project.local_path, file);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        contractBlocks.push(`### ${file}\n${truncate(fs.readFileSync(abs, 'utf8'), 6000)}`);
      }
    } catch { /* ignore */ }
  }
  const historyLines = history.map((h, i) => `${i + 1}. round ${h.round}: ${h.task?.title || h.title} -> ${h.status || 'completed (verified)'} (${h.commit || 'no commit'})`);
  const prevLines = previousTasks.map((t) => `- ${t.title}`).join('\n') || '（无）';
  const userPrompt = [
    `## 项目\n${project.name}（${project.language || 'unknown'}，默认分支 ${project.default_branch}，测试命令 ${project.test_command || '未配置'}）`,
    `## 研发循环目标\n${goal}`,
    `## 已完成任务（不得重复）\n${historyLines.join('\n') || '（无）'}\n${prevLines}`,
    `## 权威契约文件\n${contractBlocks.join('\n\n') || '（未配置）'}`,
    `## 仓库上下文\n${truncate(repoContext.text, 20000)}`,
    '请输出下一步决策 JSON。',
  ].join('\n\n');
  const result = await completeJson({ config, provider: usable.name, model: usable.model, system: NEXT_TASK_SYSTEM, messages: [{ role: 'user', content: userPrompt }], maxTokens: 2500, temperature: 0, timeoutMs: config.planner.timeoutMs });
  const data = result.json || {};
  const action = String(data.action || '').toLowerCase();
  if (!['task', 'no_task', 'blocked'].includes(action)) throw new PolicyError('PLANNER_INVALID', `规划器返回非法 action：${data.action}`);
  if (action !== 'task') return { action, rationale: String(data.rationale || ''), blockedReason: String(data.blocked_reason || data.blockedReason || ''), usage: result.usage, costCny: result.costCny, provider: result.provider, model: result.model };
  const tasks = validateTasks([data.task]);
  const task = tasks[0];
  const normalizedTitle = task.title.trim().toLowerCase();
  const duplicate = history.some((h) => String(h.task?.title || h.title || '').trim().toLowerCase() === normalizedTitle);
  if (duplicate) {
    return { action: 'no_task', rationale: `规划器给出的任务与已完成任务重复：${task.title}`, usage: result.usage, costCny: result.costCny, provider: result.provider, model: result.model };
  }
  return { action: 'task', task, rationale: String(data.rationale || ''), usage: result.usage, costCny: result.costCny, provider: result.provider, model: result.model };
}
