# Length-attainment A/B + variance check — post-AGRUN-451 refactor — 2026-06-12

## 30-second read

**一句话**：AGRUN-451 把 `virtual-workspace-actions.js` 拆成 11 个模块（−77%）后，跑标准「3000 字研究报告」live e2e 时，第一次 gemini-3.1-flash-lite 只写到 2183/3000 词就 limited 收尾，怀疑是不是拆分把「长度门 / 收敛」改坏了。**重跑验证后结论：没坏。** flash-lite 长文输出本身**高方差**（同模型同 harness 三次跑出 1680 / 2183 / 3049 词），单跑一次的短结果是**不走运的抽样**，不是模型天花板也不是 harness 回归——换 gpt-5-mini 稳定 3136 词 / 100 分 / 14 步达标。**真正一致的缺口是 source/引用维度**（弱模型研究做得少），不是长度。

**打个比方**：让学员（lite 模型）写命题作文，有时灵感来了写满 3000 字，有时卡壳写到 2000 就交卷——**忽高忽低**。老司机（gpt-5-mini）每次都稳稳写满还提前交。我们一开始看到学员一次写少了，差点去「修改卷子规则」，其实卷子规则没问题，是学员发挥不稳 + 查资料偷懒。

## 为什么有这份文档

AGRUN-451 god-file 拆分触及了 publish-readiness 流水线（length-deficit / 收敛 / limited 逃逸的判定逻辑）。重构后第一次 flash-lite live 跑出 2183/limited，与 [weak-model-e2e-comparison-2026-06-10.md](./audits/weak-model-e2e-comparison-2026-06-10.md) 记录的「flash-lite 修复后 3093/ready/79 步」矛盾。**先证据后改动**：重跑而非假设，确认是方差不是回归。

## 结果矩阵（current main = AGRUN-451 重构后，同 prompt，maxSteps 90）

| 指标 | gemini-3.1-flash-lite（3 次）| gpt-5-mini（1 次）|
|---|---|---|
| candidateWords | **1680 / 2183 / 3049** | **3136** |
| lengthRatio | 0.56 / 0.73 / **1.0** | **1.0** |
| decision | limited / limited / **ready** | **ready** |
| 终止 cycle | 31 / 31 / 47 | **14** |
| acceptance score | ~53 / ~61 / 75 | **100** |
| userGoalSatisfied | false / false / false | **true** |
| sourceMinimumPassed | false / false / false | false |
| 结果 | live_pass（机制正确）| **live_pass** |

> 命令：`npm run test:live:node-3000`（flash-lite 来自 .env.local `GEMINI_MODEL`）；`NODE_AGRUN_LIVE_PROVIDER=openai npm run test:live:node-3000`（gpt-5-mini）。Trace 见 `agrun_debug_runs/2026-06-12T19-*.trace.v1.json`。

## 结论

1. **AGRUN-451 重构无回归** ✅ — flash-lite 当前 main 能跑到 3049/ready；gpt-5-mini 3136/ready/100。publish 流水线、length-deficit、收敛、两道门 import/re-export 全部端到端正确。
2. **长度达成对 lite 模型高方差** — 同模型同 harness 三次跑出 1680→3049（ratio 0.56→1.0）。**绝不能从单跑一次的短结果断定「模型天花板」或「harness bug」**。
3. **预算不是瓶颈** — gpt-5-mini 14 步、flash-lite 最多 47 步就终止，远低于 maxSteps 90。短结果不是步数耗尽，是模型每步产出 + 发挥方差。
4. **真正一致的缺口是 source/引用维度** — 所有 run `sourceMinimumPassed=false`；flash-lite 的 acceptance source 门也常挂（研究太少：每次只 1-2 次 web_search 就开写）。这与长度正交，且**不随换模型消失**（gpt-5-mini 靠更强研究拿了 100 分，但 runState 的 sourceMinimum 标志仍 false——两者是不同层）。
5. **limited 逃逸是设计正确** — 发布真实短稿 + 声明缺口，胜过注水凑字数或空转到 maxSteps。

## 模型选型指南（长文 3000 字任务）

- **要可靠达标** → 用 frontier 模型（gpt-5-mini 级）：稳定满长度 + 满分 + 少步数。
- **用 lite 模型**（成本/延迟优先）→ 预期长度方差大（0.56–1.0），单跑可能 limited；要么接受 limited 诚实稿，要么多跑取最好，要么针对性补「研究深度」引导（先多 web_search/read_url 再写）。
- **诊断短结果前先重跑** — lite 模型单跑是噪声；2-3 次取分布再下判断。

## 如何扩展这张表

加一行：`NODE_AGRUN_LIVE_PROVIDER=<gemini|openai|deepseek> NODE_AGRUN_LIVE_MODEL=<id> npm run test:live:node-3000`，从 `node_agrun_live_summary` 读 candidateWords/lengthRatio/decision/score。**注意**：换 model id 前先验证可用性——本 .env.local key 上 `gemini-3.1-flash`（非-lite）报 `configuration is incomplete for gemini`（provider-error reason=config），只有 `-flash-lite` 可用。

## 关联

- 重构 epic：AGRUN-451（task.jsonl `status:done`，god file 2305→526，−77%，11 个 workspace/ 模块）。
- 历史基准：[weak-model-e2e-comparison-2026-06-10.md](./audits/weak-model-e2e-comparison-2026-06-10.md)、[model-comparison-live-2026-06-06.md](./model-comparison-live-2026-06-06.md)、[output-length-variance-2026-05-08.md](./live-tests/output-length-variance-2026-05-08.md)。
