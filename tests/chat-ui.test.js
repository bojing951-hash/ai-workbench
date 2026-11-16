// SPDX-License-Identifier: Apache-2.0
/** v2.9 Chat-first UI 静态/结构回归（无三方依赖；浏览器视觉验证见 demo/evidence/v2.9/ui-smoke）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('v2.9：首页是 chat-first，旧工程控制台保留在 /advanced', () => {
  const chat = read('web/index.html');
  assert.match(chat, /chat\.js/);
  assert.match(chat, /你想开发什么|把想法/);
  assert.match(chat, /新建开发对话/);
  assert.doesNotMatch(chat, /app\.js/);
  const advanced = read('web/advanced.html');
  assert.match(advanced, /app\.js/);
  assert.match(advanced, /AI 开发工作台/);
});

test('v2.9：聊天 UI 具备无障碍/主题/响应式/真实接口结构', () => {
  const html = read('web/index.html');
  const js = read('web/chat.js');
  const css = read('web/chat.css');
  assert.match(html, /skip-link/);
  assert.match(html, /aria-label="工作台导航"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /prefers-reduced-motion|data-theme/);
  assert.match(js, /\/api\/conversations\/\$\{state\.current\.id\}\/messages/);
  assert.match(js, /\/api\/conversations\/\$\{state\.current\.id\}\/start/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(js, /setInterval\([^\n]*fake|mock assistant/i);
});

test('v2.9：新对话/项目/高级入口都存在，关键按钮有实际事件绑定', () => {
  const js = read('web/chat.js');
  for (const id of ['newChatBtn', 'settingsBtn', 'advancedBtn', 'themeBtn', 'menuBtn']) assert.ok(js.includes(id), `缺少按钮绑定 ${id}`);
  assert.match(js, /side-link\[data-nav\]/);
  assert.match(js, /location\.assign\('\/advanced'\)/);
  assert.match(js, /localStorage\.setItem\('wb-current-conversation'/);
});
