# Harness Engineering 2026：以 agrun.js 为实证的 AI-first 浏览器代理 runtime 深度报告

> 范围：基于 `agrun/0_development` 当前主干（HEAD `2fe6d8bb0` "New"，2026-05-10）的代码图谱、`agrun_docs/`、`task.md` 路线图，以及通过 Chrome DevTools MCP 对 `examples/browser` 真实 Gemini API e2e 的可观察输出。
>
> 目标读者：刚接触 harness engineering 的初级工程师，需要理解“为什么 2026 年的 AI 浏览器 runtime 不再是控制器，而是一具骨架（harness）”。

---

## 1. 核心命题：Runtime 不做 AI 的工作

2026 年 agrun.js 的项目守则只有一句话能完整概括：**“Do not let runtime do AI work.”**（CLAUDE.md，2026-05-10）。这不是口号，是经过四个 sprint 的反复违规与回滚才确立的契约。仅 2026-05-09 至 2026-05-11 这一周，task.md 就记录了三次重大“push-mode 删除”：

1. **`virtual_workspace_publish` 四个 throw 中的三个**被改写成 `control:"continue"` + `kind:"virtual_workspace_publish_blocked"`，AI 把阻塞当作下一轮观察，runtime 不再因不匹配 write→finalize→read→publish 协议而清掉 53 个 cycle。
2. **`parseRequestedLength` + `findRelevantSkillMatch`**（runtime 用正则解析“3000 字”、用 token-overlap 匹配最合适的 skill）整体撤销。即使它把 e2e 交付率从 17% 拉到 71%，仍然被定性为“runtime 在做 AI 的语义工作”，删除后回到 44% 的诚实基线。
3. **三条英文 prompt 正则**（COMPLEX_PROMPT_RE、FINAL_CANDIDATE_GATE_PROMPT_RE、STRICT_RESEARCH_WORKSPACE_PROMPT_RE）连同 regex-gated veto 一起删除；workspace 激活变成显式 host 配置或 AI 自己调 `workspace_write`。

**Underlying Principle**：传统 runtime 把“判断”留给规则、把“执行”留给 LLM；harness engineering 反过来——把“判断”留给 LLM，把“可观察的事实”留给 runtime。runtime 只能做四件事：暴露能力、记录事实、保存状态、把观察推回下一轮 prompt。**任何一处 runtime 替 AI 决定“够好/不够好”、“相关/不相关”、“是/否要再写一轮”都是 push-mode**，必须删除。

---

## 2. 代码图谱速览：harness 的骨架长什么样

通过 codeloom（4324 nodes / 12230 edges）查询 `agrun` 索引，runtime 的入口结构非常薄：

```
src/runtime/runtime.js          → createRuntime(options)         // 13–130 行，仅 117 行
   ├── normalizeRuntimeConfig   (config.js)
   ├── createApprovalSigner     (approval-signing.js)
   ├── createSessionStore       (session/store.js)
   └── runLoop                  (run-loop.js)                    // 真正的 OODAE 循环
```

`createRuntime` 只做四件事：归一化配置、装签名器、装 session store、把 `run / createSession / openSession / getState / getMemory / getRuntimeConfig / getAgentSkills / getActionRegistry` 这八个稳定 API 暴露出去。**它不知道 OODAE 是什么、不知道 workspace 是什么、不知道 finalize 的语义。** 那些都在它委托给 `runLoop` 之后才发生。

围绕 `action-loop-*.js` 的 13 个文件（planner / action / continuation / failure / outcome / plan / planner / session / terminal / utils 等）拆得非常细，每个模块只承担一个 verb：planner 负责拼 prompt、action 负责执行、observation 在 outcome 里、evaluation 在 evaluator 里、终止条件在 terminal 里。这种**“一个文件一个 verb”** 的拆法不是为了好看，是为了让 push-mode 容易被发现——任何一个文件如果开始读取 prompt 内容做语义判断（“这看起来像 research 任务”），它马上违反单一职责，rebase 时 diff 会很显眼。

---

## 3. AI-first runtime 的三层契约

agrun.js 的契约可拆成三层，从下到上：

### 3.1 能力层（Capabilities）：runtime 暴露动作清单

