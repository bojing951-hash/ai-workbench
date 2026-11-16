// SPDX-License-Identifier: Apache-2.0
/**
 * v3.0 受限自然语言控制协议。
 * 模型/前端只能提出白名单动作；真正执行由服务端基于当前对话/项目状态、现有 API 和租约完成。
 * 不允许自由 shell/Git 命令，不允许操作未关联项目。
 */
import { PolicyError } from './policy.js';
import { nowIso } from './util.js';

export const CONTROL_ACTIONS = ['start', 'status', 'current_task', 'failure', 'pause', 'resume', 'cost', 'tests', 'audit', 'delivery'];
export const MUTATING_ACTIONS = new Set(['start', 'pause', 'resume']);

const PATTERNS = [
  ['start', /^(开始|启动|开始开发|开始研发|确认开始|可以开始|开工|立即开发)\s*[!！。.]?$/i],
  ['pause', /^(暂停|暂停开发|暂停研发|先停一下|停下来)\s*[!！。.]?$/i],
  ['resume', /^(继续|继续开发|继续研发|恢复|恢复开发|恢复研发)\s*[!！。.]?$/i],
  ['failure', /(失败原因|为什么失败|为什么卡住|错误原因|卡在哪里|阻塞原因)/i],
  ['current_task', /(当前任务|现在做什么|正在做什么|下一步|当前步骤)/i],
  ['tests', /(测试|test|用例|验收证据)/i],
  ['audit', /(审计|审查|audit)/i],
  ['delivery', /(交付|完成状态|验收状态|最终结果|可以验收)/i],
  ['cost', /(成本|花费|费用|预算|用了多少|token)/i],
  ['status', /(进度|状态|进展|到哪一步|怎么样了)/i],
];

export function parseControlIntent(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 80) return '';
  for (const [intent, re] of PATTERNS) if (re.test(t)) return intent;
  return '';
}

function projectForConversation(store, conversation) {
  if (!conversation?.project_id) return null;
  return store.getProject(conversation.project_id);
}

function loopForConversation(store, conversation) {
  if (conversation?.loop_id) return store.getLoop(conversation.loop_id);
  if (conversation?.project_id) {
    const loops = store.listLoops({ projectId: conversation.project_id });
    return loops[0] || null;
  }
  return null;
}

function runSnapshot(store, loop, run) {
  const tasks = run ? store.listTasks({ runId: run.id }) : [];
  const audits = tasks.flatMap((t) => store.listAudits(t.id));
  const latestAudit = audits.at(-1) || null;
  const current = tasks.find((t) => ['preparing', 'coding', 'testing', 'auditing', 'repairing', 'committing'].includes(t.status)) || tasks[0] || null;
  const quality = (loop?.history_json || []).slice().reverse().find((h) => h?.quality)?.quality || null;
  return { run, tasks, audits, latestAudit, current, quality };
}

function controlSnapshot({ store, conversation, intent, budget = null }) {
  const project = projectForConversation(store, conversation);
  const loop = loopForConversation(store, conversation);
  const run = loop?.current_run_id ? store.getRun(loop.current_run_id) : (conversation.run_id ? store.getRun(conversation.run_id) : null);
  const snap = runSnapshot(store, loop, run);
  const base = {
    intent, at: nowIso(), projectId: project?.id || '', loopId: loop?.id || '', runId: run?.id || '',
    loopStatus: loop?.status || '', runStatus: run?.status || '', stopReason: loop?.stop_reason || run?.stop_reason || '',
    currentTask: snap.current ? { id: snap.current.id, title: snap.current.title, status: snap.current.status } : null,
    tasksTotal: snap.tasks.length, tasksPassed: snap.tasks.filter((t) => t.status === 'passed').length,
    audits: snap.audits.map((a) => ({ id: a.id, provider: a.provider, model: a.model, verdict: a.verdict, status: a.verification_status, score: a.score, summary: a.summary })).slice(-3),
    quality: snap.quality ? { allPass: !!snap.quality.allPass, coverage: snap.quality.coverage || null } : null,
    cost: run ? { tokens: run.spent_json?.tokens || 0, costCny: run.spent_json?.costCny || 0 } : null,
    budget,
  };
  if (intent === 'status') return { ...base, title: run ? `当前${run.status}` : '尚未开始', text: run ? `当前运行 ${run.status}，当前任务：${snap.current?.title || '无'}` : '这个对话还没有开始开发。' };
  if (intent === 'current_task') return { ...base, title: snap.current ? '当前任务' : '没有当前任务', text: snap.current ? `${snap.current.title}（${snap.current.status}）` : '当前没有正在执行的任务。' };
  if (intent === 'failure') return { ...base, title: base.stopReason ? '真实失败原因' : '没有记录的失败', text: base.stopReason || '当前没有失败/阻塞记录。' };
  if (intent === 'cost') return { ...base, title: '真实用量与预算', text: `本次运行 tokens=${base.cost?.tokens || 0}，估算成本 ¥${Number(base.cost?.costCny || 0).toFixed(4)}${budget ? `；全局剩余 ${Math.round(budget.remainingTokens)} tokens / ¥${Number(budget.remainingCostCny || 0).toFixed(2)}` : ''}` };
  if (intent === 'tests') return { ...base, title: '真实测试证据', text: snap.current ? `最近任务测试命令/证据请展开开发详情；任务状态=${snap.current.status}；审计数=${snap.audits.length}` : '还没有测试记录。' };
  if (intent === 'audit') return { ...base, title: '独立审计', text: snap.latestAudit ? `${snap.latestAudit.provider}/${snap.latestAudit.model} ${snap.latestAudit.verification_status}（${snap.latestAudit.score} 分）：${snap.latestAudit.summary || ''}` : '还没有独立审计记录。' };
  if (intent === 'delivery') return { ...base, title: '交付状态', text: run ? `运行状态 ${run.status}；验证 ${run.verification_status || 'UNKNOWN'}；Git ${String(run.verified_sha || '').slice(0, 12) || '无'}；等待用户验收，不自动合并/部署。` : '还没有可交付运行。' };
  return base;
}

