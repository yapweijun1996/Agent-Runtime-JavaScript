# Weak-Model E2E Comparison — gpt-5.4-mini(low) vs gemini-3.1-flash-lite(low) vs deepseek-v4-flash — 2026-06-10

## 30-second read: why this comparison exists

**一句话**：同一个标准任务（3000 字带来源研究报告）让三个弱模型各跑一遍，看 harness 在哪些地方**没接住**弱模型——目标是让弱模型也能**完整、有质量**地完成任务。

**打个比方——驾校教练车**。强模型是老司机，给辆普通车就能开好；弱模型是学员，需要教练车（副刹车、扶方向盘、及时口头纠正）。这次测试就是看我们这辆"教练车"缺哪些配件：结果发现**副刹车有时不工作**（planner 超时直接判死）、**口头纠正来得太晚**（来源不足要到发布时才说）、**学员绕圈时教练干看着**（60 个 cycle 的发布废操作）。

| | 修之前 | 修之后（已验证 ✅） |
|---|---|---|
| 弱模型慢一拍 | 60s planner 超时 → 整个 run 报废 | 瞬态错误重试 + 按工作量给预算 → deepseek 从"跑不完"变"16 步 ready" |
| 弱模型偷懒少查资料 | 发布时才发现 source 门挂了 | finalize 前就被挡回去"先读完引用的 URL" → 三家都过 source 门 |
| 弱模型反复乱发布 | 干烧 60 个 cycle 才被放行 limited | 第一次被拒就给处方 → gemini publish churn 11→1 |

> **收官结论(2026-06-10 三模型重跑):三家全部 100/100、三门全过、零 churn。** 详见下方「修复后收官快照」矩阵。

---

**Setup:** `test/node-agrun-3000-live.mjs`(标准 3000 字 Harness Engineering 研究报告,真 web_search/read_url,maxSteps 90,AGRUN_DEBUG=1),三个 run 并行。Trace: `agrun_debug_runs/e2e-cmp-*.{jsonl,trace.v1.json,md}`。注意:deepseek 的 "high" 推力**传不进去**(`deepseek-browser.js` `providerOptions:null`),实际按 provider 默认跑(本身即发现 F5)。

## Result matrix

| | gpt-5.4-mini (low) | gemini-3.1-flash-lite (low) | deepseek-v4-flash (default) |
|---|---|---|---|
| runStatus | completed | completed | **failed** (PLANNER_ERROR: provider timeout) |
| decision | **ready** | limited | — (died cycle 10) |
| acceptance score | 75/100 | 75/100 | 49/100 |
| words | 3013/3000 | 3093/3000 | 1440/3000 |
| cycles | **19** | **79** | 10 |
| duration | 242s | 313s | 220s |
| sources read (strong tier) | 3 | 1 (+2 blocked) | **5** (+1 blocked) |
| failing gates | source | source | length + source |
| churn | minimal | 11×publish, 6×review, 10×plan-validation-fail, 12×fingerprint-repeat, 86×terminal-repair-refresh | n/a |

**Cross-model pattern:** 三家**全部挂 source 门**(要求 ≥3 cited+read URL)。弱模型的共同行为是**研究不足**:每家只做 1 次 web_search 就开始写。最讽刺的是研究做得最好的 deepseek(5 个 strong read)死于超时,没机会写完。

## Result matrix — 修复后收官快照(F1–F7 + source 门全部落地,2026-06-10 重跑)

| | gpt-5.4-mini (low) | gemini-3.1-flash-lite (low) | deepseek-v4-flash (default) |
|---|---|---|---|
| runStatus | **completed** | **completed** | **completed**(基线是 failed) |
| decision | limited | **ready** | **ready** |
| acceptance score | **100/100** | **100/100** | **100/100** |
| 三门 (length/structure/source) | ✅ ✅ ✅ | ✅ ✅ ✅ | ✅ ✅ ✅ |
| userGoalSatisfied | **true** | **true** | **true** |
| words | 3118/3000 | 3100/3000 | 3016/3000 |
| steps | 38 | 49 | **16**(极简收敛) |
| sources read | 3 | 4 | 4 |
| cited readable URLs | 3 | 3 | 4 |
| structure issue codes | `[]` | `[]` | `[]` |
| publish churn (maxConsecutivePublishCandidate) | **1** | **1**(基线 11×) | **1** |

