---
name: "{{skill_name}}"
description: "判断何时把「{{domain}}」的一次性程序固化成能力，以及何时拒绝固化。 / Decide when a one-off {{domain}} program should become a frozen capability, and when to refuse."
---

# 何时固化 / When to freeze

同一件事**已经跑通至少两次**，或者用户刚刚认可了一次**还会再需要**的结果，才值得固化。只跑通一次是观察，不是一条可重复的做法。
Freeze only after the same work succeeded at least twice, or the user accepted a result that will be needed again. One success is an observation, not a procedure.

先看 `capability_candidates`：它按程序哈希汇总成功事务、最新 run、产物和是否已冻结。它是**证据，不是结论**；结果是否被认可、下次是否还会问，只有人能回答。
Start with `capability_candidates`: it groups successful runs by program hash and shows the latest run, products and frozen state. It is evidence, not a decision; only the user can say the result was accepted and the task will recur.

固化前问三个问题；有一个答不上来就先别固化：
Ask three questions; if one has no answer, do not freeze yet:
1. 它回答的问题一句话说得清吗？（`manifest.answers`）
   Is the question it answers clear in one sentence? (`manifest.answers`)
2. 哪些输入是数据里推不出来的？这些必须由人给，不给默认值。
   Which inputs cannot be inferred? A person must supply them; no default.
3. 什么结果算错？写成可执行断言，不写一句「验收通过」。
   What counts as wrong? Write executable assertions, not "accepted".

# 先问什么 / What to ask

问推不出来的，不问能读出来的。坐标帧、环节数、材料名能读就去读；单位换算、品位列语义、材料标号必须问——猜错不会失败，只会给出看起来正常的错数。
Ask what cannot be read. Read frames, counts and material names when present; ask about unit conversion, grade-column semantics and labels. A wrong guess often fails silently and still looks normal.

问的时候带上真实候选：用描述工具列出字段名、单位、值类型，让人从真实选项里选，而不是对着一个 id 猜。
Ask with real candidates: list field names, units and value types with the describe tools so the user chooses from actual options, not from an id.

# 只跑需要的步骤 / Run only the steps you need

固化不是每次全跑。`steps[].id` 是可步骤名，`steps` 选择本次步骤，`resume` 提供已认可结果里被跳过先决步骤的产物；先决缺失时工作流拒绝并点名，不静默补跑。
A frozen capability need not run the whole pipeline. `steps[].id` names a step; `steps` selects, and `resume` carries products of skipped prerequisites from an accepted result. A missing prerequisite is refused by name, never silently re-run.

下一次先 `iam_workflow_list` 找能力，只传需要的 `steps`/`resume`，读它写出的 `result.json`（含 `run.steps`），不要把过程重新贴进上下文。
Next time, call `iam_workflow_list`, pass only the needed `steps`/`resume`, and read `result.json` (`run.steps`) instead of restating the process.

必填输入没给时骨架会拒绝并点名；不要用「先给个默认值」把它压过去。
A missing required input is refused by name; never invent a default.

`iam_workflow_list` 每项带 `status`：draft 在 active 之后，`iam_workflow_run` 拒绝 draft；scaffold 生成 draft，freeze 成功后才 active。
Every `iam_workflow_list` entry carries `status`: drafts follow active, and `iam_workflow_run` refuses a draft. Scaffold writes draft; only a successful freeze makes it active.

**省 token：复用契约与结果，不重述过程。 / Save tokens: reuse the contract and result, not the process.**

# 什么时候拒绝固化 / When to refuse

- **契约不成立**：缺 `inputs` / `steps` / `acceptance`，`acceptance_checks` 与 `acceptance` 不等长，步骤 id 缺失/重复/前向依赖，或程序哈希对不上；用 `capability_validate`，不要绕过。
  **Contract does not hold**: missing sections, misaligned checks, missing/duplicate/forward step ids, or a changed program hash. Run `capability_validate`; do not bypass it.
- **人读字段还是占位**：`TODO:` 开头的 `title` / `answers` / `means` / `refused_when` / `does` / `acceptance` 是 `manifest.placeholder` error；填真实内容，不是删前缀。
  **Human fields are still `TODO:` placeholders**: they are `manifest.placeholder` errors. Fill them; do not just remove the prefix.
- **用户没有认可结果；只有一次成功；为了让这次跑通放宽条件；规则只活在对话里。**
  **The user did not accept the result; only one success; conditions were relaxed to make it pass; rules live only in the conversation.**

# 不要做什么 / Do not

- **不要把能力做成插件。** 插件是工坊，能力是数据。
  **Do not make a capability a plugin.** The plugin is the workshop; capabilities are data.
- **不要在本插件里执行能力。** 执行永远走 `iam_workflow_run`。
  **Do not execute capabilities here.** Execution is always `iam_workflow_run`.
- **不要复述 manifest。** 读它，引用它。
  **Do not restate the manifest.** Read it; reference it.
- **不要按当前目录猜路径。** validate 的相对路径按 workspace 解析，且不能逃出。
  **Do not guess a path from the cwd.** A relative validate path belongs to the workspace and cannot escape it.
- **不要翻译字段名。** 字段名、`kind`、`steps`/`resume` 是契约键；能力名/id 可中英文，人读内容用用户语言。
  **Do not translate field names.** They are contract keys; names/ids may be Chinese or English; human text uses the user's language.
- **不要写死阈值。** 阈值进 `acceptance_checks`，口径进 `report-spec`。
  **Do not hardcode thresholds.** Thresholds go in `acceptance_checks`; conventions in `report-spec`.
