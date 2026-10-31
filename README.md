# 内容任务规划 Agent（小影校招第 2 题）

基于 **pi Agent Core 1.3.0 + pi-ai 1.3.0** 的单 Agent CLI。输入主题、预算和截止时间，模型通过素材检索、脚本生成、费用估算及方案保存工具，完成内容活动方案；超限时重规划，无法完成时返回原因和中间结果。

**评审入口**：[需求](docs/01-requirements.md) · [方案与 pi 职责](docs/02-solution.md) · [测试及真实运行证据](docs/03-evaluation.md) · [AI 使用说明](docs/04-ai-usage.md) · [复盘](docs/05-retrospective.md)

## 快速运行：离线模式，无需密钥

环境：Node.js 24 或更新版本、npm。代码直接由 Node 执行 TypeScript，检查使用 `tsc --noEmit`，无需构建产物。

```shell
npm ci --ignore-scripts
npm run check
npm test
npm start -- --input examples/inputs/budget-replan.json --mode offline
```

预期：先估算出精制方案费用 12，预算为 10；再改成标准方案 8，最终 `status=completed`，生成 `.runtime/offline/plans/budget-demo.json`。

离线模型是 pi-ai 的 Faux Provider + 确定性策略，**只验证流程，不证明真实模型决策效果**。所有业务工具均使用本地合成数据和函数；脚本工具生成可编辑模板，保存表示本地活动方案已落盘，不表示视频已制作或发布。

## 真实模型模式

首次配置时，将 `.env.example` 复制为 `.env` 并填写 `ZHIPU_API_KEY`；已有 `.env` 时直接编辑，不要覆盖已有配置。`.env` 已被 Git 忽略。

- 提供商：智谱，自定义 OpenAI Chat Completions 兼容接口。
- Base URL：`https://open.bigmodel.cn/api/paas/v4/`。
- 已实际验证模型：`glm-4.5-air`。
- 可用 `ZHIPU_MODEL` 显式指定其他模型，项目不会静默切换；其他模型尚未验证。

```shell
npm run smoke
npm start -- --input examples/inputs/budget-replan.json --mode real --report .runtime/real-output.json
```

真实运行会使用模型 API。报告记录实际 token 数，`apiCost=null` 表示未配置可靠单价；不以 SDK 中用于初始化的零值单价声称调用免费。活动预算是合成费用表中最终方案的模拟成本，与模型 API 花费分开。

## 验收与证据

```shell
npm run evaluate -- --mode offline
npm run evaluate -- --mode real
npm run format:check
```

- [离线验收](examples/offline/summary.json)：12 组场景。
- [真实模型验收](examples/real/summary.json)：6 组场景，其中 4 组实际调用模型，另 2 组在输入校验阶段结束。
- 每组目录包含 `input.json`、`output.json`、`trace.jsonl`、`check.json`；已完成的组还包含实际保存的 `saved-plan.json`。
- 正常场景额外保存重复请求和冲突请求结果；保存失败场景额外保存续跑结果。
- [自动测试报告](examples/test-results.tap)、[依赖检查](examples/dependency-audit.json)、[实际实施用时](examples/work-log.json)。
- 汇总中的 `sourceManifest` 和 `implementationHash` 记录运行时的源文件内容指纹，方便核对证据对应的实现；不是数字签名。

评估使用固定的场景时钟，并在报告中标明；Trace 时间戳仍为实际运行时间。CLI 默认使用系统时钟。重新评估会更新对应证据文件，并在独立运行目录执行，不复用上一轮结果。

## 输入、输出与边界

输入示例见 [normal.json](examples/inputs/normal.json)。`requestId` 仅接受字母、数字、下划线和连字符；`budget` 为非负整数；`deadline` 必须包含秒和时区。`preferredStrategy` 为软性档位偏好，可选 `premium`、`balanced`、`economy`；预算和截止时间为硬约束。

输出包含任务状态与原因、步骤尝试及成功/失败状态、素材来源、可编辑稿件、费用及耗时分项、保存回执、执行计数及 Trace。保存文件的 `activities` 给出活动制作任务、依赖、费用和预计耗时，状态为 `planned`。

退出码：`0` 已完成；`2` 待补充、未完成或请求冲突；`1` 命令、环境或文件错误。不能只凭 CLI 是否打印内容判断成功，应检查 `status` 和 `savedPlan`。

同一请求 ID、输入、模型和数据表重复运行时返回已有结果，`reused=true`，本次模型与工具计数为 0；历史尝试仍可查看。修改输入、模型模式或数据表时需使用新请求 ID。已保存方案不重复创建；未完成任务默认也复用结果，只有显式 `--resume` 才继续执行。

## 失败注入与续跑

以下两个命令使用同一目录：第一次永久模拟保存失败，退出码应为 2；第二次取消失败注入并续跑，复用已有稿件。

```shell
npm start -- --input examples/inputs/budget-replan.json --mode offline --root .runtime/resume-demo --fail save_plan:-1
npm start -- --input examples/inputs/budget-replan.json --mode offline --root .runtime/resume-demo --resume
```

`--fail generate_script:1` 表示模拟一次脚本工具失败；`-1` 表示本次运行永久失败。注入机制是验收工具，真实文件写入错误也有独立自动测试。

默认上限：10 次模型请求、20 次执行工具、120 秒。可用 `--max-turns`、`--max-tools`、`--timeout-ms` 修改。`--dataset FILE` 可替换费用和素材表，`--now ISO_DATE` 可明确使用模拟时钟，`--help` 查看全部选项。

## 范围与提交

当前覆盖本题必验场景，并实现显式失败续跑。语义检索质量、生产级并发、真实素材服务、实际内容制作和发布不在本次范围；更换模型后的可靠性需要重新评估。

GitHub 仓库：[zzx666-code/quvideo-content-planner](https://github.com/zzx666-code/quvideo-content-planner)，当前为公开仓库，可直接查看代码、文档与验收材料。

考核提交信息为题号 2、上述仓库 URL、最终 `git rev-parse HEAD`。代码与验收材料已上传；网页交卷尚未执行。
