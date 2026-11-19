// SPDX-License-Identifier: Apache-2.0
/** Chat-first 产品对话：真实模型理解目标 + 用现有 Orchestrator/Loop 启动开发。 */
import fs from 'node:fs';
import path from 'node:path';
import { completeJson, availableProviders } from './llm.js';
import { PolicyError } from './policy.js';
import { newId } from './util.js';
import * as gitops from './git.js';
import { assertModelBudget, chatBudgetEstimate } from './budget.js';
import { runWithSendLimit } from './paid-admission.js';
import { writeProjectContract, contractBaseline, sha256File, CONTRACT_FILES, CONTRACT_PROTECTED_PATHS, TRUSTED_CONTRACT_TEST } from './contract.js';
import { containerCapabilities } from './container.js';

const SYSTEM = `你是 AI 开发工作台里的产品工程伙伴。用户通常不懂 Project/Loop/Run/Agent 等工程词，你要用自然中文和他讨论产品，同时判断是否已经可以开始开发。
只输出一个 JSON 对象（不要 Markdown 代码围栏）。字段：
{
  "reply": "给用户看的自然中文回复（简洁、具体，最多 120 字）",
  "ready": true/false,
  "missing": ["仍缺少的必要信息，最多3条"],
  "productName": "产品名称",
  "goal": "可执行的产品目标（包含核心用户、功能和边界）",
  "acceptance": ["可客观验证的验收标准1", "验收标准2", "验收标准3"],
  "questions": ["如果要追问，给用户的一两个短问题"],
  "intent": "none|start|status|current_task|failure|pause|resume|cost|tests|audit|delivery"
}
规则：
1. 先理解用户目标；信息足够时 ready=true，并把目标整理成不含工程术语的产品目标。
2. 只在必要信息缺失时追问，例如产品形态/目标用户/关键功能边界；不要要求用户填写 Project ID、Agent、预算等工程参数。
3. 默认不新增账户、支付、云端上传真实财务/个人数据；如果涉及敏感数据，明确本地优先。
4. acceptance 必须可验证、条件化；不知道用户偏好时把关键未知写成假设而不是编造。
5. 不要声称已经完成开发，只给出理解/确认/追问。`;

function providerFor(config) {
  const providers = availableProviders(config);
  return providers.find((p) => p.name === 'deepseek') || providers.find((p) => p.name === 'glm') || providers[0] || null;
}