**收官结论:** 三家弱模型**全部 100/100、三门全过、零 publish churn、结构零 issue**。三处对照基线的关键扭转——
1. **deepseek 从"跑不完"→"16 步 ready"**:F1 瞬态重试 + F2 工作量超时信号让它活过 planner 超时。
2. **gemini 从"11 次乱发布"→"1 次"**:处方级反馈(F3/F4 合并)第一次被拒就给出可执行修复,churn 归零。
3. **source 门从"三家全挂、且 grader 不可满足"→"三家全过"**:三层(事实+后果+诚实评分)闭环,且每家都恰好引用了它读过的可读源。

> deepseek 的 "high" reasoning effort 在原生 provider 路径**尚未透传**(F5 未做,`deepseek-browser.js` providerOptions:null),本次实际跑默认档仍达 100——说明 harness 改进不依赖单模型的 reasoning 档位。

## Findings (ranked by impact on "weak model completes with quality")

### F1 — P1 — Planner provider 超时 = 整个 run 立即死亡,零重试
deepseek 在 cycle 10 一次 planner 调用超过 60s → `action-loop-planner.js` catch 块直接 `finalizeActionLoopFailure`(code PLANNER_ERROR)。**workspace 里 1440 字的真实工作全部报废**。对照:空响应(`isRecoverableEmptyPlannerResponseError`)有恢复路径,但 timeout/429/5xx 没有——这是不一致的错误姿态。瞬态网络/负载错误是弱(慢)模型的常态而非异常。
**Fix shape:** planner 调用点对 timeout/rate-limit/5xx 加有界重试(1–2 次,退避);circuit breaker 仍然是持续失败的最终权威。或复用 empty-response 的恢复路径形状(把瞬态 provider 错误降级为 planner-recoverable 信号)。

### F2 — P1 — 超时预算的结构信号漏掉"无计划但有大 workspace"的弱模型
120s autopilot 预算(`provider-timeout.js deriveProviderTimeoutMs`)只认两个信号:todoState 有 items,或 researchReportLoop gateSignal 的 acceptancePacket requestedLength ≥1000。deepseek **从没调 todo_plan、没挂 skill** → 全程裸跑 60s 默认,而它恰恰是最慢的 planner(常态 10–37s,致命那次 >60s)。**最需要预算的模型恰好拿不到预算**——因为信号依赖模型"懂事"地先建计划。
**Fix shape:** 给 `isLongRunningTurnInPlay` 加第三个结构信号:virtualWorkspace 已有实质内容(如 final_candidate ≥1000 词)。workspace 体量是模型无关的客观信号,不依赖模型行为。

### F3 — P1(质量主线)— source 门的反馈来得太晚、太软
三家全挂 source。门在 publish 时才打分;`unread_cited_url` 只是 advisory。弱模型 1 次搜索就开写,写完 3000 字后已经没有"回头补研究"的行为倾向。
**Fix shape:** 当存在 citation 契约/来源下限而 finalize 时 cited+read < N,在 `workspace_finalize_candidate` 处返回结构化 planner-recoverable 反馈("以下引用的 URL 未读:…,先 read_url 再 finalize")——和 `action_policy_not_allow_in_plan` 同一形状:runtime 说清缺口,模型自己决定读哪些。AI-first:不硬编码读哪个 URL,只陈述缺口。

