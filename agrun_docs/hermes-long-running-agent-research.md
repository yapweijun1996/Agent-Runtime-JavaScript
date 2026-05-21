# Hermes Agent — Long-Running Task 架构研究

> Research date: 2026-05-19  
> Purpose: 理解 Hermes agent 如何突破 context window 做长运行任务 → 找到 agrun 的对应差距  
> Sources: Hermes research (Nous Research), LangGraph docs, general agent framework patterns

---

## 1. 核心问题定义

**为什么 Long-Running Agent 难？**

| 挑战 | 说明 |
|------|------|
| Token overflow | 多轮对话历史超过模型 context window |
| Crash recovery | Agent 中途崩溃，无法从上次断点恢复 |
| State confusion | 跨 session 时 agent 不知道上次做了什么 |
| Cost explosion | 长运行 = 每次都把全部历史塞进 prompt → 费用极高 |

---

## 2. Hermes Agent 的解决方案架构

Hermes agent（Nous Research, 2026）通过以下 5 个机制实现长运行：

### 2.1 SQLite WAL 持久化（Persistent State）

```
设计：
- agent 运行状态、task history、learned skills → 存 SQLite
- WAL (Write-Ahead Log) 模式 = crash-safe 事务写入
- 每个 tool call 执行后写 checkpoint，不等 session 结束

关键属性：
- 跨 session 可以恢复：agent 重启后读 SQLite 恢复状态
- 历史可查询：不依赖 prompt 里的 memory，独立存储
- 可 fork/replay：从任意 checkpoint 恢复调试
```

**vs agrun 现状：**
- agrun 用 IndexedDB（browser-local），关 tab = 状态丢失
- 无 WAL 级别的原子写保证，无跨 tab/session resume

### 2.2 Session Lineage（parent_session_id）

```
设计：
- 每次 session 有唯一 id
- 子 session 带 parent_session_id 指向父 session
- 形成树形结构：task → subtask → sub-subtask

作用：
- Agent 知道"我从哪里来"，可以追溯目标
- 失败时可退回到父 session 的最后 checkpoint
- 支持 orchestrator → worker agents 的层级执行
```

**vs agrun 现状：**
- agrun 每次 `session.run()` 独立，无 parent 链接
- 无法追踪 agent 任务树的层级关系

### 2.3 Auxiliary LLM Compaction（辅助 LLM 压缩）

```
设计：
- context 快满时，用"辅助 LLM"（同一个或更便宜的模型）总结历史
- 总结格式：Resolved / Pending / Remaining（结构化）
- 主 LLM 只接收压缩后的 summary，不是完整历史

关键区别（Hermes vs agrun）：
- Hermes：auxiliary model = 专门配置的辅助模型（可以是不同的/更便宜的模型）
- agrun（已实现）：用 user-selected model（同一模型）执行 compaction
- agrun 本次 session 已完成：compaction usage → costLedger + cumulativeUsage 追踪
```

### 2.4 Stateful Stream Scrubbers（有状态流过滤器）

```
问题：
- 长运行 agent 的 SSE 流可能跨多个 HTTP 连接
- chunk 可能在 chunk 边界被截断（split SSE boundary）
- 不处理 → 解析出错 / 内容丢失

Hermes 解法：
- 每个 SSE 连接维护有状态的 scrubber
- scrubber 记住上一个 chunk 的"残留"
- 新 chunk 到来时先拼接残留，再解析完整事件

agrun 现状（❌ 缺失）：
- 流处理是无状态的（每个 response 独立处理）
- 如果提供商的流在 JSON 边界断开，可能静默丢数据
```

### 2.5 Self-Registering Tool Registry（自注册工具）

```
设计：
- Skills/Tools 在 init 时自动注册到 registry
- agent 通过 registry 发现可用工具，不需要硬编码
- 支持动态加载新工具（runtime 不重启）

好处：
- 新增工具只需实现 interface，无需修改 agent 核心
- 支持 plugin-like 架构，适合第三方扩展

agrun 现状（⚠️ 部分）：
- skills 在 createRuntime() 时静态注册
- 无动态加载，无 runtime 发现机制
```

