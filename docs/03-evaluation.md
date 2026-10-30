# 效果验证与限制

## 验证方式

- `npm run check`：TypeScript 严格类型检查。
- `npm run format:check`：格式检查。
- `npm test`：Node 内置测试，覆盖实际业务工具、磁盘存储、可控制的模型响应及执行限制。无需外部模型或密钥。
- `npm run evaluate -- --mode offline`：12 组端到端场景。
- `npm run evaluate -- --mode real`：智谱 `glm-4.5-air` 的 6 组场景，其中 4 组实际调用模型，两组因信息不足直接结束。
- `npm run smoke`：真实模型完成两次有依赖的工具调用，验证观察结果能传给下一次调用。

实际自动测试报告见 [test-results.tap](../examples/test-results.tap)，依赖审计见 [dependency-audit.json](../examples/dependency-audit.json)。审计仅表示报告生成时未检出已知问题，不替代业务正确性检查。

## 预期与实际

最终这次运行通过 21 项自动测试、12 组离线验收和 6 组真实模式验收。数据与源文件指纹、Node 版本、实际运行时间及场景时钟见 [离线汇总](../examples/offline/summary.json) 和 [真实汇总](../examples/real/summary.json)。模型请求次数不包含缺信息预检，也不把重复请求缓存算成新调用。

| 场景 | 预期 | 实际及对应材料 |
| --- | --- | --- |
| 正常完成 | 预算内完成并保存 | 费用 12，预算 20；[真实输出](../examples/real/normal/output.json)、[保存文件](../examples/real/normal/saved-plan.json) |
| 超预算后重规划 | 初稿 12 超出预算 10，选择可行方案再估算 | 最终为 8；[真实 Trace](../examples/real/budget-replan/trace.jsonl) |
| 缺预算 | 待补充，无模型调用 | `NEEDS_INPUT`、0 次调用；[输出](../examples/real/missing-budget/output.json) |
| 缺截止时间 | 待补充，无保存 | `NEEDS_INPUT`；[输出](../examples/real/missing-deadline/output.json) |
| 工具失败 | 一次脚本错误可见，保留成功检索结果后恢复 | 失败尝试保留，检索只执行一次；[真实 Trace](../examples/real/tool-failure/trace.jsonl) |
| 更换费用表 | balanced 成本变为 20，选择其他可行档位 | economy 成本 4；[变更数据](../examples/real/changed-prices/dataset.json)、[真实输出](../examples/real/changed-prices/output.json) |
| 无可行预算 | 未完成，列出最低缺口 | 最低预算 4、当前预算 1、缺口 3；[输出](../examples/offline/no-feasible-plan/output.json) |
| 截止时间不足 | 所有档位都来不及，不能保存 | `incomplete`；[输出](../examples/offline/deadline-failure/output.json) |
| 无素材 | 允许补查或停止，不生成虚构素材 | 两次检索后 `NO_MATERIALS`；[Trace](../examples/offline/no-materials/trace.jsonl) |
| 重复执行 | 一份方案，无重复调用 | `reused=true`、本次调用 0；[重复输出](../examples/real/normal/repeat-output.json) |
| 同 ID 不同输入 | 返回冲突 | [冲突输出](../examples/real/normal/conflict-output.json) |
| 保存失败 | 未完成，不能声称成功 | [失败输出](../examples/offline/save-failure/output.json)；另有实际文件系统错误测试 |
| 显式续跑 | 复用成功稿件，恢复后完成 | [续跑输出](../examples/offline/save-failure/resume-output.json)、[保存文件](../examples/offline/save-failure/resumed-saved-plan.json) |
| 模型/工具上限 | 触顶明确未完成 | [轮数上限](../examples/offline/turn-limit/output.json)、[工具上限](../examples/offline/tool-limit/output.json)；墙钟超时另有自动测试 |

`output.json` 为实际函数返回；`trace.jsonl` 为实际事件导出，未手工补写模型动作。`check.json` 保存该组预期和实际比较。信息不足组只有预检事件，无虚构模型记录。

## 真实发现的失败与改进

首次费用变更测试中，模型在初稿估算 12 后直接结束，未使用费用为 4 的候选，结果是 `REPLAN_REQUIRED`。该轮 6 组中 5 组通过；保留了 [原始失败检查](../examples/observed-failures/changed-prices-before-feedback/check.json)、[输出](../examples/observed-failures/changed-prices-before-feedback/output.json) 与 [Trace](../examples/observed-failures/changed-prices-before-feedback/trace.jsonl)。

改进是在模型停止且观察结果仍包含可行候选时，最多反馈一次未完成校验。新增回归测试先复现失败，再验证模型接收反馈后可继续选择工具。最终真实验收通过，历史失败没有从材料中删除。

代码审查还发现并修正三项边界：非法日期被 JavaScript 自动归一化、不同模型模式复用同一缓存，以及保存旧稿件时输出了最新稿件的估算。均有回归测试。模型声称成功、直接跳过估算保存、保存超预算方案、估算后时间推进、同轮多工具调用等场景也验证了代码约束。

## 解释边界

这是一小组合成任务的单次验收，不是统计可靠性实验。模型输出存在随机性，6/6 不代表通用成功率。离线测试证明流程和约束，不证明模型理解能力。当前仅实际验证 `glm-4.5-air`；模型、费用、素材或提示变化后需重新评估。

真实调用仍使用模拟业务工具和明确标注的场景时钟。素材检索质量、真实制作效果、费用报价准确性、生产级并发和断电恢复未验证。API 账单金额未核对，只报告服务返回的 token 用量。