export async function chatTurn({ config, store, conversation, userMessage, project = null, budgetRequestKey = '', budgetReservationId = '', retryAuthorized = false }) {
  const provider = providerFor(config);
  if (!provider) throw new PolicyError('CHAT_MODEL_UNAVAILABLE', '对话模型不可用：请在 .env 配置 DeepSeek/GLM/OpenAI API Key；未使用预设回复冒充 AI');
  const experiment = store.getExperimentForConversation?.(conversation.id) || (project ? store.getExperimentForProject?.(project.id) : null);
  if (experiment) {
    if (!['authorized', 'running'].includes(experiment.status)) throw new PolicyError('EXPERIMENT_NOT_ACTIVE', `实验契约状态 ${experiment.status}，拒绝新增 Chat 付费调用`);
    const mode = String(experiment.isolation_mode || '').toUpperCase();
    if (mode === 'DOCKER_REQUIRED') {
      const caps = containerCapabilities(config);
      if (!caps.testExecution || !caps.agentExecution) throw new PolicyError('EXPERIMENT_ISOLATION_BLOCKED', `实验要求 Docker 隔离，但 Docker/镜像不可用：${caps.image.reason || caps.docker.reason || 'unknown'}；拒绝 Chat 模型调用`);
    } else {
      throw new PolicyError('EXPERIMENT_ISOLATION_BLOCKED', `实验隔离方案 ${mode || 'EMPTY'} 未满足安全边界；拒绝 Chat 模型调用`);
    }
  }
  const chatBinding = experiment?.provider_json?.chat;
  if (chatBinding && (provider.name !== chatBinding.provider || String(provider.model || '').toLowerCase() !== String(chatBinding.model || '').toLowerCase())) {
    throw new PolicyError('EXPERIMENT_MODEL_MISMATCH', `Chat 实际模型 ${provider.name}/${provider.model} 与实验授权 ${chatBinding.provider}/${chatBinding.model} 不匹配`);
  }
  const budget = assertModelBudget({ config, store, provider: provider.name, model: provider.model, ...chatBudgetEstimate(provider.name, provider.model), label: '对话模型', reserve: true, requestKey: budgetRequestKey, reservationId: budgetReservationId, retryAuthorized, experimentId: experiment?.id || '', experimentScope: provider.name === 'glm' ? 'glm' : 'global', experimentRole: 'chat', experimentClient: provider.name });
  const history = store.listConversationMessages(conversation.id).slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }));
  // 最新用户消息已由 server 保存；从历史尾部去掉，避免模型收到重复内容。
  if (history.length && history[history.length - 1].role === 'user' && history[history.length - 1].content === userMessage) history.pop();
  const context = [
    project ? `当前关联项目：${project.name}（${project.local_path}）` : '当前还没有选择项目；如果用户确认开始，本对话会创建一个新的本地项目。',
    conversation.goal ? `已整理目标：${conversation.goal}` : '',
    conversation.brief_json?.acceptance?.length ? `已整理验收：${conversation.brief_json.acceptance.join(' | ')}` : '',
    '对话历史（最后一条是用户最新输入）：',
    ...history.map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`),
  ].filter(Boolean).join('\n\n');
  let result;
  try {
    result = await runWithSendLimit(1, () => completeJson({
      config, provider: provider.name, model: provider.model,
      system: SYSTEM,
      messages: [{ role: 'user', content: `${context}\n\n用户最新输入：${userMessage}` }],
      maxTokens: 1200, temperature: 0.2, timeoutMs: 90_000,
    }));
  } catch (err) {
    if (budget.reservation?.id) store.markModelReservationUnknown(budget.reservation.id);
    throw err;
  }
  const j = result.json || {};
  if (!j.reply) {
    if (budget.reservation?.id) store.markModelReservationUnknown(budget.reservation.id);
    throw new PolicyError('CHAT_MODEL_BAD_OUTPUT', '对话模型未返回可用回复；不伪造预设回复');
  }
  const goal = String(j.goal || conversation.goal || '').trim();
  const acceptance = Array.isArray(j.acceptance) ? j.acceptance.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : [];
  return {
    reply: String(j.reply || '').slice(0, 2000),
    ready: j.ready === true && !!goal && acceptance.length > 0,
    missing: Array.isArray(j.missing) ? j.missing.map(String).slice(0, 5) : [],
    questions: Array.isArray(j.questions) ? j.questions.map(String).slice(0, 3) : [],
    productName: String(j.productName || conversation.title || '新软件产品').slice(0, 120),
    goal,
    acceptance,
    provider: result.provider, model: result.model, usage: result.usage || {}, usageKnown: result.usageKnown, costCny: result.costCny || 0,
    providerKnown: budget.identity.known, providerSource: budget.identity.source, budgetExempt: budget.exempt, budgetReservation: budget.reservation || null,
    intent: ['start','status','current_task','failure','pause','resume','cost','tests','audit','delivery'].includes(String(j.intent || '')) ? String(j.intent) : 'none',
  };
}

export async function startDevelopment({ config, store, orchestrator, loops, conversation, projectId = '' }) {
  if (!loops || !orchestrator) throw new PolicyError('ENGINE_UNAVAILABLE', '研发引擎不可用');
  if (conversation.status === 'running' || conversation.status === 'awaiting_acceptance') {
    return { conversation, project: store.getProject(conversation.project_id), loop: conversation.loop_id ? loops.get(conversation.loop_id) : null, existing: true };
  }
  let project = projectId ? store.getProject(projectId) : (conversation.project_id ? store.getProject(conversation.project_id) : null);
  const experiment = store.getExperimentForConversation?.(conversation.id) || (project ? store.getExperimentForProject?.(project.id) : null);
  if (experiment && !['authorized', 'running'].includes(experiment.status)) throw new PolicyError('EXPERIMENT_NOT_ACTIVE', `实验契约当前状态 ${experiment.status}，不能创建新的付费开发；请重新授权`);
  if (!project) {
    if (!conversation.goal || !Array.isArray(conversation.brief_json?.acceptance) || !conversation.brief_json.acceptance.length) {
      throw new PolicyError('GOAL_NOT_READY', '还没有确认产品目标和验收标准，不能开始开发');
    }
    const slug = String(conversation.title || 'chat-product').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'chat-product';
    const localPath = path.join(config.paths.projectsDir, `chat-${slug}-${Date.now().toString(36)}`);
    fs.mkdirSync(localPath, { recursive: true });
    // 新项目位于 Workbench 仓库目录下；必须创建嵌套独立 .git，否则 git -C 会落到父仓库。
    await gitops.git(localPath, ['init', '-b', 'main']);
    await gitops.ensureGitRepo(localPath, 'main');
    fs.writeFileSync(path.join(localPath, 'README.md'), `# ${conversation.title || conversation.goal}\n\n${conversation.goal}\n\n由 AI Workbench Chat 创建；验收契约见 CONTRACT.md。\n`);
    // 冻结契约 + 真实测试计划：不再用 testCommand='true' 作为通过依据。
    const componentHashes = writeProjectContract(localPath, {
      title: conversation.title, goal: conversation.goal, acceptance: conversation.brief_json.acceptance, productName: conversation.title,
    });
    // 可信契约测试也在冻结基线内，Agent 修改即失败。
    const baseline = { ...contractBaseline(localPath), ...componentHashes, [TRUSTED_CONTRACT_TEST]: sha256File(path.join(localPath, TRUSTED_CONTRACT_TEST)) };
    const trustedTestHashes = { [TRUSTED_CONTRACT_TEST]: baseline[TRUSTED_CONTRACT_TEST] };
    const testPlan = { minTests: Math.max(2, (conversation.brief_json?.acceptance || []).length), requireActualTests: true, forbidTrivialCommand: true, trustedContractTest: TRUSTED_CONTRACT_TEST, acceptance: [...(conversation.brief_json?.acceptance || [])] };
    project = await orchestrator.createProject({
      name: conversation.title || conversation.goal.slice(0, 40),
      repo: localPath,
      defaultBranch: 'main',
      // 初始无测试命令：按实现后的真实技术栈检测；没有有效测试则 blocked，而不是 exit 0 假通过。
      testCommand: '',
      allowedTestCommands: [],
      contractFiles: CONTRACT_FILES,
      protectedPaths: CONTRACT_PROTECTED_PATHS,
      requireRealTests: true,
      autoTestSetup: true,
      testPlan,
      contractBaseline: baseline,
      trustedTestHashes,
      ciRequired: false,
      supervisorManaged: true,
      publish: false,
      agentKind: experiment?.provider_json?.coding?.client || 'auto',
      auditProvider: experiment?.provider_json?.audit?.client === 'dsh' ? 'dsh' : 'auto',
      config: experiment ? { agent_isolation: 'docker', test_isolation: 'docker' } : undefined,
    });
    // 项目关联在下方实验绑定块统一完成；禁止在哈希校验前重复写 project_id。
    store.updateConversation(conversation.id, { project_id: project.id, title: conversation.title, goal: conversation.goal });
    await gitops.commitAll(localPath, 'chore: initialize chat product');
  }
  if (experiment && project) {
    orchestrator.updateProject?.(project.id, { agentIsolation: 'docker', testIsolation: 'docker', agentKind: experiment.provider_json?.coding?.client || project.agent_kind, auditProvider: experiment.provider_json?.audit?.client === 'dsh' ? 'dsh' : project.audit_provider });
    store.linkExperimentProject?.(experiment.id, project.id, { conversationId: conversation.id });
  }
  const active = store.listLoops({ projectId: project.id }).find((l) => ['running', 'paused'].includes(l.status));
  if (active) {
    // 崩溃恢复：loop 已创建但对话未关联时，重新接管同一 loop，而不是要求用户另起任务。
    const adopted = store.updateConversation(conversation.id, { project_id: project.id, loop_id: active.id, run_id: active.current_run_id || '', status: 'running' });
    return { conversation: adopted, project: store.getProject(project.id), loop: loops.get(active.id), existing: true, adopted: true };
  }
  const loop = await loops.create({
    projectId: project.id,
    goal: conversation.goal,
    mode: 'plan',
    maxRounds: Math.max(3, Math.min(8, Number(project.config_json?.auto_repair_max || 2) + 3)),
    queue: [],
    contractFiles: ['CONTRACT.md'],
  });
  const updated = store.updateConversation(conversation.id, { project_id: project.id, loop_id: loop.id, status: 'running', brief_json: { ...(conversation.brief_json || {}), acceptance: conversation.brief_json?.acceptance || [] } });
  return { conversation: updated, project, loop, existing: false };
}