---

## 3. LangGraph 的 Checkpoint 机制（对比参考）

LangGraph（Python，生产级）的做法给 agrun 提供了参考：

```
每个 agent 步骤 = 一个 graph node
每个 node 执行后 → Checkpointer 保存完整 state
```

```python
# LangGraph checkpoint 概念
checkpointer.put(checkpoint_id, state)  # 每步后写
state = checkpointer.get(checkpoint_id) # resume 时读
```

**关键原则：Agent state 是一等公民（first-class entity），独立存储，不是 prompt 的副产品**

---

## 4. 通用 Long-Running Agent 设计模式

| 模式 | 描述 | Hermes | LangGraph | agrun |
|------|------|--------|-----------|-------|
| **Persistent Checkpoint** | 每步写状态，支持 resume | ✅ SQLite WAL | ✅ Checkpointer | ❌ 无 |
| **Session Lineage** | parent_session_id 追踪任务树 | ✅ | ✅ Thread ID | ✅ AGRUN-240 Done |
| **Selective History Load** | 不把全部历史塞进 prompt | ✅ | ✅ | ⚠️ compaction |
| **Auxiliary Compaction** | 辅助 LLM 总结 middle turns | ✅ 独立模型 | ⚠️ 手动 | ✅ 已实现（同模型）|
| **Stateful SSE Scrubbers** | 处理 split chunk 边界 | ✅ | N/A | ✅ AI SDK 已内建（AGRUN-241 Won't Fix）|
| **Self-Registering Tools** | 动态工具发现 | ✅ | ✅ | ✅ 已具备（AGRUN-P5 Won't Fix）|
| **Overwrite-Oscillation Guard** | flash-lite write-overwrite stall → hard_veto | ✅ 类似 | N/A | ✅ AGRUN-237-GAP-04 Done |
| **Cross-session Resume** | 关闭后重启可继续 | ✅ 服务端 | ✅ DB | ❌ browser-only |

---

## 5. agrun 的差距分析（更新版）

### 当前能力等级

```
agrun 当前 = "Session-Long Agent"（单 browser session，30-90 cycles）
Hermes   = "Multi-Day Agent"（跨多 session，数小时到数天）
```

### 差距优先级

| 优先级 | 差距 | 描述 | 实现难度 |
|--------|------|------|---------|
| **P1 ✅ CLOSED** | Compaction cost tracking | 已在 2026-05-19 完成 | — |
| **P2 ⚠️ Phase 1 Done** | Planner system prompt cache stability | AGRUN-239 Done 2026-05-19：原始"skills 移出 system prompt"假设有误（skills 已在 user message loopState）；实际缓存杀手是 `todoStateBlock`，已移出 system prompt → user message "Plan state:" section。Phase 2 pending：envelope `allowFinalize` terminal policy（workspace 文件出现时系统提示变化）| Phase 1: — / Phase 2: 中 |
| **P3 ✅ CLOSED** | Session lineage `parent_session_id` | AGRUN-240 Done 2026-05-19：sessionRecord 加 parentSessionId，session.run() 支持传入 | — |
| **P4 ✅ Won't Fix** | Stateful SSE stream scrubbers | AGRUN-241 Won't Fix 2026-05-19：code research 确认两个 provider 均委托 AI SDK streamText()，已内建 SSE residual buffer | — |
| **P5 ✅ Won't Fix** | Self-registering tool registry | Won't Fix 2026-05-19：code research 确认 agrun 已具备 plugin 架构（`{ name, canHandle, execute }` + `createRuntime({ skills })`）；唯一差距是 post-init mutation，但无具体 use case 且与 AGRUN-239 prompt cache 稳定性冲突 | — |
| **P6 ✅ CLOSED** | Write-overwrite oscillation guard | AGRUN-237-GAP-04 Done 2026-05-19：`workspaceMutationGrowthConvergence`，delta.words < 30 + deficit → stall counter；advisory@2，hard_veto@3，blocks workspace_write，recovery via workspace_append | — |
| **Future** | Cross-session checkpoint/resume | 服务端持久化，跨 tab/session 恢复 | 极高（需后端） |
| **Future** | Orchestrator-Workers 并行 | 多 subagents 并行，效率提升 90% | 高 |

