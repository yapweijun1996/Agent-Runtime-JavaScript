# agrun Production Roadmap — 让终端用户反馈更快（2026-07-02）

> **SSOT 说明**：任务追踪的唯一真相仍是 `task.jsonl`，长期设计决策在 `agrun_docs/adr/`。
> 本文件是**人类可读的单页汇总**，把 2026-07-02 的 production-latency review 结论整理成可逐步执行的清单。
> 每完成一步：更新本文件的 checkbox + 在 `task.jsonl` 记录对应任务条目。

## 0. 问题定义（Why）

终端用户反馈"等太久、体验不好"。经实测（不是猜测），慢的原因有 3 个：

| # | 根因 | 证据 |
|---|------|------|
| 1 | **每回合 prompt 太大**：trivial turn 用 5465 tokens，OpenAI Agents SDK 只用 101（54 倍差距，2.6 倍 wall-clock） | `agrun_docs/audits/agrun-vs-openai-agents-sdk-benchmark-2026-07-02.md`（AGRUN-564） |
| 2 | **每回合 LLM 往返次数多**：planner 1 次 + finalize 1 次 + terminal-repair 0~N 次 = 2~5 次；OpenAI SDK 是 1 次 | `src/runtime/planner.js`、`src/runtime/runtime-finalize.js` |
| 3 | **前端没有消费 streaming 事件**：runtime 已支持 `onToken` / `onReasoning` / `phase-*` / `tool_start`，但如果宿主 UI 等整个 run 结束才渲染，用户就感觉"卡死" | `src/runtime/run-event-stream.js`、`src/runtime/runtime-finalize.js:17` |

已完成的第一刀：**ADR-0057 Phase 0+1**（AGRUN-566，commit `b9ec59799`）——
`deferredNamespaces: ["workspace"]` 实测省 28.1% input tokens、快 12.5%。opt-in，默认关闭。

---

## Phase A — 体感最快的改善：宿主 UI 全面消费 streaming（零 runtime 风险）

目标：用户在 **1 秒内**看到反馈（Thinking → 工具进度 → 逐字答案）。

- [x] A1. browser example 聊天 UI 确认三层渲染全部接上：
      `onReasoning`（Thinking 面板，AGRUN-549 已有）、`tool_start` / `phase-*`（进度条/spinner）、`onToken`（finalize 逐字输出）。
      ✅ 2026-07-02 验证：`examples/browser/src/hooks/chat-turns.ts:331-333` 三个回调都已接上。
- [x] A2. Node SSE 参考服务器（`examples/node-runtime-sse-server.cjs`）确认把 reasoning/token 事件即时转发，不缓冲到 run 结束。
      ✅ 2026-07-02 验证：`node/runtime-sse-adapter.js:24-26` 是 `subscribeEvents` → 即时 `res.write`，无缓冲；
      `provider-text-delta` / `provider-reasoning-delta` 事件在 ledger 流里（live 实测 phase 事件 5ms 到达）。
- [x] A-BUG（本 Phase live 验证时发现并修复，AGRUN-568）：`planner_final` 终端路径（最常见的简单问答路径）
      **从不调用 `onToken`** —— `direct_final` 和 plan 路径都有 `onToken(output.text)`，唯独 `handlePlannerFinal` 漏了
      （dispatch-parity 违规）。修复：`action-loop-terminal.js` + `action-loop-session-terminals.js` 补上同款调用 + 单测。
      Live 实测修复后 `onToken` 在答案就绪当刻（5369ms）触发，修复前整个 run（10.6s）0 次触发。
- [ ] A3. 在 `agrun_docs/webui-integration-contract.md` 写清楚"宿主必须消费哪些事件才有好体验"（host 集成检查清单）。
- 验收：live e2e 里，从发送消息到第一个可见反馈 < 1s（不含网络冷启动）。
  ⚠️ 已知残留：envelope planner 模式下，planner 生成期间（本次实测 13ms→5356ms）没有可渲染的正文流
  （text-delta 是原始 JSON envelope，不能直接给用户看；gpt-5-mini 无 reasoning delta 输出）。
  宿主该窗口只能显示 phase 进度。真正消除要靠 Phase B（更小 prompt → 更快 planner）和 C2（简单回合合并 planner+finalize）。

## Phase B — 砍掉剩余的每回合固定 prompt 开销（每一回合都受益）

Phase 0+1 之后 prompt 里还剩这些**无条件**的大块（数字来自 AGRUN-564 实测的 24620 字符请求）：

