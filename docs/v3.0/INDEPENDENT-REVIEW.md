# v3.0 独立只读审查记录

审查者：`v30-reviewer`（只读子代理，不修改文件、不重启生产服务、不触碰业务产品）。

## 首轮发现（已整改）

- **P0-2 假 PASS**：Agent 可伪造 `tests N pass` 输出 / 用注释中的断言 / 用未引用产品代码的自证测试通过。
  - 整改：Workbench 独立 runner 直接执行发现到的产品测试文件；拒绝 comments、`process.exit/stdout/stderr`、`console`；断言必须引用导入的产品符号或真实入口；测试文件/ runner 配置冻结。
  - 回归 probe：伪造输出、未使用 import 的常量断言、注释断言均被拒绝。
- **P0-2 运行器配置未冻结**：仅冻结测试文件时 Agent 可改 package.json test script。整改：`package.json`/lockfile/测试配置一并冻结并加入 protected paths；集成测试断言 package.json 受保护。
- **P1 test_command allowlist 顺序**：已修（不再在检测/allowlist 前直接返回 task-supplied command）。
- **P1 /control 默认 requestKey 缓存过期**：已改为服务端唯一默认 key，UI 每击唯一 key + 锁；重复 pause→resume→pause 不会命中旧结果。
- **P1 失败调用用量漏账**：失败 Chat 调用写入 `llm_usage` unknown 记录（0 token 计费，但不静默消失）。
- **截图空白**：`.msg` 的 opacity 动画导致截图空白，已改为 transform-only 动画并重拍。
- **刷新重试**：lastFailed/client conversation key 持久化到 localStorage，刷新后保留重试 affordance / 不重复建对话。

## 复审状态

- 最终复审尚未返回；本文件不会把“开发者自评”当成独立通过。
- 当前已知**残余**（客观）：
  1. 无法自动证明任意产品测试覆盖全部业务行为；独立审计是行为层，真实 E2E 未执行；
  2. 24H / 真实 DSH 审计 / 真实自动修复闭环未验证；
  3. 全部写路径 Fencing 未形式化穷举；
  4. TypeScript/Python/Go/Rust 依赖环境与 runner 支持不完整（Node 最完整）。

## 最终复审（21:56，只读）

**结论：无仍确认 P0/P1。**

- 已复验：伪造 stdout + `process.exit` + 注释断言、未使用 import 的常量断言、`add(){return 0}` + 弱断言，均被 scanner/independent runner 拒绝（task blocked/run paused）。
- 已复验：package.json/lockfile/test config 冻结；后续改 package.json test script 被阻止。
- 已复验：隐藏契约测试绑定全部 acceptance 项并由 Workbench 独立执行。
- 已复验：/control 默认 key 不再缓存旧 status；UI 每击唯一 key。
- 已复验：浏览器 15/15，截图 `02-first-message` 可见用户+AI；生产 v3.0.0 healthy；预算/账本未变。

### 残余 P2

1. 启发式防伪造仍可被刻意规避（如 `globalThis['console']`）；行为真实性最终依赖独立审计，真实 E2E 未验证。
2. scanner 对 `console.`/默认 import/跨行断言有 fail-closed 误报（只会阻塞，不会放行）；文档已标注启发式。
3. 测试数字依赖环境：Docker 不可用时 quality-isolation 测试 skip；本地最终 280 tests / 278 pass / 2 skipped / 0 fail，另一环境 279 pass+1 skip 属正常条件差异。
4. 生产服务需在最终 hardening 后重启一次以完全对齐；最终交付前已执行。
5. 24H/真实 DSH 审计/真实自动修复闭环仍 UNKNOWN/BLOCKED。
