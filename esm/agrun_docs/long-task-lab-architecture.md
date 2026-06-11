# Long Task Lab — Architecture & Logic Reference

> Last updated: 2026-05-18  
> Path: `examples/long-task-lab/`

---

## 1. 概览

Long Task Lab 是一个**浏览器端 PWA 演示应用**，展示 agrun.js 运行长时 AI 任务的能力。它提供：

- 完整的任务配置界面（Provider / Model / API Key / Endpoints）
- 实时运行监控（Mission Control、Timeline、Evidence、Workspace）
- 历史记录持久化（IndexedDB）和导出（JSONL / eval dataset）
- 深色/浅色/系统主题，sidebar 折叠，PWA 安装

---

## 2. 目录结构

```
examples/long-task-lab/
├── index.html                  # PWA 入口，anti-flash script
├── public/
│   ├── manifest.webmanifest    # PWA manifest
│   ├── sw.js                   # Service Worker (cache-first)
│   └── icons/                  # icon-192/512/maskable
└── src/
    ├── main.tsx                # Entry: CSS imports + SW 注册 + React mount
    ├── App.tsx                 # 根组件：状态管理、路由、topbar/sidebar
    ├── index.css               # (已迁移，见 styles/)
    ├── styles/
    │   ├── tokens.css          # 设计 token（颜色/尺寸/字体/动效）
    │   ├── base.css            # 全局 reset + 排版
    │   ├── layout.css          # Admin shell 布局 + 响应式
    │   ├── buttons.css         # 按钮变体 + status-pill
    │   ├── forms.css           # 输入框、segmented、toggle、warning
    │   ├── panels.css          # 面板容器、section-heading
    │   ├── cards.css           # metric/fact/timeline/empty-state
    │   └── records.css         # Records 表格、reader、markdown
    ├── components/
    │   ├── TaskSetupPanel.tsx
    │   ├── MissionControlPanel.tsx
    │   ├── TimelinePanel.tsx
    │   ├── FinalArtifactPanel.tsx
    │   ├── EvidencePanel.tsx
    │   ├── WorkspacePanel.tsx
    │   ├── RecordsPanel.tsx
    │   ├── DebugPacketPanel.tsx
    │   ├── EmptyState.tsx
    │   └── MarkdownReport.tsx
    └── runtime/
        ├── lab-state.ts            # 类型定义 + LabRun 状态操作
        ├── lab-runner.ts           # runLabMission() 主执行器
        ├── lab-record-schema.ts    # 事件 schema + 脱敏
        ├── lab-record-store.ts     # IndexedDB CRUD
        ├── lab-record-projector.ts # 异步写入管道
        ├── lab-record-view.ts      # 事件聚合显示
        ├── lab-record-filters.ts   # 运行列表过滤
        ├── lab-record-dataset.ts   # eval dataset 导出
        ├── lab-timeline-insights.ts # Timeline 分组 + Debug 诊断
        ├── lab-presets.ts          # 内置任务模板
        ├── lab-pwa.ts              # Service Worker 注册
        ├── lab-debug.ts            # 脱敏 + 序列化工具
        └── lab-jsonl.ts            # JSONL 解析/序列化
```

---

## 3. 核心状态类型

### LabSettings（持久化到 localStorage）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | `'openai' \| 'gemini' \| 'custom'` | `'openai'` | LLM 服务商 |
| `model` | string | `'gpt-5-mini'` | 模型 ID |
| `openaiApiKey` | string | `''` | OpenAI API Key |
| `geminiApiKey` | string | `''` | Gemini API Key |
| `customEndpoint` | string | `''` | 自定义兼容 endpoint |
| `customApiKey` | string | `''` | 自定义 API Key |
| `customApiVariant` | `'chat' \| 'responses'` | `'chat'` | API 协议 |
| `maxSteps` | number | `80` | 最大运行周期数 |
| `autoApproveTier1` | boolean | `false` | 自动批准 web_search / read_url |
| `webSearchEndpoint` | string | `''` | SearXNG 或搜索 API URL |
| `readUrlEnabled` | boolean | `true` | 启用 read_url 工具 |
| `readUrlEndpoint` | string | `''` | Read URL 服务 URL |
| `readUrlApiKey` | string | `''` | Read URL 服务 Key |

