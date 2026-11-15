#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * 用 Chrome DevTools Protocol 截图（绕过 headless --screenshot 因 SSE 长连接导致的挂起）。
 * 用法：node scripts/screenshot.mjs <url> <outfile> [width] [height] [waitMs]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './lib.mjs';

const url = process.argv[2];
const out = process.argv[3];
const width = Number(process.argv[4] || 1680);
const height = Number(process.argv[5] || 1050);
const waitMs = Number(process.argv[6] || 4000);
if (!url || !out) {
  console.error('用法：node scripts/screenshot.mjs <url> <outfile> [width] [height] [waitMs]');
  process.exit(1);
}

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = path.join(ROOT, 'data', 'chrome-profile');
const home = path.join(ROOT, 'data', 'chrome-home');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(path.join(home, 'crash'), { recursive: true });
fs.rmSync(path.join(profile, 'SingletonLock'), { force: true });

const port = 9333;
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crashpad',
    '--disable-breakpad',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    `--crash-dumps-dir=${path.join(home, 'crash')}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { env: { ...process.env, HOME: home }, stdio: ['ignore', 'ignore', 'ignore'] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error('Chrome CDP 未就绪');
}

let msgId = 0;
const pending = new Map();

function send(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send(ws, 'Page.navigate', { url });
  await sleep(waitMs);
  // 截图脱敏：把当前工作台根目录与用户 home 替换为通配路径（只影响截图，不影响运行数据）
  try {
    const redactions = [[ROOT, '~/ai-workbench'], [os.homedir(), '~']];
    // 可选：SCREENSHOT_EXTRA_REDACT="from1=>to1,from2=>to2"（用于隐藏账号等）
    for (const pair of String(process.env.SCREENSHOT_EXTRA_REDACT || '').split(',')) {
      const [from, to] = pair.split('=>');
      if (from && to) redactions.push([from, to]);
    }
    await send(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const pairs = ${JSON.stringify(redactions)};
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          let text = node.nodeValue;
          for (const [from, to] of pairs) text = text.split(from).join(to);
          if (text !== node.nodeValue) node.nodeValue = text;
        }
        return true;
      })()`,
      returnByValue: true,
    });
    await sleep(400);
  } catch {
    /* 脱敏失败不阻塞截图 */
  }
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  const size = fs.statSync(out).size;
  console.log(`截图已保存：${out}（${size} bytes）`);
  ws.close();
}

main()
  .catch((err) => {
    console.error(`截图失败：${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    chrome.kill('SIGKILL');
    setTimeout(() => process.exit(), 300);
  });
