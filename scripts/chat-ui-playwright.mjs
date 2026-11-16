#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * v3.0 真实浏览器回归（可选运行，需 Playwright）：
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_BIN=/path/to/chrome node scripts/chat-ui-playwright.mjs
 * 启动真实 Workbench HTTP 服务 + 本地假模型上游，用浏览器验证“首页第一次输入必达模型、单条只发一次、刷新不丢、移动端无溢出”。
 * 不触碰生产 DB/项目，不调用真实模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createApp } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
let chromium;
try { ({ chromium } = await import(modulePath)); } catch (err) { console.error(`Playwright 不可用（${modulePath}）：${err.message}`); process.exit(2); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-ui-'));
const upstreamState = { calls: 0 };
const upstream = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    upstreamState.calls += 1;
    const reply = { reply: '这是来自假上游的真实 OpenAI 兼容响应，用于浏览器回归。', ready: true, missing: [], productName: '浏览器回归产品', goal: '验证首页首条消息发送', acceptance: ['首条消息进入真实聊天流程', '刷新后消息保留'], questions: [], intent: 'none' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
fs.symlinkSync(path.join(ROOT, 'web'), path.join(work, 'web'), 'dir');
const dataDir = path.join(work, 'data');
const config = getConfig({
  root: work,
  paths: { root: work, dataDir, dbPath: path.join(dataDir, 'workbench.db'), projectsDir: path.join(work, 'projects'), worktreesDir: path.join(dataDir, 'worktrees'), artifactsDir: path.join(dataDir, 'artifacts'), logsDir: path.join(dataDir, 'logs'), agentsDir: path.join(dataDir, 'agents'), dshHome: path.join(dataDir, 'agents/dsh-home'), claudeHome: path.join(dataDir, 'agents/claude-home') },
  llm: { deepseek: { apiKey: 'ui-test', baseUrl: upstreamBase, model: 'ui-test-model' }, openai: { apiKey: '' }, glm: { apiKey: '' } },
  github: { token: '', createPr: false, push: false, autoCreateRepo: false },
  security: { apiToken: '', allowedHosts: [], testEnvAllowlist: [] },
  budget: { maxTotalTokens: 3_000_000, maxCostCny: 30, minReserveTokens: 2000 },
});
const store = openStore(config.paths.dbPath);
const orchestrator = new Orchestrator({ config, store, bus: new EventBus(), deps: { checkAgents: async () => [], runAgent: async () => { throw new Error('no'); }, runAudit: async () => { throw new Error('no'); }, chooseAgent: async () => { throw new Error('no'); } } });
const server = createApp({ config, store, orchestrator });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const url = `http://127.0.0.1:${server.address().port}`;
const shots = path.join(ROOT, 'demo/evidence/v3.0/ui');
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror:${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text()}`); });
const checks = [];
const check = (name, ok, extra = '') => { checks.push({ name, ok: !!ok, extra }); if (!ok) throw new Error(`检查失败：${name} ${extra}`); };
try {
  await page.goto(`${url}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  check('首页可见', await page.locator('#welcome').isVisible());
  check('桌面无移动菜单', !(await page.locator('#menuBtn').isVisible()));
  await page.screenshot({ path: path.join(shots, '01-welcome.png') });
  await page.fill('#welcomeInput', '帮我开发一个浏览器回归测试工具');
  await page.click('#welcomeSend');
  await page.waitForSelector('#conversation:not([hidden])', { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelectorAll('.msg').length >= 2, null, { timeout: 20_000 });
  check('首条消息进入真实聊天', (await page.locator('.msg.user').count()) === 1);
  check('收到回复', (await page.locator('.msg.assistant').count()) >= 1);
  check('上游只调用一次', upstreamState.calls === 1, `calls=${upstreamState.calls}`);
  check('无重复用户消息', (await page.locator('.msg.user').count()) === 1);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, '02-first-message.png') });
  // 自然语言控制：纯查询不调用模型，展示真实控制卡
  const beforeControlCalls = upstreamState.calls;
  await page.fill('#chatInput', '现在进度怎么样？');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  check('自然语言查询显示控制卡', (await page.locator('.control-card').count()) >= 1);
  check('控制查询不调用模型', upstreamState.calls === beforeControlCalls, `calls=${upstreamState.calls}`);
  await page.screenshot({ path: path.join(shots, '03-control.png') });
  // 快速重复点击/回车不得重复
  await page.fill('#chatInput', '再确认一次');
  await Promise.all([page.keyboard.press('Enter'), page.keyboard.press('Enter')]);
  await page.waitForTimeout(1200);
  check('重复发送只产生一条新用户消息', (await page.locator('.msg.user').count()) === 3, `users=${await page.locator('.msg.user').count()}`);
  check('重复发送只多调用一次模型', upstreamState.calls === 2, `calls=${upstreamState.calls}`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  check('刷新恢复对话', await page.locator('#conversation').isVisible());
  check('刷新恢复历史消息', (await page.locator('.msg').count()) >= 4);
  // 项目导航真实切换
  await page.click('#navProjects');
  await page.waitForTimeout(300);
  check('我的项目切换主面板', (await page.locator('.projects-grid').count()) === 1 && (await page.locator('#conversation').isHidden()));
  check('无浏览器错误', errors.length === 0, JSON.stringify(errors));
  // 移动端
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await mobile.goto(`${url}/`, { waitUntil: 'networkidle' });
  await mobile.waitForTimeout(500);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('390px 无横向溢出', overflow === 0, `overflow=${overflow}`);
  await mobile.screenshot({ path: path.join(shots, '04-mobile.png') });
  const result = { ok: true, checks, upstreamCalls: upstreamState.calls, errors, screenshots: fs.readdirSync(shots) };
  fs.writeFileSync(path.join(ROOT, 'demo/evidence/v3.0/ui/playwright-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  const result = { ok: false, checks, error: String(err?.message || err), errors, screenshots: fs.readdirSync(shots) };
  fs.writeFileSync(path.join(ROOT, 'demo/evidence/v3.0/ui/playwright-result.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
  store.close();
  await new Promise((r) => upstream.close(r));
  fs.rmSync(work, { recursive: true, force: true });
}