### LabRun（内存态，随执行实时更新）

```typescript
interface LabRun {
  id: string                         // 'lab-<uuid>'
  status: LabRunStatus               // idle|preparing|executing|blocked|completed|failed|interrupted
  startedAt?: number                 // Date.now()
  endedAt?: number
  prompt: string
  settings: LabSettings

  // 执行计数
  runtimeStepCount: number
  steps: LabTimelineStep[]           // 最多保留 120 步

  // 输出
  streamedText: string               // token 流拼接
  tokenText: string
  finalArtifact: string              // 最终干净输出

  // 子状态摘要
  evidence: LabEvidenceSummary       // 搜索/读取结果
  workspace: LabWorkspaceSummary     // 虚拟工作区文件
  quality: LabQualitySummary         // 质量评估

  // 诊断
  debug: Record<string, unknown>
  latestAction: string | null
  todoState: Record<string, unknown> | null
  errorMessage?: string | null
  runId?: string | null
}
```

---

## 4. 数据流

### 启动一次运行

```
App.tsx: startRun()
  │
  ├─ 创建 AbortController
  ├─ setRun({ status: 'preparing', startedAt })
  ├─ setActivePage('run')
  │
  └─► runLabMission({ initialRun, onRunChange, prompt, settings, signal })
       │
       ├─ createRuntime(config)         ← agrun.js 运行时
       ├─ runtime.createSession()
       ├─ session.run(input, hooks)
       │   │
       │   ├─ onToken(token)
       │   │   └─► appendToken(run, token) → onRunChange
       │   │
       │   └─ onStep(step, snapshot)
       │       ├─► applyRuntimeStep(run, step, snapshot)
       │       │    ├─ 追加 timeline step（保留 120）
       │       │    ├─ 更新 evidence / workspace / quality 摘要
       │       │    └─ 更新 latestAction / todoState
       │       ├─► projector.recordRuntimeStep() → IndexedDB
       │       └─► onRunChange(updater) → setRun() → React re-render
       │
       └─ 运行结束
           ├─► applyRuntimeResult(run, result)   ← 设置 finalArtifact、status
           ├─► projector.recordArtifact()
           ├─► projector.recordRunEnd()
           └─► refreshRecords(nextRun.id)         ← 刷新历史列表
```

### React 渲染更新链

```
setRun(updatedRun)
  ├─ MissionControlPanel  ← runtimeStepCount, latestAction, todoState, debug
  ├─ TimelinePanel        ← steps → createTimelineInsights() → 分组展示
  ├─ FinalArtifactPanel   ← finalArtifact, quality, errorMessage
  ├─ EvidencePanel        ← evidence (queries, sources, gaps)
  ├─ WorkspacePanel       ← workspace (files, stats, publishState)
  └─ DebugPacketPanel     ← debug, createDebugInsights()
```

---

## 5. 持久化层（IndexedDB）

`lab-record-store.ts` 管理三个 store：

| Store | 内容 | 索引 |
|-------|------|------|
| `runs` | `LabRunRecordSummary`（运行摘要） | `updatedAt`, `status` |
| `events` | `LabRecordEvent`（逐步事件） | `runRecordId`, `at`, `type` |
| `artifacts` | 最终输出文本 | `runRecordId` |

**事件类型：**

| 类型 | 触发时机 |
|------|---------|
| `run_start` | session.run() 开始前 |
| `runtime_step` | 每个 onStep 回调 |
| `state_snapshot` | 里程碑节点 |
| `artifact` | finalArtifact 产生时 |
| `run_end` | 运行结束 |
| `qa_note` | 用户手动标注 |

**脱敏策略：** API Key、token、credential 类字段在写入前统一替换为 `[redacted]`，模式匹配 `sk-*`、`AIza*`、`Bearer *`。

---

## 6. Timeline 分组逻辑