| 目标 | 大小 | 现状 |
|------|------|------|
| `src/prompts/planner-compact-directives.js` | 5940 字符（24.1%） | 完全没有 `hasAction()` 条件门 |
| Loop-state JSON（34 个 key，多数空闲） | 3515 字符（14.3%） | 全量输出 |
| 固定 envelope 格式说明 | 1816 字符（7.4%） | 部分可条件化 |

- [x] B1. 给 `planner-compact-directives.js` 加条件门（只在相关子系统激活时输出对应段落）。
      ✅ 2026-07-02 完成（AGRUN-569）：新增 `src/runtime/prompts/planner-directive-gates.js`，base + compact 两个模式的
      "If loopState.X…" 建议行按信号是否激活门控（复用 loopState JSON 的同一批 summarizer 作 SSOT；无 runState 时全开，
      默认导出字节不变）。实测（gpt-5-mini × 3，minimal tier）：5130 → 4297 tokens（-16.2%）；
      与 ADR-0057 deferred workspace 叠加：**2857 tokens（比默认省 44.3%）**，全部 completed。
- [x] B2. Loop-state JSON 瘦身：空闲/默认值的 key 不输出（保持 AI-first：只是不重复"无事发生"，不是隐藏信息）。
      ✅ 2026-07-02 完成（AGRUN-570）：`planner-prompt.js` 序列化前经 `pruneLoopStateForPrompt`（显式白名单，
      只剪 20 个休眠信号 key；被常开指令引用的 readSources/searchResults/toolContext/deniedActions 永不剪）。
      空闲回合 loopState JSON：~3515 → 233 字符。实测：默认配置 4297 → 3758 tokens；
      三项叠加（B1+B2+deferred workspace）：**2318 tokens（比原基线 5130 省 54.8%）**，
      已逼近"全部禁用"的理论下限 2335，且所有能力保留。
- [ ] B3. ADR-0057 **Phase 2**：research + todo namespace 也支持 deferred（workspace 模式已验证可复制）。
- [ ] B4. ADR-0057 **Phase 3**：opened namespace 跨 continuation turn 携带（用 `todoState` 的 thread-hydration 模式）；收集 live open-rate 数据后决定是否 default-on。
- 验收：minimal-tier benchmark（`examples/agent-sdk-benchmark/`）重跑，input tokens 从 3690 再往下，功能无回归（`npm run check` 通过 + prompt-snapshot 测试）。

## Phase C — 减少 wall-clock：并发工具执行 + 减少 LLM 往返

- [x] C1. ~~把 `createStreamingActionExecutor` 接入 plan 路径~~ → **实测判定：不做（AGRUN-571）**。
      2026-07-02 live 测量（agentic tier，gpt-5-mini，28.8s 全回合）：工具执行合计 0.25s（0.9%），
      LLM 调用占 99%；plan 路径本就 8 路并行（`runWithConcurrency`，maxPlanParallel=8），
      且 plan 验证只放行非 mutating action——executor 的 barrier/sibling-abort 语义在此无用武之地。
      AGRUN-443 的 30-60% 预估只在"LLM 流式输出期间提前启动 action"场景成立（高复杂度低收益，
      与 AGRUN-442 native-yield 同理由搁置）。真正的发现（转入 C2/C1b）：
      ① `planner_finalize` 触发**独立的 finalize LLM 调用（本次 11.6s，占 40%）**；
      ② 两个独立 lookup 模型没用 `type:plan`，多花一轮 planner 往返（~3-5s）。
- [ ] C1b. 提高 plan envelope 采用率：独立工具调用应一次 plan 并行完成（prompt 指引层，先 A/B 验证）。
- [ ] C2. **【最高优先，实测占回合 40%】**"planner + finalize 合并"：directive 教模型工具证据回合用 finalize
      （= 再发一次完整 LLM 调用重新生成答案，实测 11.6s）；评估让短答案回合直接 `final`（答案内联，零额外调用），
      或 finalize 调用复用上下文缓存。先 A/B 测收敛质量再改。
