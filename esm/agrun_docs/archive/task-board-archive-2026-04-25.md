# agrun.js Task Board

## Project Summary
agrun.js — 纯 vanilla JS 零依赖通用 Agent Runtime，**纯前端运行**（Browser-only，不依赖 Node.js server）。
核心架构：OODAE 循环 + Planner 护栏 + 研究续行机制 + 双模式 Planner（envelope / native tools）+ Agent Roles。
当前状态：架构扎实（src ~18.1K LOC, dist UMD ~1.7 MB, 33 live test scenarios, 7 actions），Phase 1-2 大部分完成，新增 Roles + Memory + AI SDK 迁移 + Fetch Resilience + Global Memory Kill Switch + Runtime Hardening Batch + Planner Alias/onBeforeFinalize 强化 + **P0 Loop Convergence**（AGRUN-141 composite budget + fingerprint）。
**代码审查发现（2026-04-22 刷新）**：**22 个文件**仍超 300 行（最大 528 行，session-loop / skill-tool-action / action-loop-action 三巨头超 400 行）、测试单文件 5440 行需拆分。API Key 安全由 host backend 负责（见 agrun_docs/spec.md Production Deployment Model）。

### 架构约束
- **Frontend-only** — agrun.js 完全在浏览器中运行，不需要 Node.js 后端。
- **No MCP** — 不支持 MCP 协议（MCP 需要 stdio/server-side transport，与 frontend-only 架构不兼容）。
- **Minimal dependency** — LLM provider 层使用 Vercel AI SDK (`ai` + `@ai-sdk/google` + `@ai-sdk/openai`)，通过 rollup 打包进单文件 `dist/agrun.js`（~1.6 MB UMD），运行时零外部依赖。
- **Provider-agnostic** — 通过 AI SDK 统一调用 OpenAI / Gemini API，不经过中间服务器。

