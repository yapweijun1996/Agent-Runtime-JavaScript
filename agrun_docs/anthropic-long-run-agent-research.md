# Anthropic Long-Running Agent — Research Notes

> Research date: 2026-05-19  
> Sources: Anthropic "Building Effective Agents", Anthropic "Multi-Agent Research System", user-provided Anthropic long-running agent article  
> Purpose: Synthesize external patterns → map to agrun gaps → drive roadmap

---

## 1. 核心定义

**Long-Running Agent** = 可以跨多个 context window，工作数小时甚至数天的 AI Agent，不靠单次会话完成任务。

这和 agrun 当前的"long run" 有本质区别：

| 维度 | agrun 当前 | Anthropic Long-Run |
|------|-----------|-------------------|
| 持续时间 | 单 browser session（30-90 cycles） | 数小时到数天（多 session） |
| Context 跨越 | 单 context window | 多个 context window |
| 状态存储 | IndexedDB（browser-local） | 外部持久化（文件/DB/Git） |
| 中断恢复 | 不支持（关 tab = 结束） | 支持（每次 session 从检查点恢复） |

---

## 2. 核心问题（为什么 Long-Run 难？）

| 问题 | 说明 | agrun 对应状态 |
|---|---|---|
| **过度野心** | Agent 想一次做完整个项目，结果一半没做完就断了 | ✅ Session Budget + convergence signals 防止 |
| **假完成** | 下一个 session 的 Agent 看到已完成功能，以为全做完了 | ❌ agrun 无跨 session 状态验证 |
| **没有记忆** | 每次 context 重置，不知道上次做了什么 | ⚠️ IndexedDB 持久化但不跨 session |
| **无法测试** | 不知道自己有没有真正做对 | ⚠️ finalReadiness 是 AI 自判，非外部 oracle |

---

## 3. Anthropic 两阶段架构（Harness Pattern）

### Phase 1 — Initializer Agent（第一次启动）

```
职责：
- 分析整体任务，生成完整 feature list（可达 200+ 项）
- 建立 git repo + 进度追踪文件（PROGRESS.md 或类似）
- 写好 init.sh 初始化环境
- 设立 CLAUDE.md（项目蓝图，每个 session 必读）
- 建立 CHANGELOG.md（Agent 的"记忆"）
```

### Phase 2 — Coding Agent（后续每个 session）

```
每次 session 开始时：
1. 读 CLAUDE.md（获取项目上下文和规则）
2. 读 CHANGELOG.md（获取历史进度）
3. 跑诊断测试（Test Oracle）确认当前状态

每次只做 单个功能（incremental）：
4. 实现一个功能
5. 写测试，跑测试
6. git commit + descriptive message
7. 更新 CHANGELOG.md
8. browser automation e2e 测试

Ralph Loop（防假完成）：
- 当 Agent 声称"完成"时，强制重入检查循环
- 重读 PROGRESS 文件，验证实际状态
- 不一致 → 继续工作，不允许宣告 DONE
```

---

## 4. 关键工具（Scientific Computing 版本）

| 工具 | 作用 | agrun 对应 |
|---|---|---|
| `CLAUDE.md` | 持续更新的项目蓝图，Agent 每次读它 | ✅ GoalAnchor（L1，不可变目标锚定） |
| `CHANGELOG.md` | Agent 的"记忆"，记录完成/失败历史 | ⚠️ IndexedDB events（browser-only） |
| **Test Oracle** | 量化目标，让 Agent 自己判断有没有进步 | ⚠️ finalReadiness（AI self-declared，非外部验证） |
| **Git loop** | 每次有意义的工作就 commit，作为 checkpoint | ❌ 未实现（agrun 是虚拟 workspace，无 git） |
| **Ralph loop** | 强制 Agent 在"声称完成"时重新进入检查循环 | ✅ Terminal Repair State（功能对齐） |

---

## 5. Anthropic 官方 Agent 架构（Building Effective Agents）

### 5 种编排模式

| 模式 | 适用场景 | agrun 对应 |
|---|---|---|
| **Prompt Chaining** | 已知步骤序列，高精度 | ✅ TodoState 计划链 |
| **Routing** | 输入分类后走不同路径 | ✅ Topic Router（thread 路由） |
| **Parallelization** | 独立子任务并行 | ⚠️ 单 planner（无并行 subagents） |
| **Orchestrator-Workers** | 复杂任务分发给 worker agents | ❌ 未实现 |
| **Evaluator-Optimizer** | 生成-评估-迭代循环 | ✅ Terminal Repair State |
| **Autonomous Agents** | 开放式，步骤不可预知 | ✅ agrun 核心模式（OODAE loop） |

### 工具设计（ACI — Agent-Computer Interface）

```
Anthropic 的关键原则：
- 投入 ACI 设计的精力应 = 投入 HCI 设计的精力
- 用绝对路径代替相对路径（减少歧义）
- 工具错误必须是 AI-observable observations，不是 exceptions
- 写工具文档就像写给 junior 开发者的文档
```