export async function executeConversationControl({ config, store, orchestrator, loops, conversation, intent, requestKey, budgetProvider = null }) {
  if (!CONTROL_ACTIONS.includes(intent)) throw new PolicyError('CONTROL_NOT_ALLOWED', `控制动作不在白名单：${intent}`);
  const key = String(requestKey || '');
  if (key) {
    const existing = store.getActionByRequestKey(key);
    if (existing?.status === 'done') return { ...existing.result_json, idempotent: true };
  }
  const project = projectForConversation(store, conversation);
  const loop = loopForConversation(store, conversation);
  if (MUTATING_ACTIONS.has(intent) && !conversation.project_id && intent !== 'start') throw new PolicyError('CONVERSATION_PROJECT_REQUIRED', '对话尚未关联项目，不能执行控制动作');
  if (loop && project && loop.project_id !== project.id) throw new PolicyError('CONTROL_PROJECT_MISMATCH', '对话关联的 Loop 不属于该对话项目，拒绝控制');
  const action = key ? (store.getActionByRequestKey(key) || store.createAction({ id: `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, conversationId: conversation.id, requestKey: key, type: `chat.${intent}`, status: 'running', payload: { intent } })) : null;
  try {
    let result;
    if (intent === 'start') {
      if (loop && ['running', 'paused'].includes(loop.status)) {
        result = controlSnapshot({ store, conversation, intent: 'status', budget: budgetProvider ? budgetProvider() : null });
        result.title = '开发已在执行';
      } else {
        const { startDevelopment } = await import('./chat.js');
        const started = await startDevelopment({ config, store, orchestrator, loops, conversation, projectId: conversation.project_id || '' });
        const updated = store.getConversation(conversation.id);
        result = { ...controlSnapshot({ store, conversation: updated, intent: 'status', budget: budgetProvider ? budgetProvider() : null }), title: started.existing ? '已在开发中' : '已开始开发', text: started.existing ? '这个目标已经在开发，我带你回到当前进度。' : '已开始开发；规划、编码、测试、独立审计与自动修复由 Workbench 接管，完成后等待你验收。' };
      }
    } else if (intent === 'pause') {
      if (!loop) throw new PolicyError('LOOP_NOT_FOUND', '对话尚未关联研发循环');
      await loops.pause(loop.id, '用户通过自然语言暂停');
      result = { ...controlSnapshot({ store, conversation: store.getConversation(conversation.id), intent: 'status', budget: budgetProvider ? budgetProvider() : null }), title: '已暂停', text: '研发已暂停，检查点已保存；说“继续开发”可恢复。' };
    } else if (intent === 'resume') {
      if (!loop) throw new PolicyError('LOOP_NOT_FOUND', '对话尚未关联研发循环');
      await loops.resume(loop.id, { retryCurrent: false });
      result = { ...controlSnapshot({ store, conversation: store.getConversation(conversation.id), intent: 'status', budget: budgetProvider ? budgetProvider() : null }), title: '已继续', text: '研发已从检查点继续。' };
    } else {
      result = controlSnapshot({ store, conversation, intent, budget: budgetProvider ? budgetProvider() : null });
    }
    if (action) store.updateAction(action.id, { status: 'done', result });
    return result;
  } catch (err) {
    if (action) store.updateAction(action.id, { status: 'failed', result: { error: String(err?.message || err), code: err?.code || '' } });
    throw err;
  }
}