- [~] C3. 重新评估 ADR-0031 → **spike 已完成（AGRUN-573），判定：先修缺口，不能直接翻默认**。
      Live A/B（gpt-5-mini×3/格）：native 现状比 envelope 慢 1.7-2.9 倍、agentic 正确率 1/3（envelope 2/3）；
      根因 = `toolChoice:"required"` 禁止无工具回答 + 只消费 `toolCalls[0]` → lookup_order 连调 8 次到 maxSteps 失败。
      修复顺序（然后重跑 A/B，双赢才翻默认）：
      - [x] C3a. `toolChoice:"auto"` + 无工具文本响应即答案 ✅ 2026-07-02（AGRUN-574）。
            重跑 A/B（gpt-5-mini×3/格）：minimal native **3537ms**（envelope 5029ms，快 30%）；
            agentic native **11502ms、3/3 正确、0 次独立 finalize**（envelope 19473ms；修复前 native 60706ms/1/3）。
            native 模式现在比 envelope 快 30-41% 且全对——C3b/C3c 完成后可正式评估翻默认。
      - [x] C3b. 消费整个 toolCalls 数组 ✅ 2026-07-02（AGRUN-575）：多个纯 action 调用合成一个
            标准 plan decision（复用 plan 门的验证/并发/超时/顺序副作用；partial_ok=true 对齐
            native 并行语义；混入 terminal/clarify/plan 则维持首调用决定）。Live A/B：agentic
            planner 调用 3/3/3 → **2/2/2**，native 13.7s vs envelope 17.7s，3/3 正确，0 独立 finalize。
      - [x] 跨 provider A/B ✅ 2026-07-02（AGRUN-576）：native 全胜或打平——gemini agentic -30%、
            deepseek agentic **-48%（3 调用→2，parallel batch 真实触发）**、openai -23%；全部 correct、
            nativeFallbacks=0。ADR-0031 当年的 "Gemini native 不稳定" 未复现（gemini native 是全场最快）。
            **建议：起草新 ADR 取代 ADR-0031（auto→native_tools，fallback_to_envelope 兜底）。**
      - [x] **ADR-0058 已批准并实施** ✅ 2026-07-02（AGRUN-579）：`auto` → `native_tools`
            （`reason: default_native_tools`），resolver 保持 provider 无关；实施中顺带修了一个真实
            安全缺口（native 失败回退 step 的错误消息未脱敏，可能带出 Authorization 头）。
            全量测试 exit 0（4 个 envelope 机制专属测试显式钉到 `plannerMode:"envelope"`）；
            live 验证默认配置解析 native、minimal+agentic 完成且正确、0 回退。
      - [x] 长报告 native gate ✅ 2026-07-02（AGRUN-577）：openai native 34.6s/1543 词/1 次调用完成
            （envelope 171.7s/7 次/1231 词，native 快 5 倍）；gemini 两模式同样触底（能力下限，非 native 回归），
            AGRUN-553 兜底在 native 下正确触发。**ADR-0058 已起草（PROPOSED），等 maintainer 批准后实施翻转。**
      - [x] C3c. native 直接答案逐字流式 ✅ 2026-07-02（AGRUN-585）：onToken 经 session→planner→native door
            线程化；createStreamFence + 首字符闸（`{`/反引号开头永久关闭外发）防 JSON 泄漏；
            `decision.answerStreamed` 让 planner_final 终端跳过一次性 onToken（零重复）。
            顺带修复一个真实潜伏 bug：gemini 流式路径 extractToolCalls **双重映射**把所有 tool call 名字清空
            （流式+工具的 gemini 回合会循环到 maxSteps 失败）。3-provider live：gemini agentic **首字 1.9s**、
            openai/gemini 全绿、deepseek 4/5（1 次模型重复循环触底，模型行为方差非 runtime 回归）。
      依据：agrun_docs/audits/why-other-agents-feel-fast-2026-07-02.md §6（AGRUN-572/573）。
- [x] C5a. native 模式按需提供 `plan` 工具 ✅ 2026-07-02（AGRUN-582）：无 bundled skills / 无已发现
      skill 目录 / 无激活 research 流程时抑制（并行能力已由原生 parallel tool_calls 覆盖，零能力损失；
      skill/research 场景自动保留）。注意：`agentSkillIndexProvider` 不能当信号——默认配置恒有内存 provider。
- [x] C5b. finalReadiness schema 描述精简 ✅ 2026-07-02（AGRUN-582）：字段与语义不变，砍冗长散文。
      合计实测（3 provider live，agentic）：请求体积 ~45.7KB → ~37.4KB（-18%），input tokens
      openai 7687→6353 / gemini 10245→8348 / deepseek 10745→8802（-17~19%），plan 工具在三家 wire 上
      均确认消失，全部 completed + 正确。静态工具面：28.2KB → 20.0KB（-29%，无 skill 场景）。