`getActionRegistry()` 返回 `{ name, description, tier }` 列表。actions 包括 `web_search`、`read_url`、`workspace_write`、`workspace_finalize_candidate`、`workspace_publish_candidate`、`list_agent_skills`、`read_agent_skill`、`use_agent_skill`、各类 `repo_file_*` 等。**runtime 不预选哪个 action 该用**，只把 description 拼进 planner prompt；AI 看完描述自行选择。

### 3.2 事实层（Facts）：runtime 把可观察状态推回 prompt

这是 harness engineering 最关键的发明：`virtualWorkspace` 的状态、`successfulReadSources` 数量、`workspaceStats=chars/nonWhitespace/cjk/words`、`publish_protocol_state=finalized_after_write:yes|no, read_after_finalize:yes|no` 等等，全都以**只读 fact line** 的形式出现在 planner prompt 的 Workspace block。AI 看到 `final_candidate_cjkChars=503` 和 `user_requested_length=3000`，自己决定要不要继续写。runtime 不会因为 503 < 3000 就 throw。

### 3.3 决策层（Decisions）：AI 通过 envelope 输出 `finalReadiness`

AI 必须显式声明 `finalReadiness:{decision: "ready"|"limited"|"insufficient", evidenceMode, limitations, requirementsAssessment:{checkedReadinessAgainstUserRequest, checkedReadUrlEvidence, checkedWorkspaceStats, lengthSatisfied, evidenceSatisfied, observedLength, requestedLength, ...}}`。runtime 只检查“契约是否填满”，**绝不二次评判** `lengthSatisfied=false` 是否应当阻止 publish。

> **观察证据（live e2e，2026-05-10 14:08）**：在“2026 AI 浏览器 3000 字调研报告”这个 chat 里，`workspaceStats=chars=2163/nonWhitespace=1950/cjk=1074/words=126`、`successfulReadSources=0`（因为 readurl 服务 502），AI 自己声明 `decision:"limited"`、`lengthSatisfied:false`、`evidenceSatisfied:false`、`limitations:"由于当前网络调研中 read_url 服务多次出现不可用情况……字数未达 3000 字"`，然后调用 `workspace_publish_candidate`。Inspector 显示一条非阻塞文本：“Runtime did not block the AI decision; Inspector is showing a non-blocking audit mismatch between AI-declared readiness and observed state.” 这一句正是 harness 的招牌。

---

## 4. Inspector：让 AI 与人类用同一双眼睛看 runtime

Harness engineering 的另一半是**可观察性**。一个 AI-first runtime 如果调试不动，等于黑箱。agrun.js 的 Inspector 面板（`examples/browser/src/components/inspector-debug-report.ts`）在最近一个月增长得最快：

- **OODAE Cycle Ledger**：每个 cycle 显示 phase 完成度、planner request prompt 大小/hash/preview、planner response 类型/preview、AI decision、action outcome、observation、evaluate result、repair state、block/error 信号。我在新运行里点开 inspector，看到 cycle 1 的 `kind=planner_request | plannerMode=envelope | provider=gemini | model=gemini-3.1-flash-lite-preview | tools=0 | readSources=0 | promptChars=6153`，紧跟着 `kind=planner_response | decision=final | reasoning=The user requested a single-sentence confirmation…`。这是一次最小路径运行（单 cycle 直接 final），只发了 3 次 generateContent 请求（200/200/200）。
- **LLM Trace 首尾对比 + JSON/CSV 导出**：旧运行有 18 次 planner_request，promptChars 从 48941 → 58260，hash 全部不同（`ac771dce`, `591960ff`, `492393b3`, `7cd6c45d`, `8f35093e`…），可以一眼看出哪个 cycle 上下文膨胀了。
- **Support Bundle Debug Index** + “Send this to Codex”：一键复制即可发给后端工程师；Inspector 自带提示语 “If this stays stuck, send the Support Bundle and Raw panel; check first-runtime-step timing, provider latency, and abort wiring.”
- **Annotate-don't-destroy**：当 readiness audit 与 AI 声明不一致时，Inspector 显示 mismatch banner 但**不替 AI 改 final answer**；user-facing answer 仍是 AI 的原文，只有 Inspector 看得到 audit 评论。这一条契约在 task.md 2026-05-11 行明确写着 “Inspector message reconciled to annotate-don't-destroy; SKILL.md pre-finalize checklist”。