### 已发现并修复的问题
- ~~**Gemini native_tools 兼容性**~~ — 已修复（AGRUN-111）。Root cause: `toGeminiSchema()` 缺少 ARRAY 类型的 `items` 字段。
- ~~**Disabled action 仍被执行**~~ — 已修复（AGRUN-112）。Root cause: `research-continuation.js` 硬编码 `read_url`，`action-loop-session.js` continuity decision 绕过 disabled actions 过滤。
- ~~**Disabled read_url 仍触发 approval**~~ — 已修复（AGRUN-114）。Root cause: `approval.js` 未传递 `disabledActions` 给 `createActionLoopSession`，导致 approval 后续循环所有 action 可用；planner 系统提示词硬编码 `read_url` 诱导 LLM 选择已禁用的 action。
- ~~**Role 只能 build-time 打包**~~ — 已修复（AGRUN-113）。新增 `parseRoleMarkdown()` 支持运行时从文件/fetch 加载 ROLE.md。
- ~~**Global memory 无 kill switch**~~ — 已修复（AGRUN-115）。新增 `globalMemory.enabled`（默认 `true`）。设为 `false` 时跳过 per-turn 语义抽取 LLM 调用、跳过 `readAllGlobalMemory()` 注入、跳过 promotion 写入；per-session memory 不受影响。详见 [agrun_docs/public-runtime-api.md](../public-runtime-api.md#disabling-global-memory)。
- ~~**消费方需要单一 usage 文档**~~ — 已修复（AGRUN-116）。新增 `build/usage-doc-plugin.cjs`，`npm run build` 时把 `README.md` + `agrun_docs/usage-quickstart.md` + `agrun_docs/feature-toggles.md` + `agrun_docs/public-runtime-api.md` + `agrun_docs/result-schema.md` 合并输出到 `dist/agrun.md`，附 build id + TOC + 内部锚点 / GitHub 绝对 URL 双轨链接重写 + Quickstart 顶部导引。
- ~~**首次使用工程师没有 quickstart / 概念表 / 真 chatbot 例子**~~ — 已修复（AGRUN-117）。新增 [agrun_docs/usage-quickstart.md](../usage-quickstart.md)（"agrun.js 是什么" + 9-term 术语表 + Hello World + 25 行 OpenAI chatbot + 加 web search / approval / 关 memory + when-to-use 表 + Common Errors 表）+ [agrun_docs/feature-toggles.md](../feature-toggles.md)（所有 enable/disable 旋钮单页参考）。两份都进 `dist/agrun.md` bundle。
- ~~**Runtime hardening batch（JSON 解析 / IndexedDB 降级 / Approval token 签名 / 敏感内容过滤）**~~ — 已修复（AGRUN-118）。四项一并落地，见 [agrun_docs/adr/0001-runtime-hardening-batch.md](../adr/0001-runtime-hardening-batch.md)：
  - `parseLooseJsonValue()` 改用 `extractBalancedJson()` 深度感知/字符串感知平衡括号解析；`normalizePlanActions()` 单个非法 action 跳过不再丢整个 plan；新增可选 `action.planner.argsSchema` + `validateActionArgs()` hook。
  - `createSessionStore()` 内置 `createResilientSessionStore()`，IndexedDB 在 `QuotaExceededError` / `InvalidStateError` / `SecurityError` / `NotAllowedError` / `VersionError` 时单向降级到 `InMemorySessionStore` 并回调 `onStorageDegraded`。
  - 新增 `approvalSigning` 配置 + `createApprovalSigner()`，对 resume token 做 HMAC-SHA256 签名 + nonce 防重放 + TTL（默认 15 min）+ 可选 `enforceSessionBinding`。Web Crypto 缺失时降级到 nonce+TTL 并触发 `onDegraded`。默认关闭保持向后兼容。
  - `SENSITIVE_PATTERNS` 扩充到 15 条（`AIza`、`sk-ant-`、`ghp_/gho_/…`、`AKIA`、`ya29.`、JWT、PEM、`x-api-key`、`authorization:` 等），`containsSensitiveContent()` 递归扫描对象/数组叶子 + `SENSITIVE_KEY_NAMES` 阻挡敏感键名。
  - 单测：[semantic-json.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/semantic-json.test.js)、[approval-signing.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/approval-signing.test.js)、[store-resilient.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/store-resilient.test.js)、[global-memory-sensitive.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/global-memory-sensitive.test.js) —— 共 50+ 断言全绿。

### 已发现但尚未修复的问题（Long-Running & Multi-Topic）
- **长任务 / 多 topic 对话结构性问题** — 设计层面，见 [agrun_docs/long-running-multi-topic-tasks.md](../long-running-multi-topic-tasks.md) + [ADR 0002](../adr/0002-long-running-multi-topic-architecture.md)。拆分为 AGRUN-141~AGRUN-146 六个增量 ticket：
  - ~~**无限 retry loop**~~ — **已修复（AGRUN-141, 2026-04-22）**：新增 `session-budget.js` 复合预算（`totalFailures=5` / `invalidDecisions=3` / `sameFingerprintRepeats=2` / `cyclesSinceProgress=5`）+ `action-fingerprint.js`，breach 时 force finalize 附可读文案；旧 `MAX_CONSECUTIVE_ACTION_FAILURES=2` 保留为 subset。
  - ~~**长任务迷失方向**~~ — **已修复（AGRUN-142, 2026-04-22）**：三层 goal-anchor 模型（L1 `runState.originalQuery` · L2 `thread.goalAnchor.text` · L3 `turnState.goalAnchorText`），`captureOriginalQuery` session ctor 处 seed 一次 immutable；`buildPlannerSystemPrompt` 在 `roleBlock` 与 `dynamicSystemPrompt` 之间注入 `[ORIGINAL USER QUERY — DO NOT REINTERPRET]` + `[GOAL ANCHOR]` 栅栏块（prompt-cache 友好），`runtime-finalize.js` 同步注入；`runtimeConfig.goalAnchor.enabled:false` 降级为 byte-identical legacy 输出。
  - ~~**Finalizer 幻觉 / 引用 planner 没看过的证据**~~ — **MVP 已修复（AGRUN-143, 2026-04-22）**：`normalizeEvidenceItem` 扩 `{id, threadId, turnId, source, supersededBy}` + `confidence` default 0.5，`classifySessionMemoryEntries` 自动清理 implicit / explicit supersede；新增 `filterEvidenceByScope` + `filterSourcesByEvidence` 工具；action-loop-terminal 三处 citation 汇集点统一走 `collectScopedFinalResponseSources(runState)`，读取 `runState.scopedEvidenceUrls` 白名单 —— AGRUN-144 落 topic router 时自动激活裁剪。
  - **多 topic 交叉污染** — Session 单线程，`runState` 全局，`evidence.js` / `toolContext.history` / `semantic-recall` 无 `threadId` 隔离；用户 pivot 到新 topic 时 A 的证据会污染 B。→ AGRUN-144
  - **压缩不感知 topic / 压缩后 toolContext 仍是原始大小** — [compaction.js:58](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js#L58) 按 sessionId 分组压缩 summary，且不同步裁剪 `runState.toolContext.history` / `researchContext.readSources`。→ AGRUN-145
  - ~~**无 drift detection**~~ — **已修复（AGRUN-146, 2026-04-22）**：新增 `drift-detector.js` 每 N cycle（默认 5）比较 `turnState.goalAnchorText` 与最近 N 条 `actionHistory` 的 Jaccard 相似度（复用 `tokenizeTopicText` + topic-scoring），severe <0.4 → force_replan reminder，mild 0.4-0.7 → inject_reminder，≥0.7 无动作；`runtimeConfig.driftDetection.similarityFn` 作为 pluggable hook（embedding 等）。默认 disabled；一次性 `runState.driftSignal` slot 被 planner 消费后立即清空，不滚雪球。

---

## Epic: Production Readiness

### AGRUN-101 | Live Test Coverage Expansion (Epic)
| Field | Value |
|-------|-------|
| Type | Epic |
| Priority | Critical |
| Status | **Done** |
| Sprint | Phase 1 |
| Story Points | 26 |
| Labels | quality, foundation |

**Result:** 从 11 个 live scenarios 扩展到 33 个，覆盖 search / planner / session / approval / skills 全部关键路径。

| Sub-task | Scenarios | Status |
|----------|-----------|--------|
| 101a Search | 7 (searxng-direct, gemini-grounding, entity-lookup x2, multi-pass, finalize x2) | Done |
| 101b Planner | 6 (envelope, native-tools x2, direct-answer, native-search x2) | Done |
| 101c Session | 3 (3-turn-recall x2, memory-slot-update) | Done |
| 101d Approval | 3 new (gemini-approve, gemini-deny, chained-approvals) | Done |
| 101e Skills | 3 new (gemini-skill-flow, complex-input, gemini-news-brief) | Done |

**Run:** `npm run build && npm run test:live` (33/33 PASS)

---

### AGRUN-103 | Persistent Memory System
| Field | Value |
|-------|-------|
| Type | Feature |
| Priority | High |
| Status | **Done** |
| Sprint | Phase 2 |
| Story Points | 8 |
| Labels | core, ux |

**Summary:** 跨 session 持久化记忆系统 — IndexedDB 全局 memory + 自动提升 + Browser UI 管理。

**Implementation:**
- IndexedDB `globalMemory` object store (DB v1→v2)，4 methods: append/readAll/delete/clearAll
- `src/session/global-memory.js`: 分类映射、候选过滤、敏感内容检测、合并去重、自动提升
- Session handle 每轮加载全局 memory + 高置信度条目自动提升（>=0.7, slot 去重, 100 条上限）
- Settings → Memory tab: 按分类展示、删除单条、清空全部
- 敏感内容过滤：api_key/password/token/bearer/sk- 不进入全局 memory

**Acceptance Criteria:**
- [x] IndexedDB memory store 接口（支持自定义 backend via store-memory.js）
- [x] Memory 分类：user_preference / project_context / learned_fact
- [x] Memory 合并注入到 planner context snapshot（通过 mergeGlobalIntoSessionMemory）
- [x] 跨 session 可召回用户偏好和项目上下文
- [x] 用户可清除所有 memory（Settings → Memory → Clear All）
- [x] Memory 内容不包含 API key 或敏感凭证（containsSensitiveContent 过滤）
- [x] Browser UI memory 管理界面（MemorySettingsPanel）

---

### AGRUN-104 | Token-Level Streaming
| Field | Value |
|-------|-------|
| Type | Feature |
| Priority | High |
| Status | **Done** (AGRUN-129: finalize streaming + browser UI wired) |
| Sprint | Phase 2 |
| Assignee | Unassigned |
| Story Points | 8 |
| Labels | ux, performance |

**Summary:** 实现 token-level streaming，使用户在 finalize 阶段可以看到逐字输出。

**Why (Justification):**
- 当前用户体验是"等很久 → 一次性出现完整答案"，感知延迟大。
- 复杂查询可能需要 10-30 秒，没有中间反馈用户会以为卡住了。
- ChatGPT、Claude、Gemini 等产品都有打字机效果，用户已形成期望。

**Benefit:**
- 感知速度：用户在第一个 token 出现时就知道 agent 在工作，减少焦虑。
- 交互体验：打字机效果让对话感更自然，提升产品品质。
- 早期中断：用户看到方向不对可以提前取消，节省 token 消耗。

**Acceptance Criteria:**
- [x] Provider 层支持 streaming response（AI SDK `streamText()` for OpenAI + Gemini）
- [x] Runtime 层支持 streaming 中间结果透传（`onToken` callback 从入口到 finalize）
- [x] Browser 层支持逐 token 渲染（`streamedText` 注入 message parts）
- [x] Action 执行期间不 stream，finalize 时 stream（与 OODAE 循环兼容）
- [x] 不破坏现有 step callback 机制
- [ ] Streaming 函数加单元测试覆盖（当前 `requestGeminiContentStreaming` / `requestOpenAIChatCompletionStreaming` 未被测试）
- [ ] 删除废弃的 `sse-parser.js`（AI SDK 迁移后不再需要手动 SSE 解析）

**Architecture Decision (2026-04-08, revised):**

最初计划用 raw fetch + 手动 SSE 解析。后迁移 provider 层到 Vercel AI SDK，streaming 改用 `streamText()` + `textStream` async iterator。核心设计不变：

1. **采用 AI SDK** — `ai` + `@ai-sdk/openai` + `@ai-sdk/google`，provider 层用 `generateText()` / `streamText()`
2. **只在 finalize stream** — OODAE 离散模型不变，planner/action 输出是结构化 JSON，stream 无意义
3. **用 callback（`onToken`）而非 AsyncIterable** — 与现有 `onStep` 回调模式一致，`runtime.run()` 返回值不变
4. **AbortController 取消** — AI SDK 原生支持 `abortSignal`

**Implementation Layers:**

| Layer | Files | Change |
|-------|-------|--------|
| Provider | `openai-browser.js`, `gemini-browser.js` | `generateText()` + `streamText()` via AI SDK |
| Runtime | `provider.js`, `runtime-finalize.js` | `onToken` 判断走 streaming 或 blocking |
| Threading | `action-loop-session.js`, `runtime.js`, `handle.js` | `onToken` 从入口透传到 finalize |
| Browser | `agent.ts`, `chat-turns.ts`, `chat-turn-assistant-state.ts` | Token 累积器 + `streamedText` 注入 message |

**Reference docs:** `agrun_docs/spec.md` (Streaming section), `agrun_docs/learnings-from-sample-projects.md` (#15)

---

### AGRUN-105 | Error Recovery Enhancement
| Field | Value |
|-------|-------|
| Type | Improvement |
| Priority | Medium |
| Status | **Done** |
| Sprint | Phase 3 |
| Assignee | Unassigned |
| Story Points | 5 |
| Labels | reliability, core |

**Summary:** 增加系统级容错机制：retry with backoff、circuit breaker、graceful degradation。

**Why (Justification):**
- 当前 provider API 调用失败会直接中断整个 turn，没有重试机制。
- 网络抖动、API rate limit、临时故障都会导致用户看到错误页面。

**Benefit:**
- 可靠性：临时网络故障不会导致整个对话中断，自动重试恢复。
- 降级能力：web_search 失败时可以基于已有证据给出答案，而不是直接报错。

**Acceptance Criteria:**
- [x] LLM 自我纠正：action 失败时错误反馈给 planner（AGRUN-108 已完成）
- [x] 实现 retry with exponential backoff — `fetchWithRetry()` in `fetch-resilience.js`，LLM 60s/1 retry，Search 15s/1 retry，URL 10s/1 retry
- [x] 实现 graceful degradation — web_search 多轮超时保留已有结果；consecutive failure guard 强制 finalize
- [x] Action 执行超时保护 — `withDeadline(45s)` for web_search 多轮循环，`AbortController` for 所有 fetch
- [x] 连续同一 action 失败 2 次强制 finalize（`action-loop-session-loop.js` consecutive failure guard）
- [x] read_url timeout/fetch_failed 自动重试 1 次（`read-url-action.js`）
- [x] 实现 circuit breaker — `createCircuitBreaker()` in `fetch-resilience.js`, per-provider tracking (CLOSED→OPEN→HALF_OPEN), `createRuntime({ circuitBreaker: true })`, planner catches `CIRCUIT_OPEN` → force finalize

---

### AGRUN-106 | Observability & Structured Logging
| Field | Value |
|-------|-------|
| Type | Improvement |
| Priority | Low |
| Status | To Do |
| Sprint | Phase 3 |
| Assignee | Unassigned |
| Story Points | 5 |
| Labels | ops, monitoring |

**Summary:** 增加可观测性：structured logging、metrics 采集。

**Why (Justification):**
- 当前 steps 记录够调试，但无法被监控系统消费。
- 需要知道：哪些 action 最慢、planner 调用了多少次、token 消耗多少。

**Benefit:**
- 性能优化：基于 metrics 数据识别瓶颈。
- 调试能力：结构化日志可以在 browser console 中按类型过滤。

**Acceptance Criteria:**
- [ ] 支持 structured logging（browser console 分级输出）
- [ ] 支持 metrics 采集（action 执行时间、planner 调用次数、token 消耗）
- [ ] 每个 OODAE cycle 可输出结构化日志
- [ ] 零配置时不产生额外开销（opt-in）

---

### AGRUN-116 | Refactor Oversized Files (300-Line Rule)
| Field | Value |
|-------|-------|
| Type | Refactor |
| Priority | High |
| Status | **Phase A Done**（Phase B 回退：新增功能后 22 个文件超标，最大 528 行） |
| Sprint | Phase 2-3 |
| Story Points | 13 |
| Labels | tech-debt, maintainability |

**Summary:** 原 16 个文件超过 AGENTS.md 规定的 300 行上限，最大 869 行。Phase A 已完成最大文件拆分；之后 session-loop / skill-tool-action / alias / onBeforeFinalize 等增量让超标文件反弹到 **22 个**（2026-04-22 重新统计），需启动 Phase B。

**Phase A 完成 — `action-loop-session.js` 拆分（869 → 73 行）：**
| 新文件 | 职责 |
|--------|------|
| `action-loop-session.js` | 73 行，session 创建入口 |
| `action-loop-session-loop.js` | 528 行，主循环 + consecutive failure guard（已反弹） |
| `action-loop-session-cycle.js` | cycle 管理 |
| `action-loop-session-guardrails.js` | planner 护栏 |
| `action-loop-action-context.js` | action context sync |

**剩余超标文件（2026-04-22 重新统计，22 个，Phase B 重点对象）：**
| File | Lines | 优先拆分 |
|------|-------|---------|
| `runtime/action-loop-session-loop.js` | 528 | ★ Top |
| `runtime/actions/execute-skill-tool-action.js` | 446 | ★ Top |
| `runtime/action-loop-action.js` | 426 | ★ Top |
| `runtime/planner-repair.js` | 393 | |
| `runtime/action-loop-terminal.js` | 393 | |
| `session/compaction.js` | 372 | |
| `skills/providers/fetch-resilience.js` | 342 | |
| `session/handle.js` | 341 | |
| `session/global-memory.js` | 339 | |
| `runtime/planner-tools.js` | 335 | |
| `session/evidence.js` | 332 | |
| `runtime/action-loop-plan-synthesize.js` | 332 | |
| `runtime/research-continuation.js` | 330 | |
| `session/context-window-plan.js` | 324 | |
| `runtime/approval-state.js` | 322 | |
| `runtime/planner-prompt.js` | 321 | |
| `skills/providers/web-search-planner.js` | 319 | |
| `skills/providers/web-search-ranking.js` | 316 | |
| `skills/providers/request.js` | 316 | |
| `runtime/action-loop-plan.js` | 314 | |
| `runtime/approval.js` | 313 | |
| `runtime/planner.js` | 310 | |

**Acceptance Criteria:**
- [x] Phase A: 拆分 `action-loop-session.js`（869→73 + 4 个子模块）
- [ ] Phase B: 剩余 22 个超标文件逐步拆分（先攻 400+ 三巨头：session-loop / skill-tool-action / action）
- [x] 所有 smoke test 和 live test 仍然 PASS
- [x] 不改变公共 API

---

### AGRUN-117 | Fix approval.js request mutation
| Field | Value |
|-------|-------|
| Type | Bug |
| Priority | Low |
| Status | **Done** |
| Sprint | Phase 3 |
| Story Points | 1 |
| Labels | bug, core |

**Summary:** `approval.js:262` 直接 `delete request.type` 修改了调用方传入的原始 request 对象。

**Re-evaluation (2026-04-08 code review):**
- ~~`action-loop-action.js:276-281` inquiryContext mutation~~ — **误报**：`normalizeInquiryContext()` 始终返回新对象（对象字面量 `return { ... }`），不污染 snapshot。
- ~~`undefined` vs `null` 不一致~~ — **有意为之**：内部 helper 返回 `undefined` 使可选字段在 JSON 序列化时自动省略，行为正确。
- ~~`approval.js:262 delete request.type`~~ — **已修复**：`delete` 改为赋值 `null`，避免 JS 引擎 deopt 且保持相同语义。

**Fix:** `delete request.type` → `request.type = null`。顺序不变（clear 在 consume 之前是有意设计，确保 `requestTypeAfterApproval` 为 `null`）。

---

### AGRUN-118 | Split and Organize Test Suite
| Field | Value |
|-------|-------|
| Type | Improvement |
| Priority | Medium |
| Status | In Progress |
| Sprint | Phase 3 |
| Story Points | 5 |
| Labels | quality, test |

**Summary:** `smoke.test.js` 5440 行单文件，需拆分为模块化测试套件。

**Phase A — Mock compatibility (Done):**
All smoke tests were broken after the AI SDK migration + AI-first refactor. Fixed:
- [x] `openai-browser.js`: `openai.chat()` targets `/v1/chat/completions` (not `/v1/responses` Responses API)
- [x] Mock infrastructure: iterable headers, `choices[].index`, data URL handler, multimodal content normalization
- [x] `gpt-5-mini` classified as reasoning model by AI SDK (`role: "developer"`) — all request classifiers updated
- [x] Gemini mock: `generationConfig` assertion removed, `inlineData` camelCase fix
- [x] Stale assertions updated: `direct_tool` → AI-first, `skill_loop` → `tool_loop`, deny `blocked` → `completed`
- [x] `npm test` passes: all smoke tests green

**Phase B — File split (Remaining):**
- [ ] 按关注点拆分为多个测试文件（runtime, session, skills, providers, approval, memory）
- [ ] 抽取测试 helpers 到 `test/helpers/`
- [ ] `npm test` 仍运行所有测试
- [ ] 考虑添加测试分类（unit vs integration）

---

### AGRUN-119 | Memory Provider Abstraction
| Field | Value |
|-------|-------|
| Type | Feature |
| Priority | Medium |
| Status | To Do |
| Sprint | Phase 3 |
| Story Points | 8 |
| Labels | core, extensibility |

**Summary:** 从 Hermes Agent 学到的 pluggable memory provider 架构。当前 global-memory.js 是单一 IndexedDB 实现，缺少 provider 抽象和生命周期 hooks。

**Learned from:** Hermes Agent `memory_provider.py` + `memory_manager.py`

**Acceptance Criteria:**
- [ ] 定义 `MemoryProvider` 接口：`load()`, `save()`, `search()`, `delete()`
- [ ] IndexedDB 实现为内置 provider
- [ ] 添加生命周期 hooks：`onTurnStart`, `onSessionEnd`
- [ ] 支持 `createRuntime({ memoryProvider })` 配置
- [ ] 不破坏现有 global-memory API

---

### AGRUN-120 | Provider Failover Support
| Field | Value |
|-------|-------|
| Type | Feature |
| Priority | Medium |
| Status | To Do |
| Sprint | Phase 3 |
| Story Points | 5 |
| Labels | reliability, provider |

**Summary:** 从 Vercel AI SDK / Goose / OpenClaw 学到的 provider failover 机制。当前 provider 选择是静态的，API 错误直接失败。

**Acceptance Criteria:**
- [ ] 支持 `providerFallback` 配置（主 provider 失败时自动切换备用）
- [ ] 429/500/503 错误触发 failover
- [ ] 与 AGRUN-105 的 retry/circuit-breaker 协同
- [ ] 不改变单 provider 场景的行为

---

### AGRUN-121 | Missing ADRs for Recent Architecture Changes
| Field | Value |
|-------|-------|
| Type | Docs |
| Priority | Low |
| Status | To Do |
| Sprint | Phase 3 |
| Story Points | 3 |
| Labels | docs |

**Summary:** 近期重大架构变更缺少 ADR 记录（CONTRIBUTING.md 要求）。

**需补充的 ADR：**
- [ ] ADR: Persistent cross-session memory system (AGRUN-103)
- [ ] ADR: Agent Roles system (AGRUN-113)
- [ ] ADR: Native tools mode + envelope fallback (AGRUN-107/111)
- [ ] ADR: LLM self-correction mechanism (AGRUN-108)

---

### AGRUN-122 | Token Usage & Cost Display
| Field | Value |
|-------|-------|
| Type | Feature |
| Priority | Medium |
| Status | **Done** |
| Sprint | Phase 2 |
| Story Points | 8 |
| Labels | ux, observability |

**Summary:** 在 chatbox UI 显示 per-session token 使用量和估算成本，让用户直观了解 API 消耗。

**现状分析（全部完成）：**
- ✅ Provider 层已提取 `usage` 数据（`openai-browser.js:67`, `gemini-browser.js:68`）
- ✅ `createUsageSnapshot()` 已标准化为 `{ inputTokens, outputTokens, totalTokens, model, provider }`
- ✅ Session 层已持久化 `sessionRecord.lastTokenUsage` + `cumulativeUsage`
- ✅ Browser debug panel 已有 token 显示（`InspectorSummarySection.tsx`）
- ✅ Header 显示 session 累计 token（`ChatWorkspaceHeader.tsx`）
- ✅ 每条消息显示 input/output token（`AssistantMessageCard.tsx`）
- ✅ 内置定价表（`token-pricing.ts`，覆盖 OpenAI/Gemini 主流模型）
- ✅ Settings → Personalize → Show estimated cost toggle（默认关闭）

**Implementation Layers:**

| Layer | Files | Change |
|-------|-------|--------|
| Session | `session/token-budget.js`, `session/messages.js` | 新增 `cumulativeUsage` 累计字段，每轮 turn 叠加 |
| Session | `session/handle.js` | `run()` 完成后更新 cumulative usage |
| Runtime | `result-schema` contract | 文档化 usage snapshot + cumulative shape |
| Browser | 新增 `token-pricing.ts` | 定价表（OpenAI/Gemini 主流模型 $/1M tokens） |
| Browser | `ChatWorkspaceHeader.tsx` | Session 累计 cost badge（始终可见） |
| Browser | `AssistantMessageCard.tsx` | 每条消息底部 token 小标签（可折叠） |

**定价数据方案：**
- 内置静态定价表，用户可在 Settings 覆盖自定义价格
- 默认显示 token 数，cost 显示为 opt-in（Settings 开关）
- 价格不由 runtime 层管理（runtime 只提供 token 数据，pricing 是 browser 层关注点）

**UI 方案：**

```
┌─ ChatWorkspaceHeader ──────────────────────────────┐
│  ☰  Session Title              🔢 1.2K tokens  ⚙  │  ← 累计 badge
└────────────────────────────────────────────────────┘

┌─ AssistantMessageCard ─────────────────────────────┐
│  Agent 回答内容...                                   │
│                                                      │
│  ── Activity ──  ── 📊 128 in / 256 out ──  ── 📋 ──│  ← 每条消息
└──────────────────────────────────────────────────────┘
```

**Acceptance Criteria:**
- [x] Runtime: `sessionRecord.cumulativeUsage` 累计 per-session token（inputTokens, outputTokens, totalTokens）
- [x] Runtime: 每轮 `run()` 后叠加到 cumulative（不只是替换 lastTokenUsage）
- [x] Browser: `ChatWorkspaceHeader` 显示 session 累计 token 数
- [x] Browser: `AssistantMessageCard` 显示单条消息的 input/output tokens
- [x] Browser: Settings 可开启 cost 显示（默认关闭，只显示 token 数）
- [x] Browser: 内置 OpenAI/Gemini 主流模型定价表
- [x] 不破坏现有 debug inspector token 显示
- [x] 新增 smoke test 验证 cumulativeUsage 累计正确

**Reference:** `agrun_docs/result-schema.md` (Token Usage Schema), `agrun_docs/webui-integration-contract.md` (Token Display)

---

## Epic: Long-Running & Multi-Topic Task Architecture

**Design doc:** [agrun_docs/long-running-multi-topic-tasks.md](../long-running-multi-topic-tasks.md) · **ADR:** [agrun_docs/adr/0002-long-running-multi-topic-architecture.md](../adr/0002-long-running-multi-topic-architecture.md)

Six additive phases (P0–P5) — 都不破坏现有 session，不需要 migration，各阶段独立 config flag 可回滚。

### AGRUN-141 | P0 · Loop Convergence (Composite Budget + Action Fingerprint)
| Field | Value |
|-------|-------|
| Type | Bug / Architecture |
| Priority | **Critical** |
| Status | **Done** (2026-04-22) |
| Sprint | Phase 3 |
| Story Points | 5 |
| Labels | reliability, planner-loop |

**Summary:** 消灭无限 retry loop —— 现行 `MAX_CONSECUTIVE_ACTION_FAILURES=2` 仅按 `actionName` 计数，两个工具交替失败永远触不到 guard；`planner_invalid_action` 分支只 `continue` 无上限；相同 tool+args 可无限复现。

**Root Cause（代码位置）：**
- [action-loop-session-loop.js:446-470](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js#L446) — `countConsecutiveActionFailures` 按 `actionName` 匹配，跨 tool 失败不累计。
- [action-loop-session-loop.js:97-102](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js#L97) — invalid decision 只 `push + continue`，没有上限。
- 无 action fingerprint 模块，相同 `tool + args` 可反复执行。

**Implementation：**
- 新增 `src/runtime/session-budget.js` — `SessionBudget` 对象：`totalFailures`, `invalidDecisions`, `sameFingerprintRepeats`, `cyclesSinceProgress`, `wallClockMs`, `tokensBurned`。
- 新增 `src/runtime/action-fingerprint.js` — `fingerprintAction(decision) = hash(name + stableStringify(args))`。
- 改 `action-loop-session-loop.js` —
  - 增加总体 failure counter（跨 actionName）：`totalRecentFailures` ≥ 5 → `force_replan`。
  - `planner_invalid_action` 走 `runState.plannerInvalidCount`（[state.js:17](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js) 已有），≥ 3 → forceFinalize。
  - `sameFingerprintRepeats` ≥ 2 → 强制 short-circuit。
- Breach 级联：`force_replan` → `ask_user`（复用 clarification-state） → honest finalize。

**Acceptance Criteria：**
- [x] 新建 [src/runtime/session-budget.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/session-budget.js)（140 行）+ [action-fingerprint.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-fingerprint.js)（45 行）。
- [x] [action-loop-session-loop.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js) 接入 composite budget（cycle 顶部 `maybeEnforceBudgetBreach` + 执行前 `recordFingerprint` + `noteCycleCompleted`），保留旧 `MAX_CONSECUTIVE_ACTION_FAILURES=2` 作为 per-actionName subset。
- [x] `runtimeConfig.budget.*` 可覆盖所有阈值；`budget: false` 降级为旧行为（回滚路径）。
- [x] 新增 [test/unit/session-budget.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/session-budget.test.js) 16 断言：
  - 两个 tool 交替失败 5 次 → `total_failures` breach（旧行为会无限 loop）。
  - 相同 tool+args 连续 2 次 → `fingerprint_repeat` short-circuit。
  - Planner 连续 3 次 invalid decision → `invalid_decisions` breach。
  - 5 cycle 无 tool 证据增长 → `no_progress` breach。
  - `budget: false` 时 `checkBudget` 返回 `null`。
  - `describeBudgetBreach` 四 reason 各产出可读文案。
- [x] `npm test` 全绿（smoke + 所有 unit 含 16 条新断言）。
- [ ] Live test 33/33 回归验证（待 API key 环境跑 `npm run test:live`）。

**Shipped defaults:**
| Cap | Default | 语义 |
|-----|---------|------|
| `totalFailures` | 5 | 跨所有 actionName 的 `action_error` 累计 |
| `invalidDecisions` | 3 | `planner_invalid_action` 累计 |
| `sameFingerprintRepeats` | 2 | 相同 `name + skillName + toolName + stableStringify(args)` 出现第 2 次 |
| `cyclesSinceProgress` | 5 | `toolContext.history.length` 连续 N cycle 未增长 |

检测顺序优先级：`fingerprint_repeat` → `total_failures` → `invalid_decisions` → `no_progress`（最紧 loop 最早截断）。

**Observability:** Breach 时 `pushStep("session-budget-breach", { reason, count, cap, cycle })`，force finalize 时 decision.instruction 带 `describeBudgetBreach()` 文案传给 finalizer。

---

### AGRUN-142 | P1 · Goal Anchor Injection Every Cycle
| Field | Value |
|-------|-------|
| Type | Architecture |
| Priority | High |
| Status | Done (3-slice delivery 2026-04-22 · harness + wiring + agrun_docs/live-smoke) |
| Sprint | Phase 3 |
| Story Points | 3 |
| Labels | planner, reliability |

**Summary:** Planner 每 cycle 注入原始 query verbatim + goal anchor，防止长任务中 planner 偏离原目标。三层模型（L1 run-scope `runState.originalQuery` · L2 thread-scope `thread.goalAnchor.text` mirrored to `runState.threadGoalAnchorText` · L3 turn-scope `turnState.goalAnchorText` 不变），同文本层自动 dedupe。

**Implementation（已 ship）：**
- ✓ [src/runtime/goal-anchor-config.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/goal-anchor-config.js) (new) — `normalizeGoalAnchorConfig` 默认 `{enabled:true, maxAnchorChars:4000, includeThreadAnchor:true}`；true/false 别名 + 正整数校验。
- ✓ [src/runtime/goal-anchor.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/goal-anchor.js) (new) — `captureOriginalQuery / readGoalAnchorView / formatGoalAnchorBlock / seedThreadGoalAnchor` + `GOAL_ANCHOR_BLOCK_HEADERS`。Format 固定输出 `[ORIGINAL USER QUERY — DO NOT REINTERPRET]` + `[GOAL ANCHOR]` 栅栏块，同文本 dedupe，per-layer truncation（不丢 header）。
- ✓ [src/runtime/state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js) — `originalQuery: ""` + `threadGoalAnchorText: ""` 字段 + snapshot 保留。
- ✓ [src/runtime/config.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/config.js) — `goalAnchor: normalizeGoalAnchorConfig(config.goalAnchor)`。
- ✓ [src/runtime/action-loop-session.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session.js) — session ctor 调 `captureOriginalQuery(runState, {inputText, requestPrompt})`；immutability = "if existing return existing"。
- ✓ [src/session/thread.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/thread.js) — `applyRouterVerdict` 接收 `turnId`；`new_thread` 把 `goalAnchor: {createdAt, text:userText, turnId}` 传入 `createThread`；`bumpThread` 通过 `normalizeGoalAnchor(nextGoalAnchor)` 对 legacy thread lazy-seed（已有 text 绝不覆盖）。
- ✓ [src/session/handle.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/handle.js) + [src/runtime/run-state-thread.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/run-state-thread.js) — hydration payload 扩展 `goalAnchorText: activeThreadGoalAnchorText`；`hydrateRunStateWithThread` 镜像到 `runState.threadGoalAnchorText`。
- ✓ [src/runtime/planner-prompt.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js) — `buildPlannerSystemPrompt` 接受 `opts.goalAnchorBlock`，插入位置：`roleBlock` 之后、`dynamicSystemPrompt` 之前（保持首段 prompt-cache 稳定）。
- ✓ [src/runtime/planner.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner.js) — 两处 `buildPlannerSystemPrompt` 透传 `goalAnchorBlock`。
- ✓ [src/runtime/action-loop-planner.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-planner.js) — `buildGoalAnchorBlockForCycle(runState, session)` helper 每 cycle 组装 view+config → block → 传入 `planNextAction`。
- ✓ [src/runtime/runtime-finalize.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-finalize.js) — `buildGoalAnchorBlockForFinalize` helper；`systemPrompt` 数组 `[roleBlock, goalAnchorBlock, finalResponseSystem]` 顺序注入。
- ✓ 5 处 `executeRuntimeFinalize` 调用点补传 `runtimeConfig: session.runtimeConfig` — `action-loop-plan.js` / `approval.js` / `action-loop-session-terminals.js` (×3)。
- ✓ [test/unit/goal-anchor.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/goal-anchor.test.js) — 22 断言 × 5 分组覆盖 config normalizer / capture immutable / view / format dedupe / truncation / seed lazy。
- ✓ [test/unit/goal-anchor-wiring.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/goal-anchor-wiring.test.js) — 9 断言覆盖 applyRouterVerdict × 5 verdicts + hydrateRunStateWithThread × 4 branches。
- ✓ MCP Chrome live smoke — 12/12 PASS，见 [agrun_docs/live-tests/agrun-142-goal-anchor-browser-smoke.md](../live-tests/agrun-142-goal-anchor-browser-smoke.md)。

**Acceptance Criteria：**
- [x] `runState.originalQuery` 在 runtime 生命周期内不可变（`captureOriginalQuery` existing-return 契约）。
- [x] 每个 planner cycle prompt 前几行包含原始 query verbatim（`buildPlannerSystemPrompt` 在 roleBlock 后立即注入）。
- [x] Unit test：长 session（>10 cycle）后 prompt 仍包含原始 query（`goal-anchor.test.js` + `goal-anchor-wiring.test.js` 覆盖 immutable + hydration 恢复）。
- [x] Config flag 关闭时降级为旧行为（`enabled:false` → `formatGoalAnchorBlock` 返回 `""`，prompt byte-identical）。

---

### AGRUN-143 | P2 · Evidence Provenance + Finalizer Scoping
| Field | Value |
|-------|-------|
| Type | Architecture |
| Priority | High |
| Status | Done (MVP shipped 2026-04-22 · scope wiring activates when AGRUN-144 sets `runState.scopedEvidenceUrls`) |
| Sprint | Phase 3 |
| Story Points | 5 |
| Labels | evidence, hallucination |

**Summary:** 给 evidence 加 `turnId` / `threadId` / `source` / `confidence` / `supersededBy` provenance；finalizer 引用表按 `runState.scopedEvidenceUrls` 白名单裁剪，降低跨 topic / 过期信息导致的幻觉。

**现状：** [evidence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/evidence.js) 有 `EVIDENCE_KINDS` 分类但 entry 没有 provenance 字段；[final-response-sources.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/final-response-sources.js) 直接读 `researchContext.readSources`，不过滤 thread / window。

**Implementation（已 ship）：**
- [src/session/evidence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/evidence.js) — `normalizeEvidenceItem()` 输出 `{ id, kind, slot, text, status, createdAt, index, confidence, threadId, turnId, source, supersededBy }`；旧条目 default `threadId="default"` / `confidence=0.5` / 其它 null；`classifySessionMemoryEntries` 同时处理 implicit supersede（同 slot 新覆盖旧）+ explicit supersede（`metadata.supersededBy` 引用指定 id）；新增导出 `filterEvidenceByScope(items, scope)`。
- [src/runtime/final-response-sources.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/final-response-sources.js) — 新增 `filterSourcesByEvidence(payload, evidenceUrls)` 白名单裁剪；`evidenceUrls === null` 即透传（back-compat）。
- [src/runtime/action-loop-terminal.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-terminal.js) — 三处 `collectFinalResponseSources` 全部改走本地 helper `collectScopedFinalResponseSources(runState)`，读取 `runState.scopedEvidenceUrls`；当 AGRUN-144 topic router 设置该字段后自动激活过滤。
- 追加 [test/unit/evidence-provenance.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/evidence-provenance.test.js) — 12 断言覆盖默认 provenance / 字段 round-trip / confidence clamp / implicit & explicit supersede / scope 过滤 3 种形态 / filterSourcesByEvidence 三形态。

**Acceptance Criteria：**
- [x] Evidence entries 含 5 个新字段（id + threadId + turnId + source + supersededBy；confidence 由 nullable 升级为 default 0.5）。
- [x] Finalizer 的 citations 通过 `collectScopedFinalResponseSources` → `filterSourcesByEvidence` 门闸；`runState.scopedEvidenceUrls` 设定后立即生效（AGRUN-144 落 router 即激活）。
- [x] Unit test：implicit supersede（同 slot 新覆盖旧）+ explicit supersede（`metadata.supersededBy` 引用 id）都只看到最新条目。
- [x] 旧 session（无 provenance）自动落 default（threadId="default"、confidence=0.5、其它 null），smoke 全绿。

---

### AGRUN-144 | P3 · Topic Router + Thread-Scoped Runtime
| Field | Value |
|-------|-------|
| Type | Feature |
| Priority | High |
| Status | In Progress (Slice A+B+C+D+E+F.1+F.2+G+G.1 shipped 2026-04-22 · router + Thread + hydration + memory provenance + thread-scoped recall + MCP Chrome live smoke + lexicon-free turnIntent 合同 + 结构化 extractor 自动填充 `{pivotIntent, divergentIntent}` + LLM-backed planner + 浏览器示例三层合同 end-to-end) |
| Sprint | Phase 3 |
| Story Points | 8 |
| Labels | architecture, multi-topic |

**Summary:** 多 topic 对话一等公民支持 —— session 从线性 message list 升级成 thread tree，每个 thread 独立 GoalAnchor / KnowledgeState / toolContext / budget。

**现状：** [topic-like-task.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/topic-like-task.js) 可检测 topic-like prompt，`inquiryContext.activeTopic` 追踪当前 topic，但无 `threadId` / routing / 隔离。Session store 平铺 message list。

**Implementation：**
- ✓ [src/session/thread.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/thread.js) — `createThread / normalizeThread / normalizeThreadList / createDefaultThread / findThreadById / appendRecentUserText / tokenizeTopicText` + `DEFAULT_THREAD_ID = "default"`。canonical shape = `{id, topic, status, goalAnchor, knowledgeState, toolContext, researchContext, recentUserTexts, budget, createdAt, lastActiveAt}`。
- ✓ [src/runtime/topic-router.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/topic-router.js) — `routeTopic({userMessage, threads, activeThreadId, turnIntent})` 返回 `{action, threadId, candidates, topic, reasoning}`。Jaccard 重叠 + `MIN_OVERLAP = 0.2` / `AMBIGUITY_DELTA = 0.05`；支持英文（"back to"）+ 中文（"回到"/"上一个"/"继续之前"）pivot 标记；无 LLM 调用。
- ✓ [src/runtime/config.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/config.js) — `normalizeThreadsConfig({enabled:false, maxThreads:8, routerMinOverlap:0.2, ambiguityDelta:0.05, allowPivot:true})`，默认关闭 → 零行为变化。
- ✓ **Slice B** [src/session/thread.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/thread.js) — 新增 `readThreadsState / applyRouterVerdict / extractUserMessageText`；`applyRouterVerdict` 处理 4 种 verdict + FIFO 淘汰（按 `lastActiveAt`，active 永不被淘汰）。
- ✓ **Slice B** [src/session/evidence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/evidence.js) — `buildThreadScopedEvidenceUrls(entries, activeThreadId)` 从 memory metadata (`url` / `sourceUrl` / `sources[].url`) 收割 URL，按 `threadId` 过滤；legacy 无 threadId 条目落默认 thread bucket。
- ✓ **Slice B** [src/runtime/run-state-thread.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/run-state-thread.js) (new) + [state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js) — `runState.threadId` + `runState.scopedEvidenceUrls` 字段 + `hydrateRunStateWithThread()` helper（拆成独立文件避开 state.js 的 `virtual:` 依赖，Node ESM 可直接加载）。
- ✓ **Slice B** [src/runtime/run-skill-loop.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/run-skill-loop.js) + [action-loop-session.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session.js) — `createRunState` 后立刻 `hydrateRunStateWithThread(runState, options.threadHydration)`，`threadHydration` 从 runLoop 透传。
- ✓ **Slice B** [src/session/handle.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/handle.js) — `routeTurnToThread()` 在 `runLoop` 之前跑：flag off → null no-op；flag on → `routeTopic` + `applyRouterVerdict` + `buildThreadScopedEvidenceUrls` → `threadHydration = {threadId, scopedEvidenceUrls}`；turn 结束后 `sessionRecord.threads` + `sessionRecord.activeThreadId` 持久化；发 `thread-routed` step 事件（含 `action / threadId / previousThreadId / reasoning`）。
- ✓ **Slice C** [src/runtime/result.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/result.js) — `normalizeMemoryEntry(entry, skill, input, provenance)` + `stampProvenance(metadata, {threadId, turnId, source, sources})`；不覆盖 caller 已显式设置的字段。
- ✓ **Slice C** [src/runtime/context.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/context.js) — `createHelpers.appendMemory` 读 `runState.threadId / runId`（via `readProvenanceFromRunState`）传给 `normalizeMemoryEntry`，skill/planner 写 memory 自动携带 provenance。
- ✓ **Slice C** [src/session/extract.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/extract.js) — `extractSessionMemoryEntries(options)` 接受 `options.provenance`；`normalizeProvenance` 将 `{threadId, turnId, readSources}` 折叠为 `{threadId, turnId, source, sources}`，用 `stampProvenance` 盖在自动抽取 metadata 上。
- ✓ **Slice C** [src/session/handle-turn.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/handle-turn.js) — `readExtractionProvenance(runState)` 从 `runState.threadId / runId / researchContext.readSources` 取 provenance，注入 `extractSessionMemoryEntries`。
- ✓ **Slice C** 不改 store — `store-memory.js` / `store-indexeddb.js` 的 `appendMemory(sessionId, entry)` 原生转发 `entry.metadata`，只要 metadata 带 `threadId/turnId` 即持久化，store 层无需改动。
- ✓ **Slice D** [src/runtime/config.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/config.js) — `normalizeThreadsConfig` 新增 `crossThreadRecall: false` 默认。
- ✓ **Slice D** [src/session/evidence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/evidence.js) — 新导出 `filterMemoryEntriesByThread(entries, scope)`；`buildSessionEvidenceSnapshot` 在 `classifySessionMemoryEntries` 之前先过滤，让 `facts/preferences/decisions/items/memory` 四个块全部只看见当前 thread 的证据；legacy 无 `threadId` 条目落 `DEFAULT_THREAD_ID` 桶，仅当前 thread 若恰为 `"default"` 才可见。
- ✓ **Slice D** [src/session/session-memory.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/session-memory.js) + [src/session/compaction.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js) — `threadScope` 参数贯穿 `prepareProviderSessionContext` → `buildMemoryVariant` → `buildSessionMemorySnapshot` → `buildSessionEvidenceSnapshot`。
- ✓ **Slice D** [src/session/handle.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/handle.js) — `routeTurnToThread` 被提前到 `prepareSessionInput` 之前跑；新 `readThreadScope(runtimeConfig, threadRouting)` 派生 `{threadId, crossThread:false}` 或 `null`（flag off / `crossThreadRecall=true` / routing 未产生 threadId 三种情况全部 fallback 到 null 以保持 legacy 行为）。
- ✓ **Slice D** [src/session/approval-resume.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/approval-resume.js) — `prepareSessionApprovalResumeInput` 透传 `options.threadScope` 到 `prepareProviderSessionContext`，保证 resume approval 的压缩/召回同样走 thread filter。
- ✓ **Slice E** [examples/browser/src/runtime/agent.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/runtime/agent.ts) — `createRuntime` 调用开启 `threads: { enabled: true }`，让浏览器示例默认跑 topic router + thread-scoped recall（`crossThreadRecall` 保持默认 `false`）。
- ✓ **Slice E** MCP Chrome live smoke (3 turn scenario) — Topic A (Python `ImportError` on macOS) → Topic B (Taipei 3-day weather) → pivot-back "回到 Python ImportError" turn。pivot-back 答复 sources 为 `medium.com` × 2（Python 语义），**无** `google.com/weather`/`time` URL 泄漏。IndexedDB `sessions[-1].threads` / `activeThreadId` 字段正常持久化，全部 3 turn 的 `recentUserTexts` 累积，pipeline 无报错。Live observation: 当前浏览器示例 router 在 keyTerms 未填充时默认 `same_thread`，未拆 B 为独立 thread —— 这是扩展到 Slice F（keyTerms extractor 触发）的 follow-up，不影响 Slice D 过滤契约（159/159 smoke 已经证明）。
- ⚠ **Slice F (first draft, superseded by F.1)** — 曾往 router 里加 `CONTINUITY_MARKERS` EN/CN 词表 + `MIN_DIVERGENT_TOKENS` 硬编码分支。违反 CLAUDE.md "Do not use hardcode logic / Prefer Agentic Harness Engineering" 原则，已在 F.1 移除词表，把 intent 决定权外推到上游。
- ✓ **Slice F.1** [src/runtime/topic-router.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/topic-router.js) — 去硬编码：删除 `CONTINUITY_MARKERS` 词表；`detectPivot` 的 EN/CN regex 改名 `PIVOT_MARKERS_FALLBACK`（legacy graceful fallback，注释里明确标记「只在 upstream 未提供 intent 时才走」）。新增 router 决策层 intent 合同：
  - `turnIntent.referentialIntent === true` + 零 overlap + 存在 distinctive thread → `continue_thread` (reasoning `referential_continuation_no_overlap`)。
  - `turnIntent.divergentIntent === true` → `new_thread` (reasoning `upstream_divergent_intent`)。
  - 没有上游 intent 且非 topic-like prompt → 保守默认 `continue_thread`（reasoning `no_prior_overlap_fallback_active`）。
  Router 变成纯决策层：只消费 Jaccard / topic-like 结构信号 + turnIntent 合同，不再持有语言词典。域知识（referential 判定、divergent 判定）由 planner / extractor 注入。
- ✓ **Slice F.1** [test/unit/topic-router.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/topic-router.test.js) — 21/21 case：
  - #16 divergent question 必须显式 `turnIntent.divergentIntent`，无 intent → continue（保守）。
  - #17 referential meta-prompt 必须显式 `turnIntent.referentialIntent` → continue；#17b 同 prompt 无 intent → continue（保守默认兜底，router 不推测意图）。
  - #18 tiny `why?` → continue（无 intent）。
  - #19 CN 元语配 `referentialIntent` → continue；CN 天气短句（单 CJK 块）走 topic-like → new_thread。
  - #20 `upstream_divergent_intent` 正交测试。
  Smoke 159/159 通过。
- ⊘ **Slice F live re-smoke regression** — Slice F 旧硬编码版跑通的「Turn 2 weather 拆新 thread」在 F.1 没有上游 intent 的前提下会回退到 Slice E 行为（单 thread）。这是有意识的取舍：放弃启发式的激进拆分，换取 router 合规 + 把 intent 责任明确交给 Slice F.2（extractor / planner 填充 `turnIntent`）。Slice E 级别的 pivot-back evidence 隔离（Slice D 过滤契约）不受影响。
- ✓ **Slice F.2** [src/runtime/topic-scoring.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/topic-scoring.js) (new) — 把 router 原先私有的打分函数抽成共享模块：`collectThreadTokens / jaccard / scoreThreads / anyThreadHasDistinctiveTokens / totalThreadVocab`。Router + extractor 共用同一份 Jaccard 计算，避免词表无声复现。
- ✓ **Slice F.2** [src/runtime/turn-intent.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/turn-intent.js) (new) — 纯结构化 intent 提取器 `extractTurnIntent({userMessage, threads, activeThreadId})`，输出 `{pivotIntent?, divergentIntent?}`：
  - **Pivot** = 非 active thread 中存在一个 Jaccard ≥ `MIN_OVERLAP=0.2` 且领先 active `PIVOT_DOMINANCE_DELTA=0.05` 的 thread。
  - **Divergent** = 所有 thread overlap = 0 且（a）至少一个 thread 带 distinctive token、（b）message token ≥ `MIN_DIVERGENT_TOKENS=3`、（c）`totalThreadVocab(threads) ≥ messageTokenCount`。最后这条「thread 词汇量 ≥ 消息词汇量」是关键 structural guard：防止 young thread 因为体量不够被错判为 divergent（比如 "summarize what we discussed earlier" 配 thin thread 会被容忍为 continue）。
  - **Referential** 不做 structural 推断 —— 结构信号不足以区分「零 overlap 的引用提问」和「零 overlap 的全新话题」，保留给未来 LLM / planner 层。
  - 三个阈值是 tunable numeric floor，不是词表；模块内零语言/领域 vocabulary。
- ✓ **Slice F.2** [src/runtime/topic-router.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/topic-router.js) — 改用 `topic-scoring.js` 共享助手，删除本地重复的 scoring 实现；router 决策层契约保持 F.1 不变。
- ✓ **Slice F.2** [src/session/handle.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/handle.js) — `routeTurnToThread` 在 `routeTopic` 之前调用 `extractTurnIntent`，把结构化 `turnIntent` 作为第四参数喂给 router，让 Slice F.1 的「`upstream_divergent_intent` → new_thread / `pivotIntent` → pivot_back」分支在浏览器上游默认打开，无需 caller 手工注入 intent。
- ✓ **Slice F.2** [test/unit/turn-intent.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/turn-intent.test.js) (new) — 10/10 case 覆盖：空消息、空 thread、零 overlap rich-vocab → divergent、零 overlap 但 thread 词汇薄 → 不发散（vocab guard）、tiny `why?` → 不发散、非 active thread 主导 → pivot、active 自持 overlap → 无信号、partial overlap 交给 router Jaccard 阈值、blank thread → 空 intent、中文 divergent 配中文 rich Python thread → divergent（结构信号跨语言通用）。Smoke 22/22 全部通过。
- ✓ **Slice F.2 MCP Chrome live re-smoke** (2026-04-22) — 3-turn 场景：
  - **Turn 1** (Python ImportError on macOS) → `default` thread，threadCount=1，activeThreadId=`default`。
  - **Turn 2** (Taipei 3-day weather) → extractor 自动发出 `divergentIntent: true`（零 overlap + thread vocab ≥ message vocab + rich thread），router 返回 `new_thread` → threadCount=2，activeThreadId 切到 `t-h8fn04ct`，topic 自动填为完整用户语句。**这是 F.2 核心目标达成：无需调用方手工注入 turnIntent 即可拆分发散话题。**
  - **Turn 3** (CN pivot "回到之前的 Python ImportError 话题...") → 新建第三个 thread `t-id4foyle`（threadCount=3）而不是回到 Python default。原因：Python thread Jaccard ≈ 0.077（只有 `python` / `importerror` 两个 token 跨中英文对齐），低于 `MIN_OVERLAP=0.2`，router 的 pivot 分支被 Jaccard 门闸挡住，降级为 "overlap_below_threshold_topic_like" → `new_thread`。即便 CN 回指标记 `回到` 命中 `PIVOT_MARKERS_FALLBACK` 也无效（fallback 同样要 `best.score >= MIN_OVERLAP`）。答复本身依然以 Python 内容呈现——原因是 `compaction` 目前仍按线性 messages 压缩（AGRUN-145 待办），所以 LLM 从原始消息历史补齐了上下文，而不是经由 thread-scoped recall。
  - **结论**：Slice F.2 关键 acceptance（无硬编码 intent 自动产出 `divergentIntent` 并驱动 `new_thread`）验证通过；pivot-back 在跨语言低 overlap 场景仍需 planner/LLM 层注入 `pivotIntent + targetThreadId`，纯结构信号不足以越过 `MIN_OVERLAP` 门闸——这正是当初有意保留的合同缺口（结构层不承担语义回指判断）。
- ✓ **Slice G** [src/runtime/turn-intent-planner.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/turn-intent-planner.js) (new) — LLM-backed intent planner：
  - `planTurnIntent({userMessage, threads, activeThreadId, classify})` 接 runtime 注入的 `classify` 异步回调，不直接发网络；`buildThreadSummaries` 把 thread 压到 `{id, topic(trim 160), sample(last recent, trim 200), recentCount}` 避免 prompt 膨胀。
  - `normalizePlannedIntent` 严格 shape 校验：拒未知 key、强制 boolean、`targetThreadId` 必须出现在 thread 列表里且不等于当前 active（防 planner 幻觉）；`targetThreadId` 存在即隐式置 `pivotIntent=true`，并清掉同时存在的 `divergentIntent`（互斥）。
  - 任何 classifier 异常/空结果一律降级为 `{}`，router 的保守默认兜底。
  - `mergeTurnIntent(structural, planned)` 合并两层：planner 覆盖冲突 key（因为只在结构层低置信度时升级），`targetThreadId` 同样清 `divergentIntent`。
- ✓ **Slice G** [src/runtime/topic-router.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/topic-router.js) — router 新增最高优先级分支：若 `turnIntent.targetThreadId` 指向合法且非 active 的 thread，直接 `pivot_back`（reasoning `upstream_pivot_target`）；若指向 active，则 `continue_thread`（`upstream_pivot_target_already_active`）；指向不存在的 thread 则忽略并走结构化分析。**绕过 `MIN_OVERLAP` 是本分支唯一的目的** —— 升级到 LLM 的代价已经付了，结果就是权威。
- ✓ **Slice G** [src/runtime/config.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/config.js) — `threads.intentClassifier` 新增 callback 字段（默认 `null`）；函数签名 `({userMessage, activeThreadId, threads:[summaries]}) => Promise<rawIntent>`，运行时按需注入（浏览器示例 Slice G.1 再开）。
- ✓ **Slice G** [src/session/handle.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/handle.js) — `routeTurnToThread` 改 async；结构化 extractor 仍然先跑，只有在「classifier 已配置 + 结构化 intent 为空 + threads.length ≥ 2」三条同时成立时才会 `await planTurnIntent`，然后 `mergeTurnIntent` 合并。**冷路径零改动**：没配 classifier 时代码路径完全等同 F.2。
- ✓ **Slice G** [test/unit/turn-intent-planner.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/turn-intent-planner.test.js) (new) — 11/11 case：无 classifier / 空消息 / classifier throw / targetThreadId 自动补 pivot / 幻觉 threadId 丢弃 / target==active 丢弃 / pivot+divergent 互斥 / 未知 key 过滤 / merge 覆盖 / summaries 截断 / payload 紧凑。
- ✓ **Slice G** [test/unit/topic-router.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/topic-router.test.js) — 新增 case 22/23/24：`targetThreadId` 越过 Jaccard 触发 pivot_back；指向 active → continue；不存在 threadId → 结构化兜底。全套 24/24 通过。
- ✓ **Slice G.1** [examples/browser/src/runtime/agent.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/runtime/agent.ts) — 浏览器示例接入 `intentClassifier`：
  - 新增 `classifierContext`（模块级 mutable），`runAgentTurn` 在 try/finally 里按当前 turn 的 `apiKey/providerId/modelId/fetch/signal` 写入，退出前还原上一次状态 —— 保证不会泄漏到 verify probe 或下一 turn。
  - `classifyTurnIntent(payload)` 读 context，根据 `providerId` 路由到导出的 `requestGeminiContent` / `requestOpenAIChatCompletion`，system prompt 要求返回 STRICT JSON（`pivotIntent?|divergentIntent?|referentialIntent?|targetThreadId?`），只在证据强时 emit，否则 `{}`；`parseClassifierJson` 剥 ```json 围栏，解析失败静默回 `{}`。
  - `createRuntime(...).threads` 现在带 `intentClassifier: classifyTurnIntent`；因为缓存 runtime 从不变，provider 切换靠每 turn 重写 context，而非重建 runtime。
  - 失败语义：classifier 抛错 → planner 返回 `{}` → 合并结构化 intent → router 走结构化分支。对话永远不会因为分类失败而失败。
- ✓ **Slice G.1 · Live re-smoke**（2026-04-22, MCP Chrome Gemini 2.5 flash）
  - Turn 1 Python ImportError（中文 + python 关键字） → 结构化 `looksLikeTopicPrompt` 触发 `new_thread`，split 出 `t-27ibfnqk`；`default` 保持空（符合 F.1 以来行为）。
  - Turn 2 "顺便问下 台北 明天 天气 预报…" → 结构化 `divergentIntent` 触发 `new_thread`，split 出 `t-2yd91bcu`，`activeThreadId` 随之切换。
  - Turn 3 "回到之前的 Python ImportError 话题，我换了 python 版本还是一样错…" → 结构化 intent 为空（Jaccard overlap 过稀），planner 升级到 gemini classifier，返回 `targetThreadId:"t-27ibfnqk"` → router `pivot_back` reasoning `upstream_pivot_target` → `activeThreadId` 从 `t-2yd91bcu` 切回 `t-27ibfnqk`。
  - 持久化校验（`agrun-browser-runtime-session-store → sessions`）：`threadCount=3`（未新增第 4 条），Python thread `recentCount=2`（初 turn + pivot-back 两条），weather thread `recentCount=1` 不变。Console 零 `error|warn`。
  - 结论：LLM 分类器越过结构化兜底的 Jaccard 门槛成功 —— 三层合同（extractor → planner → router）在 live 场景端到端通过。
- ✓ **Slice H** Thread boundary visualization（2026-04-22）— Harness 合同：thread 是聊天时间线的 index view，UI 只读 metadata，不改变 message 结构。
  - [src/session/handle.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/handle.js) — runLoop 完成后把 `threadId` + `threadRouting{action, activeThreadId, previousThreadId, reasoning}` 写入 `result.runState`，成为非流式稳定合同（`emitThreadStep` 只是 streaming callback，从不落 `result.steps`，因此改动前 UI 层读不到）。`routeTurnToThread` 增加 `previousThreadId` 返回字段。
  - [examples/browser/src/runtime/agent.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/runtime/agent.ts) — `runAgentTurn` 通过 `readThreadRoutingFromRunState(result)` helper 读 `result.runState.threadRouting` 并回传。
  - [examples/browser/src/runtime/agent-types.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/runtime/agent-types.ts) — `RuntimeResultLike.runState` 新增 `threadId` / `threadRouting` 字段。
  - [examples/browser/src/types.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/types.ts) — `ChatMessageMetadata` 新增 `threadId` + `threadRouting`，携带完整四字段（`action / activeThreadId / previousThreadId / reasoning`）。
  - [examples/browser/src/hooks/chat-turn-assistant-state.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/hooks/chat-turn-assistant-state.ts) — `buildCompletedAssistantMessage` 把 `result.threadId` / `result.threadRouting` 写入 assistant message metadata。
  - [examples/browser/src/components/ChatThreadPivotDivider.tsx](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/ChatThreadPivotDivider.tsx) (new) — 纯展示 divider：`new_thread` / `pivot_back` / `ambiguous` 三种 action 触发渲染（`continue_thread` → 返回 `null`），显示 action 图标 + trimmed threadId + reasoning。
  - [examples/browser/src/components/ChatWorkspaceMessageList.tsx](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/ChatWorkspaceMessageList.tsx) — 用 Fragment 在触发 pivot 的 user turn 上方插入 divider；`readPivotRouting(messages, index)` 从下一条 assistant 读 routing 以推断当前 user turn 所属 thread。
  - [examples/browser/src/components/inspector-presenters.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/inspector-presenters.ts) — 新增 `InspectorThreadEntry` / `InspectorThreadingViewModel`；`buildThreadingView(session)` 遍历 assistant messages，按 `threadId` 聚合 `turnCount`、派生 `activeThreadId` 与 `lastRouting`（active 排顶、次按 turnCount 降序）；空 session 返回 `null`。
  - [examples/browser/src/components/InspectorThreadingSection.tsx](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/InspectorThreadingSection.tsx) (new) — 独立 section（单一职责，不复用 Summary section），挂进 `InspectorPanel.tsx`；读 metadata 派生 → 不订阅新通道；无 thread metadata 时返回 `null`。
  - [examples/browser/src/components/InspectorPanel.tsx](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/InspectorPanel.tsx) — 在 `InspectorSupportSection` 之后挂载 `InspectorThreadingSection`。
  - **Live 验证**（2026-04-22, MCP Chrome，`?debug_yn=y`）：3-turn 场景 metadata 三层全通 —— Turn1 `new_thread` → `t-mc2hw8m9` reasoning `topic_like_prompt_no_prior_overlap`；Turn2 `new_thread` → `t-mq5c0m7n` reasoning `upstream_divergent_intent`；Turn3 `pivot_back` → `t-mc2hw8m9` reasoning `upstream_pivot_target`。Inspector Threading 区：`Active=t-mc2hw8m9`、`Last Routing=pivot_back · upstream_pivot_target`、线程列表 `t-mc2hw8m9(2 turns, active) / t-mq5c0m7n(1 turn)`。聊天 divider：`NEW THREAD T-MC2HW8M9` / `NEW THREAD T-MQ5C0M7N` / `PIVOT TO T-MC2HW8M9`。
  - 测试：`npm test` 通过（含 `thread-hydration` / `topic-router` / `turn-intent-planner` 全量）；`examples/browser` `tsc --noEmit` 无 error。

**Acceptance Criteria：**
- [x] 新 `Thread` 数据结构 + `DEFAULT_THREAD_ID` 导出（AGRUN-143 已对齐 `threadId: "default"` 默认值）。
- [x] Topic router 4-way 分类（continue/new/pivot/ambiguous），`routeTopic` 纯函数 + 21/21 单测通过（见 [test/unit/topic-router.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/topic-router.test.js)；Slice F.1 以 `turnIntent.referentialIntent/divergentIntent` 合同替代 Slice F 旧硬编码词表）。
- [x] 配置门禁 `runtimeConfig.threads.enabled`（默认 `false`）已就位 → Flag 关闭时完全降级为当前单线程行为（smoke 140/140 通过验证）。
- [x] Slice B 串联：`handle.js` 路由 + 持久化 + runState 水合 + `scopedEvidenceUrls` 写入；15/15 单测（见 [test/unit/thread-hydration.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/thread-hydration.test.js)）。
- [x] Slice C 证据自动打标：`context.js` + `extract.js` 把 `runState.threadId / runId` 注入 memory metadata，`researchContext.readSources` 折叠为 `metadata.sources`；9/9 单测（见 [test/unit/memory-provenance.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/memory-provenance.test.js)）。Store 层无需改动（`appendMemory` 原生透传 metadata）。Slice B 埋的 `buildThreadScopedEvidenceUrls` 自此有 thread-tagged 条目可过滤。
- [x] Slice D 召回 thread 过滤：`evidence.js` / `session-memory.js` / `compaction.js` 三层透传 `threadScope`；`handle.js` 把 routing 前置到 `prepareSessionInput` 之前，让 `buildMemoryVariant` 看到的 memory 只含当前 thread 的条目；`runtimeConfig.threads.crossThreadRecall=true` 为 opt-out 开关；10/10 单测（见 [test/unit/semantic-recall-scope.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/semantic-recall-scope.test.js)）。Smoke 159/159 通过。
- [x] Live test 新场景：A topic 查 Python bug → B topic 查天气 → 回到 A，A 的 evidence 不被 B 污染。（Slice E · 2026-04-22 MCP Chrome 跑通 3-turn 场景；pivot-back citations 全部 Python 语义，无 weather URL 泄漏；`sessionRecord.threads` / `activeThreadId` 持久化正常）
- [ ] 旧 session（无 threadId）自动 fallback `"default"`。（已在 evidence.js `normalizeEvidenceItem` 实现 — legacy metadata 无 threadId 默认落 `"default"`；Slice C 新写入全部携带 threadId）

---

### AGRUN-145 | P4 · Thread-Aware Compaction
| Field | Value |
|-------|-------|
| Type | Architecture |
| Priority | Medium |
| Status | **Done** (A+B+C+D+E shipped 2026-04-22) |
| Sprint | Phase 3 |
| Story Points | 3 |
| Labels | compaction, reliability |

**Summary:** 压缩按 thread 分组，并同步裁剪 `runState.toolContext.history` / `researchContext.readSources` —— 目前 [compaction.js:58](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js#L58) 只压缩 messages，工具轨迹不同步，导致 finalizer 看到孤立 evidence。

**依赖：** AGRUN-143（evidence 有 turnId）+ AGRUN-144（threadId）。

**Slice plan：** 单次提交会跨 5 类文件 × 20+ 调用点，走 slice 隔离每层风险。
- **Slice A** · thread/turn provenance tagging（2026-04-22 · 纯 additive，0 行为变更）。
- **Slice B** · `sessionStore` 摘要存储按 `(sessionId, threadId)` 索引（legacy single-slot 自动迁移到 `default` thread）。
- **Slice C** · `selectCompactionMessages` / `sliceAfterSummary` / `buildCompactionPrompt` 按 threadId 分组，每 thread 独立 prompt + summary 写入。
- **Slice D** · 压缩后在 `handle.js` 依 `(currentThread, oldestPreservedTurnId)` 裁剪 `toolContext.history` / `researchContext.readSources`。
- **Slice E** · MCP Chrome multi-thread 压缩 live smoke + docs + commit。

**Implementation：**
- 改 [src/session/compaction.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js) —
  - 按 `threadId` 分组 messages，每个 thread 独立 summary。
  - 压缩后通过 `oldestPreservedTurnId` 裁剪 `runState.toolContext.history` 和 `researchContext.readSources`（keep 条件：`entry.threadId === currentThread && entry.turnId >= oldestPreservedTurnId`）。
  - Thread 间 summary 永不混合。

**Acceptance Criteria：**
- [ ] 多 thread session 压缩后，每个 thread 的 summary 独立可读，不交叉引用。
- [ ] 压缩后 `toolContext.history.length` 与当前 window 的 message turnId 一致。
- [ ] Unit test：压缩前后 finalizer 给出的答案一致（no drift from compaction）。

**Progress：**
- ✓ **Slice A** · Provenance tagging（2026-04-22）— 压缩层的 grouping/trim 需要明确的 `(threadId, turnId)` 索引，Slice A 把它落到写入点，零行为变更。
  - [src/runtime/thread-provenance.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/thread-provenance.js) (new) — 单一 harness：`readActiveThreadId` / `readActiveTurnId` / `stampThreadProvenance` / `readProvenance`。Legacy / threads-disabled 运行时统一收敛到 `DEFAULT_THREAD_ID`；`turnId` 只在有 `runState.runId` 时落值，缺省 `null`（trim 逻辑需跳过）。已有 `_provenance` 的 entry 不会被覆写，保证幂等。
  - [src/runtime/action-loop-action.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-action.js) + [src/runtime/action-loop-plan-actions.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-plan-actions.js) — 5 处 push 点（`researchContext.readSources.push` ×2、`toolContext.history.push` ×3）全部用 `stampThreadProvenance(cloneValue(output), runState)` 包裹。`cloneValue` 先深拷贝，`stampThreadProvenance` 再添 `_provenance`，不污染原输出对象。
  - [src/session/messages.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/messages.js) — `createAssistantMessage` 读取 `result.runState.threadId` / `runId`，落到 message 级字段 `{threadId, turnId}`（非 metadata，便于存储层原生可见）。`createPendingUserMessage` + `normalizeSeedMessages` 默认 `DEFAULT_THREAD_ID` + `turnId:null`；真实 routing 在 [src/session/handle.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/handle.js) 的 userMessage 更新处追加戳。
  - [src/session/handle.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/handle.js) — userMessage `runId/status` 更新处同步写入 `threadId` / `turnId`（`runId` 兜底），仅 `readActiveThreadId` / `readActiveTurnId` 两个纯函数调用，不改动 routing 流程本身。
  - [test/unit/thread-provenance.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/thread-provenance.test.js) (new) — 10 case：helper 纯函数行为 + `createAssistantMessage` routed/legacy 分支 + pending user / seed messages 默认 provenance。智能插入到 `test/smoke.test.js` 的 unit-test manifest。
  - 测试：`npm test` 全通（含 compaction-cas / thread-hydration / topic-router / turn-intent-planner / memory-provenance / evidence-provenance / semantic-recall-scope 全量）；`examples/browser` `tsc --noEmit` 无 error。
- ✓ **Slice B** · 按 `(sessionId, threadId)` 存储 summary（2026-04-22）— 为 Slice C 的 per-thread 压缩提供存储基础；legacy single-slot 自动收敛到 `DEFAULT_THREAD_ID`。
  - [src/session/summary-key.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/summary-key.js) (new) — 单 harness：`composeSummaryKey(sessionId, threadId)` 合成复合 key `${sessionId}::${threadId}`（分隔符 `::`），`normalizeThreadId` 收敛空值到 `DEFAULT_THREAD_ID`，`ensureSummaryKeyFields(summary)` 在持久化前幂等补齐 `{id, threadId}`（id 就是复合 key，store keyPath 与 body 同步）。用 string composite key 而非 IndexedDB compound key，是因为 in-memory 用 `Map<string,…>` 原生支持，且单 keyPath 更便携。
  - [src/session/store-memory.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-memory.js) — `getSummary(sessionId, threadId)` 走 `composeSummaryKey`，`writeSummary` 调 `ensureSummaryKeyFields` 再写入；新增 `listSummaries(sessionId)` 过滤相同 sessionId、按 `updatedAt` 升序排序（Slice C 需要枚举 thread 列表才能逐个 trim）。
  - [src/session/store-indexeddb.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-indexeddb.js) — `DB_VERSION` 从 2 升到 3；`onupgradeneeded` v2→v3 删除旧 `summaries` store 再以 `keyPath: "id"` + `sessionId` 索引重建（summary 是可再生的，放弃 legacy 记录安全，下次 compaction 会以新 schema 重填）。`getSummary` / `writeSummary` / `listSummaries` 与 memory 保持同签名。
  - [src/session/store-resilient.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-resilient.js) + [src/session/store.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store.js) — `STORE_METHODS` / `validateSessionStore` 要求列表加入 `listSummaries`，避免外部注入的自定义 store 遗漏。
  - [src/session/compaction.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js) — `prepareProviderSessionContext` 派生 `compactionThreadId = threadScope?.threadId || DEFAULT_THREAD_ID`，`sessionStore.getSummary(sessionId, threadId)` + 写入 `proposed.threadId`。`resolveSummaryWrite` CAS check 同样按 threadId 读，保证两个不同 thread 的并发 turn 不会互相 clobber（各自独立 slot）。
  - [test/unit/summary-store-per-thread.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/summary-store-per-thread.test.js) (new) — 5 case：summary-key helper 正确性（含 `composeSummaryKey("", t)` 必须 throw）、per-thread round-trip、`listSummaries` 按 sessionId 过滤并按 `updatedAt` 升序、legacy 无 threadId 调用自动收敛到 DEFAULT 且不污染其他 thread slot、同 `(session, thread)` 重复写覆盖同一 slot 而非新增。
  - 测试：`npm test` 全通；`examples/browser` `tsc --noEmit` 无 error；`npm run build` dist 产出正常。
- ✓ **Slice C** · Thread-aware compaction grouping（2026-04-22）— Slice B 提供 storage key，Slice C 把 compaction pipeline 从 session-wide 切到 per-thread；planner + LLM 的上下文只看当前 thread 的 messages 和 summary，消除多 topic 交叉污染。
  - [src/session/prompt.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/prompt.js) —
    - 新增 `filterMessagesByThread(messages, threadId)` harness：单一入口，复用 `summary-key.js` 的 `normalizeThreadId`，legacy `threadId` 缺失 / 空串 collapse 到 DEFAULT_THREAD_ID，`threadId` 为空时原样 passthrough（shallow copy）。防止 `message.threadId || "default"` 散落在多个调用点。
    - `buildCompactionPrompt({ threadId })` 新增 Thread marker：当 `threadId` 是显式非-default 值时追加 `Thread: <id>` + `Only summarize messages belonging to this thread.`，告诉 LLM 这批 messages 是单 topic。default / 缺失时 prompt byte-for-byte 等同 Slice C 前，保 legacy 回归 0 风险。
  - [src/session/compaction.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js) —
    - `scopeThreadId = threadScope?.threadId || ""`；threads 关 or cross-thread-recall=on 时 `scopeThreadId=""`（walk-through 全量 messages）。router 给出 threadId 时走 `filterMessagesByThread`。
    - `threadScopedMessages` 替代 `completedMessages` 注入 6 处下游：`buildMemoryVariant` ×2、`sliceAfterSummary` ×2、`selectCompactionMessages`、`buildPreparedProviderInput` 的 messages 参数。Planner 看到的 provider conversation 就是 thread-scoped。
    - `summarizeSessionContext({ threadId: scopeThreadId })` 把 threadId 透传给 `buildCompactionPrompt`。`threadId` 为空时 marker 自动省略（legacy 输出对齐）。
  - [test/unit/compaction-thread-scoped.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/compaction-thread-scoped.test.js) (new) — 4 case：
    1) `filterMessagesByThread` 过滤 + legacy/empty bucket 到 DEFAULT + 空 threadId passthrough + null/invalid 防御。
    2) `sliceAfterSummary` 喂 thread-scoped list 时 stale `uptoMessageId` 不会把 sibling thread messages 带回。
    3) `buildCompactionPrompt` 仅在显式非-default threadId 时追加 `Thread:` marker（legacy / default 无差异）。
    4) `selectCompactionMessages` 在 filtered list 上对 `recentMessages` tail 做 per-thread reservation，避免多 thread 混合导致 tail 被隔开。
    测试同时断言未过滤路径会出现 cross-thread 尾部污染（Slice C 正是要阻断的 bug）。
  - 测试：`npm test` 全通（含 summary-store-per-thread + compaction-thread-scoped + 所有既有 thread / compaction / evidence 系列）；browser `tsc --noEmit` 无 error；`npm run build` dist 产出正常。
- ✓ **Slice D** · Post-compaction trim harness（2026-04-22）— 压缩产出 `oldestPreservedTurnId` 后，hydration 自动裁掉跨 thread 或早于 window 的 runState 遗留。今天 runState 每 turn 新建、tool/research list 都是空的 → 裁剪是 no-op；但当 per-thread 持久化落地时（thread-level `toolContext` 回填），这条 harness 保证回填数据不会把已压缩的 evidence 拉回——不会事后再补丁。
  - [src/runtime/thread-provenance.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/thread-provenance.js) —
    - 新增 `filterByThreadWindow(entries, { threadId?, oldestPreservedTurnId? })`：统一 harness，两参数都可选。legacy entry（无 `_provenance`）默认保留（迁移窗口），`turnId=null` 的 entry 保留（未落到具体 turn 的条目不该被 window 切掉），跨 thread entry 丢弃，早于 window 的 entry 丢弃。两参数都缺时返回 shallow copy（保持调用点可无差别调用）。
    - 新增 `trimRunStateForThreadWindow(runState, options)`：就地裁剪 `runState.toolContext.history` + `runState.researchContext.readSources`，两参数都缺时 fast-return，防护 null runState / null array 字段。
  - [src/runtime/run-state-thread.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/run-state-thread.js) — `hydrateRunStateWithThread` 接受 `compactionWindow: { oldestPreservedTurnId }`，若存在则自动调 `trimRunStateForThreadWindow`。兼容旧调用（不传 `compactionWindow` 时行为不变，即不 trim）。
  - [src/session/compaction.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js) —
    - 压缩后计算 `oldestPreservedTurnId`：`sliceAfterSummary(threadScopedMessages, { uptoMessageId: compactionMessages[last].id })[0].turnId`（即窗口第一条保留 message 的 turnId），没有保留 message 或 turnId 缺失时为 null。
    - 该 id 同时写进 `summaryRecord.oldestPreservedTurnId`（持久化，供重启后恢复）+ `prepared.compactionWindow = { oldestPreservedTurnId }`（进程内向 handle 透出）。两条路径（store-backed + legacy）都返回。
  - [src/session/handle.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/handle.js) — 构造 `threadHydrationPayload` 时把 `prepared.compactionWindow` 合并进 `threadRouting.hydration`；路由未命中时只带 `compactionWindow` 的最小 payload 也可被 `hydrateRunStateWithThread` 吃掉（防御性默认 null）。
  - [src/session/approval-resume.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/approval-resume.js) — `session_store` 复活路径把 `prepared.compactionWindow` 透回 caller；token_fallback + error 路径不携带（那些路径 runState 不会被我们 seed）。
  - [test/unit/compaction-window-trim.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/compaction-window-trim.test.js) (new) — 5 case：
    1) `filterByThreadWindow` 对 thread + window 组合的过滤（drop cross-thread + drop pre-window + keep legacy + keep null-turnId）。
    2) no-op 分支（只传 threadId / 只传 window / 两个都不传 / null / undefined input）。
    3) `trimRunStateForThreadWindow` 就地裁剪 tool history + readSources，空 options 是 safe no-op。
    4) `hydrateRunStateWithThread` 自动转发 compactionWindow 到 trim；不传 compactionWindow 时不 trim（保回归）。
    5) `stampThreadProvenance` + `filterByThreadWindow` round-trip（`runId=turn-42` 在 `turn-40` 窗口 keep，在 `turn-50` 窗口 drop）。
  - 测试：`npm test` 全通；`examples/browser` `tsc --noEmit` 无 error；`npm run build` dist 产出正常。
- ✓ **Slice E** · Live MCP Chrome browser smoke + docs（2026-04-22）— Slice A-D 的正确性在 Node 全绿，Slice E 验证同一 harness 在真实 Chromium + Vite ESM 下行为一致，关上"Node 过但 browser bundle 坏掉"的盲点。
  - **Live smoke** — Vite 已在 `:3000`，MCP Chrome 加载 `http://localhost:3000/?debug_yn=y` + 通过 `@fs` 直接 ESM-import `src/runtime/thread-provenance.js` + `src/runtime/run-state-thread.js`（Rollup 打包前同一份源代码）。5 assertion 全通：
    1) `filterByThreadWindow` 跨 thread + pre-window drop，legacy + null-turnId keep → `["e2","e4","e5-legacy"]`。
    2) 双参数都缺 → shallow-copy passthrough（新数组，same length）。
    3) `trimRunStateForThreadWindow` 就地裁剪 history+readSources → `["h3"]` / `["r2"]`。
    4) `hydrateRunStateWithThread({compactionWindow})` 自动触发 trim → `["new"]`。
    5) `stampThreadProvenance` + filter round-trip：`turn-42` 在 `turn-40` 窗口 keep，在 `turn-50` 窗口 drop。
  - **为什么不做端到端多 thread LLM 压缩的 live**：需要真 LLM + 可确定的 topic routing + token 预算触发 —— 这些 Node 层已有 `summary-store-per-thread` + `compaction-thread-scoped` + `compaction-window-trim` + `compaction-cas` 覆盖。剩下的 browser-only risk 是 "Vite/Rollup 打包会不会把 harness mangle 掉" —— 这个 live smoke 精确回答。
  - [agrun_docs/live-tests/agrun-145-slice-d-browser-smoke.md](../live-tests/agrun-145-slice-d-browser-smoke.md) (new) — 完整 test harness + 5 case 结果表 + 证据范围说明（`What this proves` / `What this does NOT prove`）。
  - [agrun_docs/context-and-continuity-model.md](../context-and-continuity-model.md) — 新增 "Thread-Aware Compaction (AGRUN-145)" 子章节：Slice A-D 对应 harness 表 + `filterByThreadWindow` 语义矩阵 + `oldestPreservedTurnId` 持久化理由 + threads-disabled 回归保证。
  - 测试：Node `npm test` 全通 + 浏览器 live smoke 5/5 PASS + `npm run build` dist 产出正常 + browser `tsc --noEmit` 无 error。