### F4 — P2 — 发布失败循环的收敛太慢(gemini 烧掉 ~60/79 cycles)
gemini 11 次 publish、22 次 publish 类决策、86 次 terminal-repair 刷新、12 次指纹重复、10 次 plan 验证失败,terminal repair `mode` 全程停留 "none"/advisory,最终才被放行 valid-limited。每次被拒它都原样重试(指纹重复),修复指令没有随失败次数硬化。
**Fix shape:** 预算感知的升级梯子:同一 publish 被拒 k 次且 workspace 无增量 → (a) 修复指令硬化(列出失败门 + 允许动作白名单),或 (b) 提早开放 valid-limited。另:10 次 plan-validation-fail 说明弱模型批量 plan 的语法成功率低——可考虑对连续 plan 验证失败的模型降级建议单动作模式(runtime 已有结构化反馈,加一句"emit one action instead of a plan"即可)。

### F5 — P2 — deepseek 路径不透传 reasoning effort
`deepseek-browser.js` 两处 `providerOptions: null` 写死。用户指定 "deepseek-v4-flash high" 无法生效,实验配置都没法表达。OpenAI 路径已有 `reasoningEffort` + apiVariant "responses" 先例。
**Fix shape:** 照 openai 先例把 reasoning 参数穿透 deepseek provider 入口(@ai-sdk/deepseek 支持的 providerOptions 形状)。

### F6 — P3 — live summary 无 usage/cost 字段,跨模型成本对比不可能
`node_agrun_live_summary` 里完全没有 token/cost 字段(三个 run 全部 null/缺失)。runtime 有 cost ledger;live 测试没把它接到摘要。本次对比只能比 cycles/duration,比不了钱。
**Fix shape:** 把 usage 总量 + costUsd(配 costPricing 时)收进 live summary;顺手让 Inspector 一眼看到每 cycle 成本。

## Step-by-step trace walk (gemini 79-cycle run): why the agent actually failed

逐决策走读(`agrun_debug_runs/e2e-cmp-gemini31flashlite-low.{jsonl,trace.v1.json}` + 对应 runtime 代码)还原的失败链:

1. **t=6s 唯一一次 web_search;cycle 4 一个 plan 批量读 3 个 URL,其中 2 个 403。** 此后**整个 run 再无任何研究动作**。runtime 如实记录了 blocked tier,但从没对模型说"你 3 个来源死了 2 个、契约要 3 个有效来源"——模型对来源缺口**不知情**,带着 1 个有效来源写完了 3093 字。
2. **t=150s 起:13 次 `decision="ready"` 的 publish 被拒,直到 t=297s 才第一次试 `decision="limited"`。** 运行时其实**全程知道**唯一合法终局是 limited(`terminalRepairState.validPublishContract`),甚至有现成的 `requiredArgsExample`(直接给出合法 limited publish 参数示例)——但这段**处方级反馈只在 terminal-repair active 时下发**,而本 run 的 repair `mode` 全程 `"none"`、`ignoredCount=0`(模型每次都在"响应"反馈,只是方向错,升级条件永远不满足)。模型实际看到的只有诊断计数器:`publish_attempts_blocked=N (lastStatus=…)` + "choose a corrected action sequence"(没说 correction 是什么)。
3. **publish 协议是多门顺序锁**(`inspectWorkspacePublishProtocol`:finalize→read→review 必须都晚于最近一次写),任何杂散编辑使链条作废。模型的无意义动作(outline.md 建了删、删了建 ×3)反复重置链条。代码注释自己都承认这是 "the brittle multi-gate publish protocol" 且 AI "demonstrably failed" 它——逃生门(publishLoopEscapeGranted)要到 hard_veto 才开,而 hard_veto 永远到不了(见第 2 条)。
4. 模型自身短板(harness 修不了):10 次 plan 验证失败、12 次指纹重复、零自发好奇心(1 次搜索)。

**根因一句话**:不是模型"不响应反馈",而是 **runtime 手里握着处方(validPublishContract + requiredArgsExample + observableDeficits)却只发诊断(blocked 计数 + status 码)**,处方被锁在一个永远不触发的升级梯子后面。强模型自己能从诊断推出处方(gpt 19 cycles 一次过),弱模型不能(gemini 烧 60 cycles 撞墙)——同一 harness 上 4 倍成本差的全部来源。这把 F3/F4 收敛成一条更锋利的原则:**反馈必须在出错当下就是处方级**("emit decision=limited, remainingGaps=[sources]"),而不是等升级梯子把诊断翻译成处方。