> **Honest Bad Result（HBR）**：Inspector 在旧运行里诚实暴露了一个问题——AI 写出的 final_candidate 只有 2163 字 / 1074 cjk_chars，远低于用户要求的 3000 字。这不是 runtime 的 bug，是 lite 模型 + readurl 502 双重限制下 AI 的选择。runtime 没说谎，Inspector 没掩盖；下一轮迭代是 AI-first 的（换更强模型 / 收紧 skill workflow 文本），不是 runtime 加阈值。

---

## 5. Live e2e：今天这一次跑做了什么

在 `examples/browser`（vite v6.4.1，PORT 3000，BROWSER_DEV_AUTOSEED_KEYS=true）通过 Chrome DevTools MCP：

1. `navigate_page http://localhost:3000/?debug_yn=y&qa_auto_approve_tier1=y` → 200
2. 关闭旧 Inspector dialog，点 “New chat”
3. 通过 `evaluate_script` 把 prompt “Harness Engineering 2026 quick check: please reply with a single sentence confirming runtime is healthy.” 写进 textarea，触发 input/change 事件
4. 点击 “Send message” 按钮
5. `wait_for` 命中 “healthy / completed / 完成”——AI 回复：“The Harness Engineering 2026 environment is fully operational and the system is running in a healthy state.” 3.5K in · 65 out
6. Inspector 显示：`runStatus=…`, `terminalizedBy=planner_final`, `decision=final`, `cycle 1`。无 console error，无 console warn。Network：3 个 POST 到 `generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent`，全部 200。

这次最小路径运行验证了三件事：(a) 短 prompt 不会被 runtime 错误激活 workspace（virtual_workspace.enabled === auto，只有调 workspace_write 才会切到 enabled=true）；(b) AI 直接走 finalize 一拍即停，runtime 不会硬塞额外 cycle；(c) finalReadiness 不是必填的——只有当 workspace 真正激活、或者用户要求结构化交付时才需要填，runtime 不强求每次都走 readiness audit。

> 截图证据：
> - `agrun_docs/live-tests/he2026-inspector-prior-run-2026-05-10.png`（旧运行，19 actions，19 个 planner_request，最终 limited）
> - `agrun_docs/live-tests/he2026-inspector-fresh-run-2026-05-10.png`（今天的最小运行，1 cycle，3 个 generateContent，全 200）

---

## 6. 2026 年的五条 harness engineering 准则（从 agrun 中抽象出来）

读完 task.md 上百条 entry 后，可以提炼成五条可迁移到任何 frontend agent runtime 的准则：

**准则一：Push-mode 是 anti-pattern。** runtime 不能在 AI 的反应路径上做主动决策。任何 throw、任何 fast-path skip planner、任何 “runtime auto revise”、任何 “if length < N then force search” 都是 push-mode。修复方法只有一个：把决策替换为只读信号 + 把控制流替换为 `control:"continue"` 让 AI 自己处理。

**准则二：SSOT（Single Source of Truth）跨模块强制。** 例如 plan-args 的 alias 链（toolArgs / tool_args / toolArguments / arg_…）以前在 `planner-tools.js` 和 `action-loop-utils.js` 各有一份，2026-05-11 抽到 `src/runtime/plan-args-fallback.js`。规则是“一个事实只能有一个解析点”，否则下次扩 alias 必然漏改一处。

**准则三：Annotate, don't destroy.** Inspector / audit / debug 层永远只追加注解，不改 AI 输出、不改 user-visible final answer。一旦 runtime 开始“替 AI 改 final”，AI-first 契约立即崩溃，因为 AI 学不到自己刚才的输出真的被用了；下一轮 prompt 的 reflection 就是假的。

**准则四：诚实的 baseline > 漂亮的 hardcode。** Run #3（71% 交付率，含 hardcode）即使数字漂亮，也要被回滚到 Run #4（44%，AI-first）。理由：71% 是“买来的”，不可复制到下一个 prompt；44% 是 AI 真实能力的下限，可以靠模型选择 / skill workflow 文本提升。**Honest Bad Result 必须公开记录**——这正是 CLAUDE.md 末尾要求每个回复都附 HBR 的根因。