---

### AGRUN-146 | P5 · Goal Drift Detector
| Field | Value |
|-------|-------|
| Type | Feature |
| Priority | Medium |
| Status | **Done** (2026-04-22 · A+B+C shipped) |
| Sprint | Phase 3 |
| Story Points | 3 |
| Labels | planner, reliability |

**Summary:** 每 N cycle（默认 5）比较 "recent action trajectory" vs `turnState.goalAnchorText`，相似度偏离时注入 reminder 或强制 replan 信号。默认 Jaccard（复用 `tokenizeTopicText` + topic-scoring），可选 `similarityFn` host hook（embedding 等）。

**依赖：** AGRUN-144（`turnState.goalAnchorText` 已存在作为 GoalAnchor 近似）。

**Implementation（shipped）：**
- 新增 [src/runtime/drift-detector.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/drift-detector.js) — `detectDrift` / `computeTrajectorySignal` / `formatDriftReminder` / `DRIFT_DETECTOR_DEFAULTS`。Pure functions；默认 similarity = Jaccard over `tokenizeTopicText`；`similarityFn` hook clamp 到 `[0,1]` 并在抛错时降级为 `null`。
- 新增 [src/runtime/drift-detection-config.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/drift-detection-config.js) — `normalizeDriftDetectionConfig` 独立模块（config.js 有 `virtual:` bundler alias，单测无法直接 import；拆出来保纯函数）。
- 改 [src/runtime/action-loop-session-cycle.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-cycle.js) `beginActionLoopCycle` — `evaluateCycleDrift()` 在 `turnState` 组装后、`startPhase("decide")` 前运行，emit `drift-detected` step。
- 改 [src/runtime/action-loop-planner.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-planner.js) — `mergeDriftReminderIntoDirectives()` 把 reminder 追加到 `plannerDirectives` 末位（override-by-recency），消费后立即清 `runState.driftSignal` → 一次性 slot 不滚雪球。
- 改 [src/runtime/state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js) — `driftSignal: null` 作为 first-class field。
- Config：`runtimeConfig.driftDetection = { enabled: false, cycleInterval: 5, severeThreshold: 0.4, mildThreshold: 0.7, maxTrajectoryEntries: 5, similarityFn: null }`，默认 disabled；严重<0.4→force_replan，mild 0.4–0.7→inject_reminder，≥0.7→无动作；阈值倒置时 fallback 到默认带。