`createTimelineInsights(steps)` — 连续相同 (category, status, actionName) 的步骤合并为一条：

| Category | 触发关键词 |
|----------|-----------|
| `evidence` | search, read_url, source, web_search |
| `workspace` | workspace, publish, candidate, artifact, write, file |
| `recovery` | repair, recover, retry, gap, requirement, terminal |
| `progress` | plan, todo, step, action |
| `blocked` | blocked |
| `failed` | failed, error |

`createDebugInsights(run)` — 产生 8-10 个健康指标（tone: neutral/good/warning/danger）。

---

## 7. 内置预设（lab-presets.ts）

| ID | 标题 | 任务类型 |
|----|------|---------|
| `market-research` | Market Research Memo | 市场研究，要求 ≥3 来源 |
| `vendor-comparison` | Vendor Comparison | 三方案对比表 + 推荐 |
| `debug-investigation` | Debug Investigation | 根因分析 + 下一步行动 |

每个预设包含 `id`, `title`, `prompt`, `acceptance`（成功标准）。

---

## 8. Provider 支持

| Provider | API Key 字段 | 搜索支持 | 备注 |
|----------|-------------|---------|------|
| OpenAI | `openaiApiKey` | 需外部 webSearchEndpoint | `chat` 或 `responses` 变体 |
| Gemini | `geminiApiKey` | 原生 grounding search | 不需要额外搜索 endpoint |
| Custom | `customApiKey` + `customEndpoint` | 需外部 webSearchEndpoint | 任意 OpenAI 兼容 API |

Read URL 服务（`readUrlEndpoint`）是可选中间件，让 AI 能读取 JS 渲染页面的内容。

---

## 9. UI 架构

### 页面路由（6 个 Page）

| PageId | 组件 | 说明 |
|--------|------|------|
| `setup` | TaskSetupPanel | 配置 Provider、Model、Key、Prompt |
| `run` | MissionControlPanel + TimelinePanel + FinalArtifactPanel | 实时监控 |
| `evidence` | EvidencePanel | 搜索查询 + 读取来源 |
| `workspace` | WorkspacePanel | 虚拟文件 + 字数统计 |
| `records` | RecordsPanel | 历史记录浏览 + 导出 |
| `debug` | DebugPacketPanel | 内部状态 + 诊断指标 |

### 布局系统

- **Admin shell**: CSS Grid (`52px topbar + sidebar + content`)
- **Sidebar 折叠**: CSS custom property `--sidebar-w: 220px → 56px`，纯 CSS transition
- **Theme**: `data-theme` attribute 驱动，3 态（dark/light/system），anti-flash blocking script
- **Mobile**: `≤860px` breakpoint，sidebar 隐藏，底部 nav bar
- **PWA**: manifest + sw.js + beforeinstallprompt 安装提示

### CSS 文件结构（SSOT，8 文件）

```
tokens.css → base.css → layout.css → buttons.css
→ forms.css → panels.css → cards.css → records.css
```

Lighthouse 分数：Accessibility 100 / Best Practices 100 / SEO 100（桌面 + 移动端）。

---

## 10. 运行时注入指令

`runLabMission` 向 planner 注入的关键指令：

1. 把 prompt 视为长时任务 Mission
2. 用 TodoState 追踪可见进度
3. 先用 web_search + read_url 收集证据，再起草
4. 在虚拟 workspace 起草、检查，再发布干净 artifact
5. 无法完成时诚实地给出 gaps 和下一步

---

## 11. 关键设计决策

| 决策 | 原因 |
|------|------|
| 无 Redux/Zustand | 单根 useState + 回调，够用且简单 |
| IndexedDB 异步写入串行化 | `writeTail` promise chain，避免竞态 |
| 脱敏在写入时执行 | 防止 API Key 泄漏到 JSONL 导出 |
| Timeline 步骤最多保 120 | 避免长任务内存爆炸 |
| CSS SSOT 8 文件 | 每文件单一职责，维护路径线性 |
| SW 只在 production 注册 | 避免开发时 cache 干扰 |