- [x] C4. Cache 对齐的 prompt 布局 ✅ 2026-07-02（AGRUN-583）：user 消息重排为 稳定头（User request /
      session context / Available actions / skill tools）→ 追加中段（Action history）→ 易变尾
      （Plan state / workspace / Normalization / Loop state JSON，兼得 recency 注意力位置）；
      repair/focused 块保留在最前（只在修复期出现，注意力优先于缓存）。
      Nonce 隔离的 before/after 实测（agentic）：OpenAI cycle-2 未缓存尾 2709 → **1685 tokens（-38%）**，
      正好多命中一个 1024-token 缓存块；gemini/deepseek 本轮中性；3 provider 全部 completed 无回归。
      注意：确定性 benchmark 会被跨 run 缓存污染——测缓存必须用唯一 nonce prompt。
- [ ] C3. **AGRUN-442** 后续：AsyncGenerator loop（runStream slice 1 已 ship）剩余 slices 按 task.jsonl 推进。
- 验收：agentic-tier benchmark wall-clock 从 15.6s 显著下降；abort 语义不回归（runstream-consumer smoke test 通过）。

## Phase D — Node.js production 加固（上线前必查）

来自 2026-06-25 production review（无 blocker，但有条件项）：

- [x] D1. **apiKey 安全**：已写成 [production-deployment.md](./production-deployment.md)（2026-07-03，AGRUN-592）——三种部署形态（authMode server 代理 / gateway token / user-bring-own-key）+ 生产 chat 配置清单（实测 117s→20.9s，反超 OpenAI Agents SDK 32.9s）+ 长任务暂停语义 + 监控接法。
- [x] D2. `session.actionHistory` 可选上限（2026-07-03，AGRUN-598）：`createRuntime({ actionHistoryLimit })`，循环边界原地裁剪最旧条目 + 压缩游标同步平移 + `action-history-trimmed` 步骤；默认 null 零行为变化。
- [x] D3. ESM 入口早已存在且已验证（2026-07-03）：`dist/esm/index.js`（117 导出 import 实测通过），package.json `module`/`exports.import`/`sideEffects:false` 齐备；补 `dist/esm/package.json {type:module}` 消掉 Node 重解析警告。
- [x] D4. （a）cycleRecord guard：前提已被 AGRUN-400 证伪（blocked cycle 留 null 本就正确），无需改动；（b）web-search endpoint scheme 校验已做（2026-07-03）：非 http/https（file:/javascript:/data:）与非法 URL 在 fetch 前即拒并给出清晰报错。
- [x] D5. 默认 model ID（gpt-5.4-mini/gpt-5-mini/gemini-3.1-flash-lite/deepseek-v4-flash）经 2026-07-03 全天数百次真实 API 调用 de facto 核实存在；部署核对步骤已写入 production-deployment.md §3。

## 已有的 production 基础（不用重做，验证过存在）

- Provider 重试 + 线性退避：`src/runtime/provider-retry.js`（非流式路径；流式故意不重试）
- 完整取消：`abortSignal` 贯穿 `runtime.run` / `session.runStream`，generator.return() 即中止
- 崩溃恢复：`exportState()` / `importState()` 版本化信封（`run-state-portable.js`）
- 上下文压缩：`action-history-compaction.js`（protected head/tail，storage 与 projection 分离）
- Per-action timeout：两条 dispatch 路径都覆盖（30s 默认）
- 事件账本有界：`runtime-event-ledger.js` DEFAULT_MAX_EVENTS=10000

## 关联任务 / 文档索引

| 项 | 位置 |
|----|------|
| Benchmark 报告（根因量化） | `agrun_docs/audits/agrun-vs-openai-agents-sdk-benchmark-2026-07-02.md`（AGRUN-564） |
| Deferred loading 设计（Phase 2/3 规格） | `agrun_docs/adr/0057-deferred-action-loading.md`（AGRUN-565/566） |
| 并发执行器 | AGRUN-443（planned, P2） |
| AsyncGenerator loop | AGRUN-442（slice 1 shipped, 后续 planned） |
| 复杂任务收敛 | AGRUN-539~553（大部分 implemented；lite 模型是能力下限问题，非 runtime bug） |
| 微内核长期方向 | AGRUN-313 / ADR-0052（DEFERRED，先做 prompt 瘦身） |

**执行顺序建议：A → B1/B2 → B3 → C1 → D（上线前）→ B4/C2/C3。**
