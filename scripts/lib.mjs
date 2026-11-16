// SPDX-License-Identifier: Apache-2.0
/** 演示/验收脚本公共工具：真实调用工作台 HTTP API，准备演示仓库。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const API = (process.env.WORKBENCH_URL || 'http://127.0.0.1:4477').replace(/\/+$/, '');

export async function waitServer({ timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${API}/api/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`工作台未启动：${API}。请先在另一个终端运行：npm start`);
    }
    await sleep(500);
  }
}

function readApiToken() {
  try {
    return fs.readFileSync(path.join(ROOT, 'data', 'api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export async function api(method, apiPath, body) {
  const token = readApiToken();
  const res = await fetch(`${API}${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-workbench-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`接口返回非 JSON（${res.status}）：${text.slice(0, 500)}`);
  }
  if (!res.ok || data.ok === false) {
    throw new Error(`${method} ${apiPath} 失败：${data?.error?.message || text.slice(0, 500)}`);
  }
  return data.data;
}

export function sh(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败：${res.stderr || res.stdout}`);
  return res.stdout;
}

/** 把 demo/ 下的原始项目复制到 projects/，初始化一个真实 Git 仓库作为开发目标。 */
export function prepareDemoProject(srcRel, destName, { baselineMessage = 'chore: demo baseline' } = {}) {
  const src = path.join(ROOT, 'demo', srcRel);
  const dest = path.join(ROOT, 'projects', destName);
  if (!fs.existsSync(src)) throw new Error(`演示项目不存在：${src}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  sh('git', ['init', '-q', '-b', 'main'], dest);
  sh('git', ['config', 'user.name', 'AI Workbench Demo'], dest);
  sh('git', ['config', 'user.email', 'demo@localhost'], dest);
  sh('git', ['add', '-A'], dest);
  sh('git', ['commit', '-qm', baselineMessage], dest);
  sh('git', ['config', 'user.name', 'AI Workbench'], dest);
  sh('git', ['config', 'user.email', 'workbench@localhost'], dest);
  return dest;
}

export async function findProjectByName(name) {
  const projects = await api('GET', '/api/projects');
  return projects.find((p) => p.name === name) || null;
}

export async function addProjectIfMissing(input) {
  const existing = await findProjectByName(input.name);
  if (existing) return existing;
  return api('POST', '/api/projects', input);
}

export function printEvent(e) {
  const time = new Date(e.createdAt || e.created_at || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  const icon = e.level === 'error' ? '✗' : e.level === 'warn' ? '!' : '·';
  console.log(`  ${icon} [${time}] ${e.type}  ${e.message}`);
}

/** 轮询运行直至终态，打印增量事件，返回运行详情。 */
export async function waitRun(runId, { timeoutMs = 45 * 60 * 1000, label = '运行' } = {}) {
  const started = Date.now();
  let lastEventId = 0;
  let lastStatus = '';
  for (;;) {
    const detail = await api('GET', `/api/runs/${runId}`);
    const newEvents = (detail.events || []).filter((e) => e.id > lastEventId);
    for (const e of newEvents) {
      lastEventId = Math.max(lastEventId, e.id);
      printEvent(e);
    }
    if (detail.status !== lastStatus) {
      lastStatus = detail.status;
      console.log(`\n[${label}] 状态：${detail.status}`);
    }
    const terminal = ['awaiting_acceptance', 'accepted', 'failed', 'cancelled'];
    if (terminal.includes(detail.status)) {
      if (detail.status === 'awaiting_acceptance') {
        console.log(`\n[${label}] 已完成开发，等待人工验收。`);
      }
      return detail;
    }
    if (detail.status === 'paused') {
      throw new Error(`[${label}] 已暂停：${detail.stop_reason}\n可执行：workbench resume ${detail.id} --retry-failed，或在界面恢复`);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`[${label}] 超时（${timeoutMs / 1000}s）`);
    await sleep(2500);
  }
}

export function saveEvidence(filename, data) {
  const dir = path.join(ROOT, 'demo', 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\n证据已保存：${path.relative(ROOT, file)}`);
  return file;
}

export function summarizeRun(detail) {
  const tasks = (detail.tasks || []).map((t) => {
    const lastAudit = (t.audits || [])[t.audits.length - 1] || null;
    return {
      seq: t.seq,
      title: t.title,
      status: t.status,
      attempts: t.attempts?.length || 0,
      commit: t.head_commit,
      audit: lastAudit
        ? {
            provider: lastAudit.provider,
            model: lastAudit.model,
            verdict: lastAudit.verdict,
            score: lastAudit.score,
            criteria: lastAudit.criteria,
            findings: lastAudit.findings,
            requiredFixes: lastAudit.requiredFixes,
          }
        : null,
      auditHistory: (t.audits || []).map((a) => ({
        provider: a.provider,
        model: a.model,
        verdict: a.verdict,
        score: a.score,
        requiredFixes: a.requiredFixes,
        failedCriteria: (a.criteria || []).filter((c) => c.status !== 'pass').map((c) => ({ criterion: c.criterion, status: c.status })),
      })),
      testCommand: t.result_json?.testCommand || '',
      result: t.result_json,
    };
  });
  return {
    runId: detail.id,
    status: detail.status,
    goal: detail.goal,
    project: detail.project?.name,
    planBranch: detail.result_json?.planBranch || '',
    pr: detail.result_json?.publish?.pr || null,
    ci: (detail.actions || []).find((a) => a.type === 'github-ci')?.result_json || null,
    tasks,
    budget: {
      usedTokens: detail.budget?.usedTokens,
      maxTokens: detail.budget?.maxTokens,
      usedCostCny: detail.budget?.usedCostCny,
      maxCostCny: detail.budget?.maxCostCny,
    },
    events: (detail.events || []).length,
    completedAt: detail.ended_at || '',
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function printSummary(summary) {
  console.log('\n===== 运行摘要 =====');
  console.log(`目标：${summary.goal}`);
  console.log(`状态：${summary.status}`);
  for (const task of summary.tasks) {
    console.log(`\n#${task.seq} ${task.title} -> ${task.status}  尝试 ${task.attempts} 次`);
    if (task.commit) console.log(`  commit: ${String(task.commit).slice(0, 12)}  branch: ${summary.planBranch}`);
    if (task.audit) {
      console.log(`  审计: ${task.audit.provider}/${task.audit.model} -> ${task.audit.verdict}（${task.audit.score} 分）`);
      for (const c of task.audit.criteria || []) console.log(`    [${c.status}] ${c.criterion}`);
    }
  }
  if (summary.pr) console.log(`\nPR: ${summary.pr.url || JSON.stringify(summary.pr)}`);
  if (summary.ci) console.log(`CI: ${summary.ci.conclusion || summary.ci.note || '未知'}`);
  console.log(`\n预算：tokens ${summary.budget.usedTokens}/${summary.budget.maxTokens}，成本 ¥${Number(summary.budget.usedCostCny).toFixed(3)}/${summary.budget.maxCostCny}`);
}