5. **F7(新发现,Inspector 缺口)**:三种 trace 工件(debug jsonl 只存 prompt 尺寸、trace.v1 剥掉 action 输出、summary 只存截断样本)**都没保存模型实际收到的 observation 文本**——本次走读被迫从 runtime 代码反推反馈内容。对"调反馈措辞"这类工作,observation 原文是第一证据,应按 redaction 规则收进 trace.v1。

## What already worked (不要修的部分)

- **acceptance gate 诚实**:三家分数与肉眼判断一致(75/75/49);gpt 与 gemini 同分但 gemini 的 decision 被正确降为 "limited"。
- **convergence 没让 gemini 无限循环**:79 cycles 内强制收敛到 valid-limited 并干净终止,maxSteps 90 没爆。
- **read-source 分层**(strong/blocked)如实记录 403,质量信号没被污染。
- 对照上一会话:gemini-3.1-flash-lite 默认 thinking 拿 34/100,本次 thinking=low 拿 75/100 完成发布——**harness 修复梯子 + 弱模型低推力**比"默认"组合表现好(单次样本,仅作观察)。

## Verdict

弱模型完成度的瓶颈按序是:**活下来**(F1/F2 survival)→ **质量门前置**(F3 quality)→ **少烧 cycle**(F4 efficiency)。三者都是 harness 可改的,不需要等模型变强。

**收官回归(F1–F7 + source 门全部落地后,三家各重跑一次):三家全部 100/100、三门全过、userGoalSatisfied=true、零 publish churn。** 见上方「修复后收官快照」矩阵。瓶颈链条三段全部打通:deepseek 活了下来(F1/F2),gemini 不再乱发布(F3/F4),三家都过了 source 门(三层闭环)。结论印证 verdict 的核心论点——**让弱模型完成高质量任务,靠的是 harness 工程,不是等模型变强。**

## Disposition

- **F1 FIXED (same-day):** 共享新家 `src/runtime/provider-retry.js`;重试循环进 `requestProviderCompletion`(所有非流式 planner/finalize/repair 调用的唯一出口);`runtimeConfig.providerRetry` 照 `circuitBreaker` 同款穿线(默认 `{maxRetries:1, backoffMs:500}`,上限 5,`maxRetries:0` 关闭);流式路径**明确不重试**(已发 token 不可撤回);熔断器仍是持续失败的最终权威(每次失败照常计数、熔断打开即停止重试);Inspector 经 `planner-responded.providerRetries` 可见。`test/unit/provider-retry.test.js` 6 案例。Parity triage:runtimeConfig 字段 → 两个入口 + subagent childRuntimeConfig spread 自动继承,正确。
- **F2 FIXED (same-day):** `isSubstantialWorkspaceInPlay` 加入 `isLongRunningTurnInPlay`(`provider-timeout.js`)——workspace 内容(latin 词数或 CJK 字数)≥1000 即长任务信号,过阈值早退,显式 `timeoutMs` 仍最高优先。`provider-timeout.test.js` +6 断言。
- **F3/F4 FIXED (same-day, merged as "prescription-grade feedback", commit `7a4db9187`):** trace walk 把两项收敛成一条原则——反馈在**出错当下**就要是处方级,不等升级梯子。两个手术,都在单漏斗上(两条 dispatch 路径自动共享):(A) `publish-prescription.js`(共享新家,`buildValidLimitedPublishArgsExample` 迁入):每个 publish-blocked 结果带 `publishPrescription`(两条出路规则 + 合法 limited 参数示例),无升级前置条件;(B) `read-url-recovery-signal.js`:传输层 "ok" 但内容是死页(tier blocked)不再**重置**恢复信号,改为发 `unusable_source_content` 信号 + read_url summary 直接点名 "NOT readable evidence"。`test/unit/prescription-feedback.test.js` 4 案例。
  - **Live 复测 ×2(gemini-3.1-flash-lite low,同任务):** 基线 79 cycles/11 次 publish/1 strong 源 → run1 **41 cycles/1 publish/4 strong**(167s,50 分—structure 方差)→ run2 **52 cycles/1 publish/3 strong,decision="ready"**(251s,75 分)。两次复测一致:**publish 循环消失(11→1)、死页后换源行为出现(1→3-4 strong)**。诚实归因:手术 A 两次都没触发(唯一一次 publish 直接被接受)——是手术 B 让研究阶段就把来源补对,下游 publish 死锁根本不再形成。score 50/75 波动来自 lite 模型的 structure 方差(模型下限,非本改动引入)。source 门仍未过(cited+read ≥3 的引用行为还差一口气)。
