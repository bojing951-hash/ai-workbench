# v3.0 浏览器与 HTTP 回归

## 真实 HTTP 回归

`tests/chat-http.test.js` 使用真实 HTTP Workbench server + 本地 OpenAI 兼容假上游（确定性、不产生模型费用）：

- 首页首条消息：一条用户消息、一次模型调用、一条 assistant；
- 并发同 `clientMessageId`：只产生一条用户消息/一次模型调用；
- 模型失败后同 key 重试：不重复用户消息，只保留一条有效回复；
- 自然语言“现在进度怎么样”：不调用模型，返回 DB 真实任务状态；
- Chat 超预算：409 且上游调用 0 次。

## Playwright 回归

`scripts/chat-ui-playwright.mjs` 启动真实 Workbench HTTP + 浏览器，验证：

- 首页首条消息必定进入真实聊天（DOM 用户/assistant 各一条）；
- 上游只调用一次；
- 快速重复 Enter 只新增一条用户消息/一次模型调用；
- 刷新后对话与历史消息恢复；
- “现在进度怎么样？”显示真实控制卡且不调用模型；
- 我的项目切换主面板；
- 390px 无横向溢出；
- 浏览器 page errors = 0。

运行方式（Playwright 未加入 Workbench 运行时依赖）：

```bash
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROME_BIN=/path/to/chrome \
node scripts/chat-ui-playwright.mjs
```

结果：`demo/evidence/v3.0/ui/playwright-result.json`（ok=true），截图同目录。

## 截图

- `docs/v3.0/screenshots/01-welcome.png` 首页
- `02-projects.png` 我的项目
- `03-advanced.png` 高级工程控制台
- `04-controls-blocked.png` 真实历史阻塞状态 + v3 控制栏
- `05-mobile.png` 手机首页
- `docs/v3.0/screenshots/06-browser-welcome.png` 浏览器回归首页
- `07-browser-first-message.png` 首条消息成功（用户 + AI 可见）
- `08-browser-control.png` 自然语言真实状态控制卡
- `09-browser-mobile.png` 浏览器回归移动端
