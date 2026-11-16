# v3.1 浏览器/HTTP 证据

- Playwright：`scripts/chat-ui-playwright.mjs`，真实 Workbench HTTP + 本地 OpenAI 兼容假上游（确定性，不产生模型费用）。
- 15/15 checks PASS，page errors 0，390px overflow 0。
- 覆盖：首页首条消息只一次模型调用、单条用户消息、自然语言进度控制卡不调用模型、重复 Enter 不重复、刷新恢复、项目切换、移动端。
- 结果：`demo/evidence/v3.1/ui/playwright-result.json`。
- 截图：`docs/v3.1/screenshots/`（01 welcome、02 first-message、03 control、04 mobile）。

真实 HTTP 测试：`tests/chat-http.test.js`（并发同 clientMessageId、失败同 key 重试、自然语言查询、预算 409 且上游 0 调用）。
