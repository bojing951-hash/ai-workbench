// SPDX-License-Identifier: Apache-2.0
/** Agent 注册表：统一接口 + 可用性探测 + 调度选择。 */
import * as dsh from './dsh.js';
import * as claude from './claude.js';
import * as custom from './custom.js';

const ADAPTERS = { dsh, claude, custom };
const checkCache = new Map();

export function listAdapterIds() {
  return Object.keys(ADAPTERS);
}

export function getAdapter(id) {
  return ADAPTERS[String(id || '').toLowerCase()] || null;
}

export async function checkAgent(id, config) {
  const adapter = getAdapter(id);
  if (!adapter) return { id, label: id, ok: false, detail: '未知 Agent', capabilities: {} };
  const cacheKey = `${id}:${JSON.stringify({ dsh: config.agents.dsh, claude: config.agents.claude, custom: config.agents.custom })}`;
  const cached = checkCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const value = await adapter.check(config);
  checkCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export async function checkAllAgents(config) {
  const ids = listAdapterIds();
  const results = [];
  for (const id of ids) results.push(await checkAgent(id, config));
  return results;
}

/** 调度决策：项目/任务指定优先；auto 时按可用性与默认顺序选择。 */
export async function chooseAgent(config, project, task) {
  const explicit = [task?.agent_kind, project?.agent_kind, config.agents.default]
    .map((v) => String(v || '').toLowerCase())
    .filter((v) => v && v !== 'auto');
  for (const id of explicit) {
    const availability = await checkAgent(id, config);
    if (availability.ok) return id;
  }
  for (const id of ['dsh', 'claude']) {
    const availability = await checkAgent(id, config);
    if (availability.ok) return id;
  }
  return null;
}

export async function runAgent(agentId, ctx) {
  const adapter = getAdapter(agentId);
  if (!adapter) throw new Error(`未知 Agent: ${agentId}`);
  return adapter.run(ctx);
}
