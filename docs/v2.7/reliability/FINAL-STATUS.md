# v2.7 可靠性整改最终状态（12 问）

1. **六项修复多少？**  
   - P0 质量执行：**PARTIAL**（环境/凭据隔离、异步、失败分类 PASS；文件/网络强制沙箱受宿主 EPERM，BLOCKED）。
   - P1-A plan 质量修复：**IMPLEMENTED+TESTED**；真实 plan Agent E2E **UNKNOWN/BLOCKED**。
   - P1-B 非零退出/超时/无效 JSON：**PASS**。
   - P1-C 异步不阻塞：**PASS（单元）**；真实长 HTTP 压测 **UNKNOWN**。
   - P1-D 双 HTTP+控制写+恢复：**PARTIAL PASS**（双 HTTP 单写、控制所有权、失败不泄租约、dead/live owner 恢复、活跃 SIGKILL 恢复）；所有 Git/质量写路径穷举 **UNKNOWN**。
   - P1-E 证据：当前产品证据一致性/条款补充 **PASS**；质量引擎自动 clause 判定 **PARTIAL**。
2. **plan 和 queue 都能自动质量修复？** queue 有历史真实 E2E PASS；plan 只有代码级/队列级测试，真实 Agent E2E **UNKNOWN/BLOCKED**。
3. **Coding Agent 实际完成多少任务？** 历史产品 E2E：8 attempts，7 completed；1 timeout 自动恢复。本轮未运行新产品 E2E。
4. **自主发现/修复产品缺陷？** 历史产品 2 个确认缺陷（planner R2、重复书籍 R1），2/2 修复并复验。本轮 0 个新产品质量缺陷（只做可靠性整改）。
5. **人工介入事件？** 产品源码 0 次；外部 Workbench 工程修复、test harness 修正、失败后手动 cancel/resume/retry；本轮故障注入取消人工操作 1 次。未声称零人工。
6. **活跃任务中 Workbench 崩溃自动恢复？** **PASS after fix**（隔离候选实例，真实模型 Agent；修复前 recovered:false，修复后 resumed:true；审计被取消，未伪造 PASS）。 Supervisor 重启成功。
7. **双 HTTP 单写？** **PASS**：两真实服务并发 startRun 只一个成功；非 owner 控制写单元测试拒绝；旧 owner 不能续写（store）。不是全部写路径穷举。
8. **从一次输入到零人工干预产品交付？** **NO/BLOCKED**：修复后的新完整产品 E2E 没有新的 DSH 专项预算授权；旧产品 E2E 不能冒充新 E2E。
9. **24h？** **24H_NOT_VERIFIED**，未执行。
10. **成本/时长/失败/恢复？** 历史产品：编码 ¥26.9630 + 审计估算 ¥1.3256 = ¥28.2886；2h08m14s；8 attempts/1 timeout；DSH 10 次（4 PASS/6 非 PASS）。本轮无新 DSH 支出；故障注入候选实例 2 attempts、估算 ¥0.0388；崩溃 1 次、恢复 1 次。
11. **UNKNOWN/BLOCKED？** FS/network 沙箱、plan 真实 E2E、新完整 E2E、24h、完整 Git/质量写 fencing、真实长 HTTP health。
12. **还缺什么？** 新的独立 DSH 预算/授权；文件网络隔离运行环境；plan 真实 Agent E2E；全写路径 fencing；24h 长窗口；质量引擎自动 clause 判定。