> agrun 的 AGRUN-238 正是在执行这个原则：把 workspace_replace 的异常改成 AI 可观察的 observation。

### 风险管理

```
1. 沙箱测试（sandbox）
2. 检查点（checkpoints）for human feedback
3. 停止条件（stopping conditions = maxSteps）
4. 错误会复合放大 — 越早发现越好
```

---

## 6. Anthropic 多 Agent 研究系统

来源：https://www.anthropic.com/engineering/multi-agent-research-system

### 架构

```
Lead Agent（Orchestrator）
    ├── Subagent 1（并行）
    ├── Subagent 2（并行）
    └── Subagent 3（并行）

每个 Subagent：
- 有 explicit objectives
- 有 specific output formats
- 有 defined tool + source guidance
- 有 task boundaries
```

### 状态持久化策略

```
外部 Memory Storage 解决 context window 限制：
1. Lead Agent 将计划写入 Memory（持久化）
2. Context 快满时，spawn 新 subagent + 传递 handoff
3. 完成阶段后 summarize → 写入 Memory → 压缩 conversation history
4. 新 session 开始时读 Memory → 恢复上下文
```

### 关键发现

- 详细任务描述防止 subagents 做重复搜索（vague → duplicate work）
- 并行 3+ 工具调用 + 3-5 subagents 并行 → 时间减少 90%
- Effort budget 基于 query 复杂度动态分配

---

## 7. 核心原则

> **把 AI 当成人类工程师一样管理**  
> — 要有文档、incremental 提交、测试、进度追踪，这样 Agent 才能跨 session 不迷路。

| 原则 | 实现 |
|---|---|
| 简洁性 | 最小化设计复杂度 |
| 透明性 | 明确展示每步规划（不是黑盒） |
| 可测试性 | Test Oracle + incremental 验证 |
| 可恢复性 | Checkpoint + Ralph Loop 防假完成 |
| 工具质量 | ACI 和 HCI 同等优先 |

---

## 8. agrun 的差距分析

### 已实现（✅）

- AI-first 设计（11 处 push-mode 全部删除，ADR-0023~0026）
- GoalAnchor L1 目标锚定防漂移（ADR-0002）
- Multi-dimensional Session Budget（ADR-0002）
- TodoState 进度追踪（ADR-0010）
- Terminal Repair State（等同 Ralph Loop）
- Virtual Workspace + publish contract（等同 Test Oracle 的轻量版）
- IndexedDB + JSONL audit trail

### 差距（❌/⚠️）

| 差距 | 描述 | 优先级 |
|---|---|---|
| 跨 session 持久化 | 关 tab = 结束，无 checkpoint resume | Future（deferred） |
| Initializer/Coding Agent 分离 | 单 planner 无两阶段初始化 | Future |
| Git loop | 无 incremental commit 作为 checkpoint | Future |
| 外部 Test Oracle | finalReadiness 是 AI 自判 | 中期 |
| 并行 subagents | 无并行 worker agents | Future |
| 工具错误 → observation | AGRUN-238 修复中 | **P1（最急）** |
| Structure repair signal | AGRUN-237 PR2 pending | **P1** |

---

## 9. 对 agrun 路线图的影响

### 短期（当前 sprint）

1. **AGRUN-238**：workspace tool errors → AI-observable observations（直接对齐 ACI 原则）
2. **AGRUN-237 PR2**：structure_repair_micro_loop signal（防止 Ralph Loop 失效）

### 中期

3. **外部 Test Oracle**：让宿主系统注入可量化的成功标准（而非 AI 自判）
4. **跨 browser tab 持久化**：IndexedDB + BroadcastChannel 实现同设备跨 tab 恢复

### 长期（未来版本）

5. **Server-side durable execution**：queue + checkpoint + resume（对齐 Anthropic 真正的 long-run 场景）
6. **Initializer/Coding Agent split**：两阶段架构，Initializer 生成 plan，Coding Agent 逐步执行
7. **Parallel subagents**：Orchestrator-Workers 模式

---

## 10. 参考来源

| 来源 | URL | 核心内容 |
|---|---|---|
| Building Effective Agents | https://www.anthropic.com/research/building-effective-agents | 5 种编排模式、ACI 原则、风险管理 |
| Multi-Agent Research System | https://www.anthropic.com/engineering/multi-agent-research-system | 外部 Memory、并行 subagents、90% 效率提升 |
| Anthropic Long-Running Agent | 用户共享文章 | Initializer/Coding 两阶段、Ralph Loop、Test Oracle |
| ADR-0002 | agrun_docs/adr/0002-long-running-multi-topic-architecture.md | agrun 三层状态、Session Budget |
| ADR-0023~0028 | agrun_docs/adr/ | AI-first，zero push-mode |