---

## 6. agrun 路线图建议

### 短期（已结案）

```
P2: ✅ Phase 1 DONE — AGRUN-239 (2026-05-19)
- 原始假设错误：skill catalog 已在 user message loopState，不在 system prompt
- 实际缓存杀手：todoStateBlock（每轮变化的 TodoState 窗口）在 buildPlannerSystemPrompt
- 修复：todoStateBlock 移到 buildPlannerPrompt user message "Plan state:" section
- 4 assertions PASS（test/unit/agrun-239-system-prompt-stability.test.js），system prompt byte-stable
- Phase 2 pending：envelope allowFinalize terminal policy（workspace 文件出现时变化）
  → 影响文件：planner-envelope-lines.js:119（workspace_publish_path_required）
```

### 中期（已全部结案）

```
P3: Session lineage ✅ DONE — AGRUN-240 (2026-05-19)
- sessionRecord.parentSessionId: null，session.run({ parentSessionId: 'abc' }) 支持传入
- result.runState.parentSessionId 正确投影
- test/concerns/agrun-240-parent-session-id.test.js 3 assertions PASS

P4: Stateful SSE scrubbers ✅ Won't Fix — AGRUN-241 (2026-05-19)
- code research 确认两个 provider 均用 AI SDK streamText()，已内建 SSE residual buffer
- agrun 无自定义 SSE 解析代码，Hermes 研究假设有误

P5: Self-registering tool registry ✅ Won't Fix (2026-05-19)
- code research 确认 createRuntime({ skills }) 已是 plugin 架构，getActionRegistry() 已实现发现机制
- 唯一差距 post-init mutation 无具体 use case，且与 AGRUN-239 prompt cache 冲突
```

### 长期（Browser 环境限制内的最优解）

```
由于 agrun 是 browser-native：
- 真正的跨 session checkpoint/resume 需要服务端支持
- 短期内在 browser 环境下的最优解是：
  1. IndexedDB 持久化所有 session state
  2. BroadcastChannel 实现跨 tab 同步
  3. Service Worker 作为"后台代理"保持 agent 运行
  
但这本质上是把 server 功能搬到 browser，有明确上限。
最终长运行场景需要 agrun 支持 server-side runner（未来版本）。
```

---

## 7. 结论

> Hermes 能做 long-running agent 的核心原因：**它在服务端运行，有持久化存储（SQLite WAL），有 session lineage，有 stateful stream 处理**。

agrun 当前是 browser-native，天然限制了它的持久化能力。在当前 scope 内，最值得做的改进是：

1. **P2 Planner system prompt cache stability** ⚠️ Phase 1 ✅ DONE (AGRUN-239, 2026-05-19)；Phase 2 pending（envelope allowFinalize terminal policy）
2. **P3 Session lineage** ✅ DONE (AGRUN-240, 2026-05-19)
3. **P4 SSE scrubbers** ✅ Won't Fix (AGRUN-241, 2026-05-19) — AI SDK 已内建
4. **P5 Self-registering tools** ✅ Won't Fix (2026-05-19) — agrun 已具备 plugin 架构
5. **P6 Write-overwrite oscillation guard** ✅ DONE (AGRUN-237-GAP-04, 2026-05-19) — `workspaceMutationGrowthConvergence`，delta-based signal，hard_veto@3 stalls

---

*参考：agrun_docs/anthropic-long-run-agent-research.md（Anthropic 模式），agrun_docs/adr/0002-long-running-multi-topic-architecture.md（agrun 设计决策）*