**准则五：Harness 必须容忍弱模型。** 2026 年的现实是 lite/flash/mini 系列才是规模化部署的目标。harness 设计里，**任何依赖 “AI 自然会想起来再读一次 URL” 的逻辑都要落到事实层**。例如最近加的 `read_url textRange/nextTextStart` 让 AI 知道当前窗口后还有内容，否则 lite 模型读一次就以为读完了。harness 的工作不是替 AI 思考，而是把它必须看到的事实摆到它眼前。

---

## 7. 仍未解决的难题（HBR）

- **lite 模型字数交付**：3000 字深度调研在 gemini-3.1-flash-lite-preview 上稳定停在 ~2100 chars / ~1100 cjk。不是 runtime bug，是模型能力上限；下一步是 baseline 切到 `gemini-2.5-pro` 或 OpenAI gateway 的 `gpt-5.4-mini` 比对。
- **readurl 服务可用性**：今天的旧运行里 `seraphicsecurity.com` 被 502。harness 已经把 `READ_URL_SERVICE_UNAVAILABLE` 当成 last read source 摆进 prompt，AI 学会了用 `decision:"limited"` 诚实交付，但用户体验上仍然是“调研深度受限”。这是上游依赖问题，runtime 只能继续 surface，不能伪装成功。
- **PrivacySettingsPanel.tsx 的 tree-sitter ERROR 节点**：codeloom 索引里唯一的解析错误。会影响图谱完整性但不影响运行；归类为低优先级。

---

## 8. 总结：Harness 是骨架，AI 是肌肉

如果 2025 年是“给 LLM 套一层壳”，那 2026 年的 harness engineering 就是“给 LLM 修一具骨架”。骨架（runtime）提供：稳定的 API 表面、可观察的事实、不会替你做决定的阻塞点、annotate-don't-destroy 的审计通道。肌肉（AI / skill）提供：语义理解、任务分解、内容产出、自我反思。

agrun.js 当前的形态正是这条路线的实证：117 行的 `createRuntime`、按 verb 拆分的 13 个 action-loop 文件、only-when-AI-asks 的 virtual workspace、annotate-don't-destroy 的 Inspector、被反复回滚的 push-mode 改动、每次发现新 hardcode 就立刻删的纪律。它不漂亮，因为它正在被工程师每周削掉一层；但它**诚实**——这是 2026 年 harness engineering 唯一不可替代的资产。

字数统计：本报告正文约 2620 字（不含标题与元数据），覆盖代码图谱、AI-first 契约、Inspector、live e2e、五条准则与未解难题。

---

## 附录 A：本次 e2e 的真实 tool 输出片段

```
# vite log
> react-example@0.0.0 dev
> vite --port=3000 --host=0.0.0.0
  VITE v6.4.1  ready in 358 ms
  ➜  Local:   http://localhost:3000/

# chrome-devtools MCP navigate
Successfully navigated to http://localhost:3000/?debug_yn=y&qa_auto_approve_tier1=y.

# 新运行 inspector
runStatus=… terminalizedBy=planner_final decision=n/a … cycle=1
kind=planner_request | plannerMode=envelope | provider=gemini |
  model=gemini-3.1-flash-lite-preview | tools=0 | readSources=0 | promptChars=6153
kind=planner_response | decision=final |
  reasoning=The user requested a single-sentence confirmation…

# 网络
reqid=368 POST .../gemini-3.1-flash-lite-preview:generateContent [200]
reqid=369 POST .../gemini-3.1-flash-lite-preview:generateContent [200]
reqid=370 POST .../gemini-3.1-flash-lite-preview:generateContent [200]
console errors / warnings: 无
```

## 附录 B：codeloom 关键查询

```
get_status: agrun repo, 4324 nodes / 12230 edges, indexed 2026-05-10
find_symbol "createRuntime" (agrun) →
  function:0_development/src/runtime/runtime.js:13:7::createRuntime(1)
list_neighbors (createRuntime, CALLS, outgoing, conf≥0.9) →
  normalizeRuntimeConfig, createApprovalSigner, createSessionStore
search_code "virtual_workspace OR workspace_publish" (agrun) →
  src/runtime/virtual-workspace.js (754 行 SSOT)
  src/runtime/actions/virtual-workspace-actions.js
search_code "action_loop OR planner_prompt" (agrun) →
  13 个 src/runtime/action-loop-*.js + planner-prompt(.js | -projection.js | -skills.js)
```
