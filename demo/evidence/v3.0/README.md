# v3.0 证据索引

- `tests.log`：最终 `npm test`，280/280 PASS。
- `budget-snapshot.json`：迁移统一账本后的真实预算快照（未重置历史用量）。
- `ui/playwright-result.json`：真实浏览器回归（ok=true, 15 checks, page errors 0）。
- `ui/01-welcome.png`、`02-first-message.png`、`03-control.png`、`04-mobile.png`：浏览器回归截图。
- `../docs/v3.0/screenshots/`：生产 UI 截图（首页/项目/高级/阻塞控制/移动）。
- 真实 E2E：BLOCKED（见 `../../docs/v3.0/REAL-E2E.md`）；没有伪造 E2E PASS。