- **F7 FIXED (same-day, commit `0c6d2be9d`):** `recordObservation`(所有 observation 的单漏斗)现在附 `observationPreview`——与 planner prompt **同一投影**(`summarizeLastObservationForPrompt`),`scrubSecretText` 脱敏 + 2000 字截断;`live-trace.js` 把它透传到 trace.v1 的 observation-recorded 条目。证据属性:投影出错返回 null,绝不影响 run。Live 验证:51/51 条带原文(lengthProgress/quality/read_url 页面摘录全部第一手可见),0 密钥命中。该 run 同时是 prescription 修复后第三个连续零 publish 循环样本(ready 75/100,51 cycles)。
- **F5 FIXED (same-day, commit `4dfe5df61`):** 原生 deepseek 路径不再写死 `providerOptions:null`。`buildDeepSeekProviderOptions`(deepseek-browser.js)把 deepseek 合法档(low/medium/high/xhigh/max)透传到 `providerOptions.deepseek.reasoningEffort`,并**丢弃** agrun 才有的 `none/minimal`(@ai-sdk/deepseek 的 zod 枚举会拒)。generate + stream **两条路径都接 + 进 request trace**。Live 验证:trace requestBody 里出现 `providerOptions.deepseek.reasoningEffort="high"`。Unit:`deepseek-reasoning-effort.test.js`(透传 + 过滤两组断言)。
- **F6 FIXED (same-day, commit `4dfe5df61`):** `node_agrun_live_summary` 新增 `usage` 块,从 cost-ledger totals 取 `providerCallCount/input/output/totalTokens/latencyMs`(免费、永远有)。`costUsd` 仅在 host 经 `NODE_AGRUN_LIVE_PRICING → costPricing` 声明价格时计算(**不 hardcode 任何 $ 费率**;未声明则诚实报 `costUsd:null`)。Live 验证:6 次调用 / 59312 tokens / costUsd 0.017713(按传入价格表算得对)。
- **F8 NEW FINDING — P2 — high 推力让 deepseek 绕过 workspace 产出空候选(2/2 稳定,非方差):** F5 落地后用 `reasoningEffort=high` 复跑 deepseek-v4-flash 同任务 **两次都失败**——终局都是 `planner_finalize bypassed workspace publish` + `candidate_empty`(candidateWords=0)。对照:**default 档**同任务干净拿 **100**(16 步 ready)。根因假设:high reasoning 让 planner"想成"一次性作答、直接调 `finalize`,跳过多步 workspace 工作流;system prompt 的"Do not use finalize to bypass workspace publish"指令压不住 high-reasoning planner。这暴露一个 harness 缺口:research(convergence capability)任务下 runtime 应像挡 ready-publish 那样**也挡 `planner_finalize` 空候选终局**——目前只有 live 测试的断言挡住了它,runtime 本身放行了。**结论:F5 让推力可调是对的,但"调高"不等于"更好";对 deepseek-v4-flash 这个任务,default 档反而是最优。F8 留待单独处理,不在 F5/F6 范围内擅自修。**
- **F8 FIXED (same-day, commit `77e869d70`) + 6 轮可靠性回归全绿:**
  - **根因(trace 解剖确认):** 失败 run 是 `web_search → read_url → finalize`(cycle 3),从未碰 workspace。terminal-repair 的事实(sourceMinimum/lengthStatus)只来自 acceptance packet,而 packet 要等 research report loop 介入(workspace 有动作)才形成——所以"开局即 finalize"在门面前是**零缺陷**,`maybeBlockDirectTerminalDuringRepair` 直接放行。讽刺的是 `requirementRecoveryEvaluator` 在 cycle 1-2 就已给出 `needs_workspace_recovery`(它从 prompt 合同独立提取 3000 词要求,不依赖 packet),只是这个信号没接到 finalize 拦截门上。
  - **修法(共享模块,一处改两路生效):** `readRepairFacts`(terminal-repair-state.js)在 **terminal attempt** 时采纳 evaluator 的 recoverable deficits(仅当 `validLimitedAllowed === false`,即恢复预算仍在)——repair 激活,reason `terminal_attempt_with_recoverable_requirement_deficits`,allowedActions 路由回 workspace。聊天任务(无 evaluator)、合同已满足、预算耗尽(诚实 limited)都不拦;重复犯规由现有 ignoredCount → hard_veto → 逃生阀封顶,不会死锁。session/plan 两条 dispatch 路径都已经走 `refreshTerminalRepairState`,天然 parity。Unit:`terminal-repair-premature-finalize.test.js` 6 断言;全量 227 unit 测试(smoke 自动发现)通过。
  - **6 轮可靠性回归(deepseek-v4-flash,default×3 + high×3,修复后 dist):**

    | 轮次 | 分数 | 三门 | 词数 | cycles | tokens | 终局 |
    |---|---|---|---|---|---|---|
    | default-1 | 100/100 | ✅✅✅ | 3068 | 30 | 532,759 | workspace_publish |
    | default-2 | 100/100 | ✅✅✅ | 3086 | 30 | 520,596 | workspace_publish |
    | default-3 | 100/100 | ✅✅✅ | 3091 | 16 | 261,773 | workspace_publish |
    | high-1 | 100/100 | ✅✅✅ | 3014 | 23 | 424,357 | workspace_publish |
    | high-2 | 100/100 | ✅✅✅ | 3072 | 22 | 386,329 | workspace_publish |
    | high-3 | 100/100 | ✅✅✅ | 3019 | 43 | 762,374 | workspace_publish |

  - **诚实归因:** high 档从修复前 **0/2** 翻到修复后 **3/3**,但 F8 新门在 6 轮 live 里**一次都没被触发**(模型这批没再尝试提前 finalize)——live 层面只能证明"修复后 high 不再翻车",不能证明"是门救的";门的拦截行为由 6 个单元断言钉死。"提前交白卷"本身就是间歇行为(上批 2/2,这批 0/3),门是为它再出现时兜底。
  - **default vs high 结论修正:** 修复后两档都稳定满分,质量无差;差别在成本——default 均值约 43.8 万 tokens/run,high 均值约 52.4 万 tokens/run(+20%),且 high 方差更大(高-3 烧了 76 万)。**默认档仍是该任务性价比最优;"普通档更好"从强信号升级为:质量等价、成本占优。**
- **Live verification (same-day, build `4cdd76bf7`):** deepseek-v4-flash 复跑同一任务 → **completed "ready" 75/100**(3009/3000 词,24 cycles,578s),与另两个弱模型同分。决定性证据:本次有 **3 次 planner 调用超过旧 60s 预算**(75.0s/69.6s/67.5s)——pre-F2 harness 下第一次就会判死;它们活下来是因为 workspace 体量信号把预算升到 120s。providerRetries 本次为 0(没有瞬态错误需要吸收),F1 正确性由 `provider-retry.test.js` 钉死。**结论:活命层把 deepseek-v4-flash 从"完全做不完"变成"与同级弱模型同分完成"。**三家共同剩余缺口是 F3(source 门)。