**Acceptance Criteria：**
- [x] 新增 `drift-detector.js` + `drift-detection-config.js` + 15 unit cases（`drift-detector.test.js` 8 cases + `drift-wiring.test.js` 6 cases + cross-module assertion）。
- [x] 严重 drift 时 `plannerDirectives` 追加 reminder（`formatDriftReminder` 产出固定文案）。
- [x] `enabled === false` 时 `evaluateCycleDrift` 直接返回 null，零调用开销（不走 similarity fn）。
- [x] MCP Chrome live smoke 8/8 PASS — 详见 [agrun_docs/live-tests/agrun-146-drift-detector-browser-smoke.md](../live-tests/agrun-146-drift-detector-browser-smoke.md)。
- [x] 文档：[agrun_docs/context-and-continuity-model.md § Goal-Drift Detector](../context-and-continuity-model.md#goal-drift-detector-agrun-146) 新章节（生命周期 + 配置表 + similarity 路径矩阵 + 一次性消费语义）；CHANGELOG + ADR 0002 + long-running 文档同步 ✓。
- [x] Node `npm test` 全通 + `npm run build` dist 产出正常。

---

### AGRUN-111 | Fix Gemini Native Tools Compatibility
| Field | Value |
|-------|-------|
| Type | Bug |
| Priority | High |
| Status | **Done** |
| Sprint | Phase 2 |
| Story Points | 3 |
| Labels | bug, provider |

**Summary:** 修复 Gemini provider 在 `plannerMode: "native_tools"` 下 planner request 失败的问题。

**Root Cause:** `toGeminiSchema()` 没有为 `ARRAY` 类型生成 `items` 字段。`final_answer` tool 的 `citations` 参数是 `array<string>`，Gemini API 收到缺少 `items` 的 schema 后拒绝请求。

**Fix:**
- `toGeminiPropertySchema()` — 新函数，正确处理 `ARRAY` + `items` 嵌套
- `planNextAction()` — native_tools 失败时自动降级到 envelope 模式

**Acceptance Criteria:**
- [x] 排查 `planner-tools.js` 中 `buildGeminiTools()` 的 tool schema 格式
- [x] 排查 `planner-tools.js` 中 `parseToolCallDecision()` 对 Gemini response 的解析
- [x] `gemini-native-tools-mode` live test PASS
- [x] `gemini-native-tools-search` live test PASS

---

## Recently Completed

| Key | Summary | Date |
|-----|---------|------|
| AGRUN-142 | Architecture: P1 Goal Anchor Injection Every Cycle — three-layer model (L1 `runState.originalQuery` run-scope · L2 `thread.goalAnchor.text` thread-scope mirrored to `runState.threadGoalAnchorText` · L3 `turnState.goalAnchorText` unchanged). New `src/runtime/goal-anchor.js` + `goal-anchor-config.js` harness; `captureOriginalQuery` (immutable existing-return contract) seeded once in `action-loop-session.js`; `applyRouterVerdict` seeds thread anchor on `new_thread`, `bumpThread` lazy-seeds legacy threads without overwriting. `buildPlannerSystemPrompt` injects `[ORIGINAL USER QUERY — DO NOT REINTERPRET]` + `[GOAL ANCHOR]` block between `roleBlock` and `dynamicSystemPrompt` (prompt-cache safe); `runtime-finalize.js` injects same block between role and final-response system prompt. 3-slice delivery (A harness / B wiring / C docs+live smoke). 31 new unit cases (22 harness + 9 wiring) + MCP Chrome 12/12 PASS. Disabled flag produces byte-identical prompts. | 2026-04-22 |
| AGRUN-146 | Feature: P5 Goal-Drift Detector — per-cycle `detectDrift` compares `turnState.goalAnchorText` against the last N `actionHistory` entries via default Jaccard (reuses `tokenizeTopicText` + topic-scoring) or a pluggable `runtimeConfig.driftDetection.similarityFn` hook. Severe <0.4 → `force_replan` reminder; mild 0.4–0.7 → `inject_reminder`. Verdict stashed on `runState.driftSignal`, appended last into `plannerDirectives` by `action-loop-planner.js`, and cleared immediately (one-shot slot, no snowballing). Disabled by default; throwing `similarityFn` degrades silently. 3-slice delivery (A harness / B wiring / C docs + browser smoke). 15 new unit cases + MCP Chrome 8/8 PASS. | 2026-04-22 |
| AGRUN-145 | Architecture: Thread-Aware Compaction — per-thread summary store (composite `${sessionId}::${threadId}` key), `filterMessagesByThread` + `filterByThreadWindow` harness, compaction emits `oldestPreservedTurnId` that hydration auto-applies via `trimRunStateForThreadWindow`. 5 slice delivery (A provenance / B store / C grouping / D trim / E browser smoke). 14+ new unit cases + MCP Chrome 5/5 PASS. | 2026-04-22 |
| AGRUN-141 | Feature: P0 Loop Convergence — composite session budget + action fingerprint 消灭无限 retry loop。新增 `action-fingerprint.js`（stable stringify + djb2 hash + `fingerprintAction`）+ `session-budget.js`（4 cap: `totalFailures=5` / `invalidDecisions=3` / `sameFingerprintRepeats=2` / `cyclesSinceProgress=5`），接入 `action-loop-session-loop.js` 顶部检查 + 执行前 fingerprint 记录；breach 时 force finalize 附 `describeBudgetBreach()` 文案。`runtimeConfig.budget: false` 可回滚。16 unit tests 覆盖四 cap 所有路径。| 2026-04-22 |
| AGRUN-116b | Refactor: Phase B 首攻 `action-loop-session-loop.js` 528 → 282 行 — 抽 `action-loop-session-decision-utils.js`（55 行, 决策工具 + 失败计数）+ `action-loop-session-result-kind.js`（38 行, 工具结果检查）+ `action-loop-session-terminals.js`（236 行, onBeforeFinalize + final/finalize veto + failure guard + direct final + fast path）。公共 API 不变。| 2026-04-22 |
| AGRUN-151 | Fix: planner argsSchema aliases — per-property aliases to absorb planner key drift; aliases preserved at registration in `normalizeToolParameters`; bundled-tool path wired; dist build-id refresh (commits 07f8c2dd / ca926755 / d675d5e4 / 49376d2c) | 2026-04-20 |
| AGRUN-150 | Fix: planner prompt injects skill instructions — root cause: skill instructions dropped from prompt after AGRUN-131 truncation, planner guessed wrong tool shapes (commit 01cdb6c8) | 2026-04-20 |
| AGRUN-149 | Feature: `onBeforeFinalize` fires on planner `type:"final"` direct-answer path — closes hook gap where direct answers skipped pre-finalize observer; docs updated with `planner_final` source label (commits 2a07d545 / 259e274f) | 2026-04-20 |
| AGRUN-148 | Fix: three live-test regressions surfaced by full 33/33 run (commit 459b5059) | 2026-04-17 |
| AGRUN-147 | Fix: P2 concurrency bugs — compaction summary CAS (compare-and-swap) to prevent stale summary overwrite + `runHook` timeout leak (pending timer cleared on resolve) (commit ab693e06) | 2026-04-17 |
| AGRUN-140 | Feature: Structured `argsPreview` on `action-executing` — sibling of `argsDigest` for inspector panels and AI-generated activity labels. Same PII-safety bounds (40-char trunc, depth-1, 6-key cap, arrays as `[N]`). Globe3 AI chatbox follow-up request after v0.2.1 integration. Additive, backwards compatible. | 2026-04-16 |
| AGRUN-139 | Feature: Action call correlation — `callId` on `action-executing`/`action-executed`/`action-execute-error` + sanitized `args` digest on `action-executing` for `execute_skill_tool` + symmetric captured-once `toolName`/`skillName`. Fixes Globe3 drawer pairing bug under parallel tool calls. New `src/runtime/action-step-args.js` sanitizer (PII-safe: 40-char truncation, depth-1, 6-key cap). Backwards compatible. | 2026-04-16 |
| AGRUN-138 | Feature: `toolCallExamples` config — custom `execute_skill_tool` envelope examples in planner prompt, reduces repair cascade retries for models that omit skillName/toolName | 2026-04-09 |
| AGRUN-137 | Fix: Inference fallback picks wrong tool across 67 同构 tools — guard rejects `execute_skill_tool` without skillName/toolName (triggers repair cascade); inference rejects ambiguous multi-match; prompt enforces REQUIRED fields | 2026-04-09 |
| AGRUN-136 | Fix: Planner missing tool parameter schema — `toSkillCatalogSummary()` now includes compact `args` hint with `object{subKey}` notation for nested params; `normalizeToolParameters()` preserves one level of nested object properties | 2026-04-09 |
| AGRUN-135 | Fix: Planner infinite loop — `hasReusableToolResult` fails when planner sends `toolName: null`, fallback inference re-executes same tool forever. Guard now forces finalize when lastResult exists and no toolName specified | 2026-04-09 |
| AGRUN-134 | Feature: Configurable debug logging — `createRuntime({ debug: true })`, `action-execute-error` step, `getActionRegistry()` | 2026-04-09 |
| AGRUN-133 | Fix: `execute_skill_tool` args mismatch — `readActionArgs` merges top-level `skillName`/`toolName` from planner decision | 2026-04-09 |
| AGRUN-132 | Tests: Add smoke tests for parseSkillMarkdown, loadAgentSkills, onToken contract — 12 new assertions | 2026-04-09 |
| AGRUN-131 | Fix: Planner prompt leaks full skill instructions — `bundledAgentSkills` now filtered through `toSkillPromptValue()`, saves ~8K tokens/call | 2026-04-09 |
| AGRUN-130 | Fix: `use_agent_skill` throws when planner skips `read_agent_skill` — auto-read fallback instead of throw | 2026-04-09 |
| AGRUN-129 | Feature: SSE token streaming — finalize phase uses `streamText()`, browser UI renders tokens progressively via `onToken` callback | 2026-04-09 |
| AGRUN-128 | Feature: Universal SKILL.md loader — `parseSkillMarkdown(text)` + `loadAgentSkills(manifestUrl)` for dynamic agent skill loading without rebuilding | 2026-04-09 |
| AGRUN-127 | Feature: Settings → Storage tab — per-store byte size visualization, stacked breakdown bar, Clear per store + Clear All, agrun-only data (no browser/origin noise) | 2026-04-09 |
| AGRUN-126 | Fix: Gemini grounding synthetic fallback — `groundingChunks` no longer returned by Google API since mid-2025; synthetic items from model text + ranking pipeline fix | 2026-04-08 |
| AGRUN-125 | Migrate LLM providers to AI SDK — `gemini-browser.js` + `openai-browser.js` rewritten with `generateText`/`streamText` from `ai`+`@ai-sdk/google`+`@ai-sdk/openai`; rollup bundling | 2026-04-08 |
| AGRUN-124 | Add consecutive action failure guard — same action fails 2x → force finalize, prevents infinite web_search retry loops | 2026-04-08 |
| AGRUN-123 | Add modular fetch resilience — `fetchWithTimeout`/`fetchWithRetry`/`withDeadline` in `fetch-resilience.js`; applied to all providers + web search action | 2026-04-08 |
| AGRUN-122 | Feature: Token usage & cost display — pricing table, Settings cost toggle, Header + MessageCard cost inline | 2026-04-08 |
| AGRUN-117 | Fix: `approval.js` delete mutation → null assignment (code review re-evaluation: 2/3 items were false positives) | 2026-04-08 |
| AGRUN-115 | Won't Fix: API Key sanitization — documented as host backend responsibility (see `agrun_docs/spec.md` Production Deployment Model) | 2026-04-08 |
| AGRUN-114 | Fix: Disabled read_url still triggers approval — missing disabledActions in approval resolution + hardcoded planner prompt | 2026-04-08 |
| AGRUN-103 | Feature: Persistent cross-session memory — IndexedDB global store, auto-promotion, Settings Memory tab | 2026-04-08 |
| AGRUN-113 | Feature: Agent Roles system — `roles/ROLE.md` + `parseRoleMarkdown()` runtime loader | 2026-04-08 |
| AGRUN-112 | Fix: Disabled actions (read_url) still executed via continuity decision bypass | 2026-04-08 |
| AGRUN-111 | Fix: Gemini native_tools — toGeminiSchema missing ARRAY items + envelope fallback | 2026-04-08 |
| AGRUN-101 | Epic: Live test coverage — 11→33 scenarios, all PASS | 2026-04-08 |
| AGRUN-107 | Feature: Native tool calling mode (`plannerMode: "native_tools"`) | 2026-04-08 |
| AGRUN-108 | Feature: LLM self-correction on action errors (`selfCorrection` config) | 2026-04-08 |
| AGRUN-109 | Docs: 6 architecture documents | 2026-04-08 |
| AGRUN-110 | Docs: Learnings from 11 sample projects | 2026-04-08 |
| AGRUN-100 | Fix: SettingsModal infinite render loop | 2026-04-08 |
| AGRUN-99 | Fix: Web search auto-mode fallback to gemini_grounding | 2026-04-08 |
| AGRUN-98 | Fix: Disable read_url when no endpoint (CORS prevention) | 2026-04-08 |
| AGRUN-97 | Enhancement: Links open in new tab | 2026-04-08 |

---

## Dependency Graph

```
Phase 1:  AGRUN-101 (Tests) ✓

Phase 2:  AGRUN-103 (Memory) ✓        AGRUN-111 (Gemini Fix) ✓     AGRUN-122 (Token/Cost) ✓
          AGRUN-116a (Split session) ✓  AGRUN-123 (Fetch Resilience) ✓
          AGRUN-124 (Failure Guard) ✓   AGRUN-125 (AI SDK Migration) ✓
          AGRUN-126 (Grounding Fix) ✓   AGRUN-127 (Storage Tab) ✓   AGRUN-128 (Skill Loader) ✓
          AGRUN-129 (SSE Streaming) ✓   AGRUN-130 (Skill Auto-Read) ✓  AGRUN-131 (Planner Prompt Fix) ✓
          AGRUN-132 (Tests) ✓  AGRUN-133 (Args Fix) ✓  AGRUN-134 (Debug) ✓  AGRUN-135 (Loop Fix) ✓
          AGRUN-136 (Arg Hints) ✓  AGRUN-137 (Inference Guard) ✓  AGRUN-138 (ToolCall Examples) ✓
                                         │
Phase 3:  AGRUN-105 (Error Recovery) ✓   AGRUN-106 (Observability)    AGRUN-118 (Test Split) ⚙
          AGRUN-119 (Memory Provider)    AGRUN-120 (Provider Failover) ← depends on 105
          AGRUN-116b (Remaining splits)  AGRUN-121 (ADRs)

Phase 3 (Long-Running & Multi-Topic, new):
          AGRUN-141 (Loop Convergence)   ✓ shipped 2026-04-22
          AGRUN-142 (Goal Anchor)        ✓ shipped 2026-04-22
          AGRUN-143 (Evidence Provenance) ✓ MVP shipped 2026-04-22; enables 145
          AGRUN-144 (Topic Router/Threads) ◐ Slice A+B+C+D+E shipped 2026-04-22 (router + Thread + hydration + evidence provenance + thread-scoped recall + MCP Chrome live smoke; keyTerms extractor tuning as follow-up)
          AGRUN-145 (Thread-Aware Compaction) ← depends on 143 + 144
          AGRUN-146 (Drift Detector)     ← depends on 142
```

## Notes
- **Frontend-only**: agrun.js 完全在浏览器中运行，不需要也不支持 Node.js 后端。
- **No MCP**: MCP 需要 stdio/server-side transport，与 frontend-only 架构不兼容，不列入 roadmap。
- **AI SDK**: LLM provider 层（`gemini-browser.js`, `openai-browser.js`）已迁移到 Vercel AI SDK v6 (`generateText`/`streamText`)。Web search grounding 仍用 raw fetch（需要直接访问 `groundingMetadata`）。
- **Gemini Grounding**: Google `google_search` tool 不再返回 `groundingChunks` URL（mid-2025 起）。已实现 synthetic fallback（从模型文本生成 items）。生产环境需要实际 URL 时应优先用 SearXNG。
- **Fetch Resilience**: 所有外部 HTTP 调用有 `fetchWithTimeout`/`fetchWithRetry`/`withDeadline` 保护。默认超时：LLM 60s, Search 15s, URL 10s, Search 多轮 45s。
- 不做大重构：每个任务都是增量改进，保持现有 API 兼容。
- Browser Example 是 agrun 的参考实现，不是独立产品；核心改进优先在 runtime 层。
- `sample project for study logic/` 目录仅作只读参考，不修改。
- 完成的任务归档到 Recently Completed，不删除。
- `plannerMode` 默认 `"envelope"`，Gemini native tools 修复后考虑切换默认值。
- `selfCorrection` 默认启用（maxRetries=2），可通过配置关闭。
- Live test 断言规则：assert signals not wording，fuzzy text match，skip on missing key。
- Agent Roles: 3 种传入方式 — 内置名称 (`"researcher"`)、对象 (`{ name, instructions }`)、`parseRoleMarkdown(text)` 从 ROLE.md 加载。
- `roles/` 目录下 3 个内置角色：`default`（通用）、`researcher`（深度研究）、`coder`（代码专家）。
- `sse-parser.js` 可删除 — AI SDK 迁移后不再需要手动 SSE 解析。
