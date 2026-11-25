# CapabilityForge — 能力工坊

**插件是工坊，能力是数据。** 工坊提供「发现 / 生成 / 校验 / 冻结 / 审计」五个动词，
**不执行**任何用户能力——执行永远走 `iam_workflow_run`。每固化一个能力只多一个目录，
不装包、不重启。

这句话是本包的第一条边界，也是它为什么存在：把每个能力做成插件，固化第二个能力
就要再构建、再装包、再重启、再加一行 profile；那不是固化能力，是给能力发身份证。
而把「怎么固化」做成插件、把能力留成数据，平台拿到的则是同一套容器和版本管理，
外加零成本的第二、第三个能力。

另一半边界同样重要：**工坊不拥有运行时。** 运行要沙箱、要 `needs_input` 追问链路，
这些已经在 AlgorithmBridge 里；工坊再实现一套，就等于同一件事有两个事实源。
因此本包的工具里没有任何一个能启动一个 workflow。

**能力从最近成功的事务里来。** 一个值得固化的候选通常有明确的输入、具体的操作
过程和用户认可的成果；`capability_candidates` 把工作区里最近的运行按程序哈希汇总，
给出最新一次 run、产物和是否已冻结。它只提出证据，**不替用户做决定**：结果是否
被认可、下次是否还会问，要由人回答，然后才 `capability_freeze --confirmed`。

**固化后的能力允许只跑一部分。** 冻结不是把整条流水线每次重跑：manifest 的
`steps[].id` 是可选步骤名，`steps` 输入选择跑哪几步，`resume` 让已认可的上一次
结果顶替被跳过的先决步骤；先决输出缺失时工作流拒绝并点名，而不是静默补跑。
`run.steps` 把 requested / executed / skipped 写进结果，部分执行不会被读成整条完成。

## 目录

```
CapabilityForge/
  host/index.ts           name / inject = ['tools'] / apply(ctx, config)
  host/tools.ts           五个 RawToolDefinition
  host/python.ts          spawn python/capability.py，解析 stdout 的一个 JSON 对象
  python/capability.py    本体：scaffold / validate / freeze / audit，可独立运行
  templates/              manifest.json / workflow.py / SKILL.md /
                          report-spec.default.json / figure-spec.default.json
  schemas/                result / report-spec / figure，draft 2020-12
  scripts/build.mjs       host/*.ts -> lib/*.js（transpile），clean 删除 lib/
```

`lib/` 是构建产物（`.gitignore` 里被忽略），与兄弟包一致；`python/`、`templates/`
和 `schemas/` 按源码发布。**运行时不得 import 任何 `@deepseek-ai/*` 的值**——
profile 的 `node_modules` 里只有被链进来的插件，连 `import type` 之外的引用都解析不到。
也不写 `Config` schema：Cordis 在没有 schema 时把 row 的 `config:` 原样传下来。

## 命名与语言

**字段名是英文，内容可以是中文或英文。** `title` / `answers` / `means` /
`refused_when` / `does` / `label` / `comment` / report 的 `source` 都是给人读的值，
用哪种语言由作者决定；`kind`、`scope`、`hard`/`soft`、保留输入名 `steps`/`resume`
这些是契约键，保持英文。`ensure_ascii=True` 只影响线上字节，解码后的中文原样保留。

**能力名和步骤 id 是地址，不是句子。** 它们接受中英文、数字、下划线开头，后续可带
`-`（例如 `orebody-model`、`矿体-model`、`read`、`读取`）。地址里不允许点或路径
分隔符——lock 与 spec 文件名是 `<name>.<kind>.json`。如果同时服务中英文读者，
推荐**英文 id + 中文 label**：`{"id": "compute", "label": "计算", ...}`，调用方
按 id 选择，人按 label 阅读。

**冻结生成的能力 SKILL 也是双语的。** 它的章节标题与操作说明用中英双语
（`## 输入 / Inputs`、`## 步骤 / Steps` …），但 manifest 里作者写的
`title` / `answers` / `means` / `label` 等内容保持作者原来的语言，不翻译；
`choices` / `why_not_inferred` / `refused_when` / `requires` / `produces` 用契约键名。
这样中文作者写中文、英文作者写英文，同一份结构两边都能读。scaffold 生成的
工坊 SKILL、阶段 `answers` / `means` / `why_not_inferred`、步骤 `label` / `does` /
`refuses`、`acceptance` 和 `known_limits` 也按中英双语给示例；作者填的内容仍可用任一种语言。

**Harness 的 skill 名只接受 `[a-z0-9]+(-[a-z0-9]+)*`。** 能力地址可以是中文、大写或
下划线，但那个字符串不能直接当 SKILL 的 frontmatter `name`，否则 skill-filesystem
会以 “invalid skill name” 忽略整份文件。工坊保留人名可读的部分：技能目录仍是
`.agents/skills/<能力名>/`，`description` 与正文用原标题；frontmatter `name` 换成
稳定的 ASCII 地址——已经是合法小写名的原样使用，需要规范化的加短哈希
（例如 `矿体-model` → `capability-xxxxxxxx`，`Orebody_Model` →
`orebody-model-xxxxxxxx`）。两层地址不同，但不会互相撞，也不会被 harness 丢掉。

## 五个工具

| 工具 | 做什么 | 不做什么 |
|---|---|---|
| `capability_candidates` | 按程序哈希汇总最近成功事务，提出固化候选 | 不冻结、不执行；要用户确认 |
| `capability_scaffold` | 按阶段生成 workflow 目录（`status: draft`）、技能与 spec 默认值 | 不执行能力；执行走 `iam_workflow_run` |
| `capability_validate` | 一条规则一条 finding 地检查契约；相对路径按 workspace 解析 | 不写文件、不执行能力 |
| `capability_freeze` | **调用** AlgorithmBridge 的冻结，写 lock 与能力调用 SKILL，最后将 `status` 置为 `active` | 不执行能力；冻结逻辑只有一份 |
| `capability_audit` | 比对程序哈希、lock、产物与图 | 不运行、不修复、不重冻结 |

`execute` 返回**值本身**，`output.render` 把它变成人读的文本。失败的边界照
AlgorithmBridge 的成法：**契约不成立是值**（`{ok:false, findings}` / `{ok:false, refused}`），
**答案给不出来是抛错**（找不到 Python、找不到 bridge、子进程非 0/1 退出）。
把拒绝包装成异常，会让模型失去可以据以改正的信息。

workspace 的取法是三个来源：调用参数 > `ctx.workingDirectory.ensure(session)` >
row 的 `config.workspace`。`workingDirectory` 是**可选接缝，不是加载闸门**：
写进静态 `inject` 会让整个插件在不挂会话目录的 headless/acp profile 里装不上。

命令行同样有五个子命令，可独立运行（V0 的出口）：

```bash
python .../capability.py candidates --workspace <W> [--limit N] [--include-frozen]
python IAM/plugin/CapabilityForge/python/capability.py scaffold --name <name> \
    [--domain <d>] [--stages model,report] --workspace <W> [--force]
python .../capability.py validate --path <workflow-dir|manifest.json> \
    [--workspace <W>] [--strict]
python .../capability.py freeze --name <n> --run run-... --manifest <file|-> \
    --workspace <W> [--confirmed]
python .../capability.py audit --workspace <W> [--name <n>]
```

所有子命令把 JSON 写到 stdout（`ensure_ascii=True`，Windows 控制台安全），人读摘要写
stderr；成功 0、校验失败或拒绝 1、其余错误（用法错误、路径不存在、逃逸等）2。

**validate 的相对路径按 workspace 解析**（P7 选定的是这一方案，而不是回落到进程当前
目录）。`--path` 是相对路径时，根是工具参数里的 `workspace`（缺省时是
`ctx.workingDirectory`，再缺省是 `config.workspace`）；解析后的绝对路径必须仍在
workspace 内，`..` 与符号链接都不能逃逸。报错写的是**解析后的绝对路径**：

```
there is nothing at <workspace>/.iax/workflows/nope
validate path escapes the workspace: <resolved> is outside <workspace>
```

连 workspace 都没有的相对路径直接拒绝，并说明“按原样会解析成哪个绝对路径”——
不猜、不换一个目录继续找。绝对路径不需要 workspace，仍按原样校验。

## 从最近事务到能力

`capability_candidates` 扫 `<W>/.iax/runs/` 里成功的运行，按 `source_sha256` 分组：

```jsonc
{
  "source_sha256": "...",
  "successes": 2,
  "latest_run": "run-...",
  "program_path": ".iax/runs/run-.../program.py",
  "source_lines": 42,
  "artifacts": [{ "path": "out/...", "bytes": 1234, "sha256_16": "..." }],
  "frozen_as": [],
  "recommended": true,
  "needs_user_confirmation": true,
  "reasons": ["the same program succeeded 2 time(s)", "the latest run produced 1 artifact(s)", "..."]
}
```

它**不返回程序正文**（那会为了发现候选又花一次 token），只给路径与行数；需要时再读。
`recommended` 只是证据支持的建议（跑通 ≥2 次且尚未冻结）；单次成功也会返回，因为
“用户认可的一次结果”本身就可能是最该固化的。`needs_user_confirmation` 永远是 true：
平台不知道用户是否认可结果，也不知道下次是否还会问。**draft 不算已冻结**：一次没写完
的 freeze 留下的 draft（即使已有 `source_sha256`）不会让这个候选从列表里消失。
推荐流程：

```
capability_candidates
  → 带着 latest_run 与产物问用户：这次结果认可吗？以后还会再做吗？
  → 认可：scaffold（或直接用该 run 的 manifest）→ capability_freeze --confirmed
  → 不认可：不要冻结；一次偶然不是一条做法
```

这一步是“减少 token”的第一半：不重新生成程序、不重新解释过程，只复用已经跑过的
那次事务。

## 步骤可选择：固化不等于每次全跑

manifest 的 `steps[]` 除了给人读的 `does/refuses`，还可以带：

```jsonc
{ "id": "compute", "requires": ["read"], "produces": ["solids", "metrics"] }
```

- `id` 必须全清单唯一，以中英文、数字或下划线开头，后续可带 `-`；它是调用方点名
  要跑的那一步。`label` 可选，是给人看的中/英文短名（`{"id": "compute", "label": "计算"}`）。
- `requires` 只能指向**更早**的步骤（manifest 顺序即执行顺序）；前向或未知依赖是
  一个写成列表的环，validate 直接拒绝。
- `produces` 是这一步写进 result.json 的顶层字段（或产物 role）。一个被后续步骤
  require 的步骤必须声明非空 `produces`，否则 `resume` 无法顶替它，那个后续步骤
  就永远不能单独跑。

两个**保留输入名**：

- `steps`（`kind: list`，`choices` 必须正好按 manifest 顺序列出全部步骤 id）：选择
  本次要跑的步骤；省略则全跑；空选择被拒绝。
- `resume`（`kind: path`）：上一次的 `result.json`。被跳过的先决步骤只有在**上次
  确实执行过**且结果仍携带它的 `produces` 字段时，才能顶替；仅仅有一个空的
  `solids` 键不算。

部分执行的规则是**拒绝，不是静默补跑**：

```
step 'summarize' requires compute, which was neither selected nor carried by the
resume result; select it too or pass --resume with a result that ran it
```

结果里 `run.steps` 记 `requested / executed / skipped`；只要有跳过，`warnings` 里
还会写一句 “partial run: skipped …”。这样“只跑了第一步”不会被读成“整条完成”。
下一次 AI 调用只需要：

```json
{ "input": "...", "mode": "default", "steps": ["summarize"], "resume": "out/.../result.json" }
```

## scaffold：每一段一个目录

能力名是 `<领域>-<阶段>`（D11）。`--name orebody --stages model,report` 生成：

```
<W>/.iax/workflows/orebody-model/{manifest.json, workflow.py}
<W>/.iax/workflows/orebody-report/{manifest.json, workflow.py}
<W>/.agents/skills/orebody/SKILL.md
<W>/.iax/specs/orebody.report.json
<W>/.iax/specs/orebody.figure.json
```

技能与 specs 用**不带阶段**的名字：一份报告描述的是这个领域的全部阶段。这里的
`.agents/skills/<name>/SKILL.md` 是**工坊技能**：讲什么时候该固化、先问什么、什么时候
拒绝；它不描述某一个已冻结能力的调用方式。

**冻结还会生成这个能力的调用说明。** `capability_freeze` 写
`.agents/skills/<capability>/SKILL.md`（例如 `orebody-model`），内容取自**冻结后的
manifest 与 lock**：输入名/类型/选项、步骤 id、部分执行规则、结果路径与归因。它让下一
个会话直接知道“调 `iam_workflow_run`，参数是什么”，而不是重新读一遍 manifest 或重写
程序。技能不复述验收阈值，只指向 manifest 的 `acceptance` / `acceptance_checks`。
如果该路径上已有一份**不是工坊生成**的 SKILL（frontmatter 没有
`generated_by: "iam-capability-forge"`），冻结不会覆盖它，返回的 `skill.written` 为
`false` 并说明原因；重新冻结只会刷新工坊自己生成的版本。返回里的 `skill` 形如
`{path, written, reason?}`；`written:false` 不阻止能力生效：已有的用户技能原样保留，
只有该路径根本没有文件时 audit 才报缺失。

**每个阶段是不同的契约，不是同一份 manifest 改个名。** `name` 是
`<name>-<stage>`，`title` / `answers` 按阶段给出，`inputs.required` 也按阶段：
ingest 是 `source` / `format`，model 是 `input` / `mode`，report 是 `result` /
`format`。三份 manifest 因此哈希互不相同；测试按这一条断言，而不是只数目录。
每个阶段的 path 输入都带 `why_not_inferred` 与具体理由，所以 `iam_workflow_run`
在开跑前就会追问缺的文件，而不是让骨架在运行中才失败。
生成的 manifest 一律带 `status: "draft"`（见下面的“草稿与生效”）。

已存在即拒绝（与 freeze 同一个纪律）；`--force` 才覆盖，且先把旧文件复制到各自目录下的
`versions/<时间戳>/`，时间戳冲突时加序号，不覆盖上一轮的历史。

## validate：一条规则一条 finding

`{id, severity, where, message}`，`where` 形如 `manifest.inputs.required[2].kind`。
必须实现的规则：

| id | 规则 |
|---|---|
| `manifest.title` / `manifest.answers` | 非空字符串 |
| `manifest.placeholder` | 人读字段仍是模板占位：`title` / `answers` / `inputs.required[].means` / `inputs.required[].refused_when` / `steps[].does` / `acceptance[]`。占位是 `TODO:` 前缀，或旧模板的整句；两种都认，已有旧文件无需迁移 |
| `manifest.status` | 若存在只能是 `draft` 或 `active`；缺省按 `active` 处理 |
| `manifest.steps` / `manifest.acceptance` | 非空列表 |
| `manifest.steps.id` | 每步有唯一 id：中英文、数字或下划线开头，后续可带 `-` |
| `manifest.steps.label` | 若存在必须是非空字符串；id 是地址，label 是给人看的短名 |
| `manifest.steps.requires` | `requires` 只指向更早步骤；被后续步骤依赖的步骤必须有非空 `produces` |
| `manifest.steps.produces` | `produces` 必须是非空的字段名/产物 role 列表 |
| `manifest.steps.selection` | 保留输入 `steps` 必须是 `kind: list`，`choices` 正好按 manifest 顺序列出全部步骤 id |
| `manifest.steps.resume` | 保留输入 `resume` 必须是 `kind: path` |
| `inputs.required` | 每项有非空 `name` / `kind` / `means` / `refused_when` |
| `inputs.kind` | kind 属于 `path, resource-id, enum, number, list, material-label, boolean` |
| `inputs.enum` | `kind == enum` ⇒ `choices` 非空列表 |
| `inputs.inferred` | 有 `why_not_inferred` ⇒ 非空；同时有 `suggested` ⇒ warning（说明它推得出来） |
| `acceptance.aligned` | 与 `acceptance` 等长、id 顺序一致，每项有 `id` 与 `assert` |
| `manifest.version` | semver |
| `manifest.requires_catalog` | 正整数 |
| `consumes/produces.schema` | 能在本包 `schemas/` 找到同名文件 |
| `specs.*.default` | 相对 workflow 目录的文件必须存在 |
| `workflow.sha` | `manifest.source_sha256` 存在 ⇒ 等于 `workflow.py` 的哈希 |
| `workflow.run` | `workflow.py` 存在且能编译 |
| `deliverable` | 存在时必须有 `primary` |

`--strict` 把 warning 升为 error；error 数 > 0 ⇒ 退出码 1。

**`workflow.sha` 的哈希是平台自己的约定：UTF-8 源码文本、换行归一化之后取 sha256。**
不是文件字节：Windows 上 `write_text` 写 CRLF，而 bridge 读回时按通用换行归一化——
用字节求哈希会把每一个在 Windows 上冻结的流程都误报成「被改过」（工坊第一次端到端
运行实测到的正是这一条）。

## freeze：冻结逻辑不复制

流程是：`validate` 先跑 → 有 error 直接拒绝（**冻结一个契约不成立的能力，等于把它
固化成契约**）→ 调 `AlgorithmBridge/python/bridge.py workflow-freeze`（manifest 以
`status: "draft"` 交给 bridge）→ 写 `<W>/.iax/specs/<name>.lock.json` → 写能力的调用
SKILL → **最后**把冻结后的 manifest 置为 `status: "active"`。顺序是刻意的：`active`
只在 lock 和 skill 都已经存在之后才写，这样进程在 bridge 与 lock（或 skill）之间失败时，
目标仍是 draft，`iam_workflow_run` 会拒绝，而不是把一次没写完的发布当成可用能力。
占位（`manifest.placeholder`）是 error，所以 **原样模板 freeze 在调用 bridge 之前就被
拒绝**，不会留下半冻结的目录。bridge 是唯一的冻结入口；工坊只补五件事：规范快照、
版本归因、lock 文件、调用 SKILL、最终状态。步骤契约（`id` / `requires` / 保留输入
`steps` / `resume`）随 manifest 一起冻结；冻结后的下一次 `iam_workflow_run` 可以把
`steps`/`resume` 作为普通输入传进去，执行仍然只有 bridge 一个入口。

`--manifest` 是相对路径时按 workspace 解析（与 validate 同一条规则），不是进程 cwd；
绝对路径仍须在 workspace 内。

lock 里的 `catalog` / `algorithm` / `abi` 从 `iam_algorithms.Library()` 读；
**读不到就写 `null` 并在返回里说明**，不编一个版本。`schemas` 是每份 schema 的
sha256 前 16 位；`specs` 是冻结时各 spec 的 `version`，供 audit 发现规范漂移。
存在但读不出（或没有 `version`）的 spec 不会被悄悄略过：它们记进 `lock.specs_error`
并在返回的 `note` 里逐条点名。

**manifest 的 `specs.*.default` 文件随冻结进入流程目录。** bridge 从 run 记录写
`workflow.py` 与 `manifest.json`，不搬运别的文件；工坊在移动草稿前按相对路径读出这些
文件，bridge 成功后写进冻结目录，再写 lock。这样 §5.5 的“流程内 default”与工作区
`.iax/specs` 覆盖是两条真实存在的线，而不是一条命名约定。

**草稿不是历史。** `scaffold` 已经写好了同名 workflow 目录，所以第一次 freeze 会遇到
「目标已存在」。bridge 的保护针对的是**已冻结**的能力（同名演进只能升版本）；一个
没有 `source_sha256` 的目录从未冻结过，工坊把它整目录移到一边（失败则原样移回），
冻结成功后再放进 `versions/<时间戳>/`。移动的临时名字是 `.draft-<name>-<时间戳>`；
能力目录扫描**跳过点目录**，所以这个中间状态不会被列成能力。manifest 里**有**
`source_sha256` 的目录不走这条路，继续由 bridge 的版本规则把关。返回里带
`replaced_scaffold: true`，这不是静默覆盖。

manifest 里若出现 `workflow_version` / `name` / `entry` / `provenance` /
`source_sha256` / `confirmed_from_run`，它们属于平台记录，工坊在调 bridge 前剔除，
并把这些键记进结果的 `ignored_reserved_keys`。`status` 不在剔除之列：工坊把它改为
`draft` 交给 bridge，冻结流程自己决定何时写成 `active`。

### 草稿与生效

`scaffold` 写的 manifest 带 `status: "draft"`。草稿**列得出来、跑不起来**：

- `iam_workflow_list` 每一项都带 `status`，draft 排在 active 之后；
- `iam_workflow_run` 拒绝 draft，并说明「填好 workflow.py 与 manifest、先跑一次、
  再 `iam_workflow_freeze` 才会变成可执行的能力」；
- `capability_freeze` 在 bridge 成功、lock 与调用 SKILL 都写入之后，才把冻结后的
  manifest 改为 `status: "active"`；在此之前目标一直是 draft。

没有 `status` 字段的 manifest 一律按 **active** 处理，这是向后兼容：旧的本地流程和
`Workflows/Examples/ByProductOre` 原样工作，不需要补字段。

## audit：有工作才检查，扫不到不是 error

| 检查 | 结论 |
|---|---|
| `workflow.py` 的哈希 ≠ manifest 的 `source_sha256` | error：程序被改过，冻结失效 |
| 已冻结的 manifest 没有 `lock.json` | warning：冻结记录缺失，catalog/算法/schema 版本无从核对 |
| `lock.json` 读不出或不是 JSON 对象 | error：冻结记录损坏，不能把它当成“没有 lock”跳过 |
| `lock.specs` 不是对象 | error：冻结记录形状不对，不能按“没有规范”继续 |
| `lock.version` ≠ 当前 `manifest.version` | warning：冻结后又改过 |
| `lock.catalog` < 当前 catalog | warning：平台算法升级了，建议复测 |
| `result.json` 的 `artifacts[].path` 不存在或 sha 不符 | error：结果与产物对不上 |
| `figures.json` 的 `source.sha256` ≠ 对应产物 | error：旧图配新模型 |
| `specs/*.json` 缺失，或 `version` 与 lock 不一致 | warning |
| `manifest.specs.*.default` 的文件不在流程目录内 | error：冻结时搬进来的默认规范丢了，或不许逃出目录 |
| 已冻结能力缺少 `.agents/skills/<name>/SKILL.md` | warning：能力可运行，但调用说明不在 |
| 工坊生成的 SKILL 的 `capability_version` ≠ manifest | warning：调用说明落后于当前版本 |
| `kind == manual` 的图没有 `by` / `date` | warning（D8：允许，但要点名） |

没有能力的 workspace 返回两个空数组；**扫不到不报 error**。audit 始终以 0 退出：
它是一份报告，不是一次门的开合。

图的 `source.artifact` 先按路径解析；路径解析不到时按同级（或上一级）`result.json`
的 `artifacts[].role` 找——§7.4 规定的是“指向 result.json.artifacts”，不是写死文件名。

## 模板是这家工坊最值钱的资产

现在几百条运行各不相同，根源是「每次照着上一次的样子写」。模板把**形状**固定下来，
工具才有东西可校验；没有模板，工坊只是又一个脚手架玩具。

- `templates/manifest.json`：五节齐全，`name` 与 `status: "draft"` 由 scaffold 按阶段
  填入，人读字段（`title` / `answers` / `means` / `refused_when` / `does` / `acceptance`）
  一律是 `TODO:` 开头的占位；`inputs.required[]` 放一个 `path` 与一个 `enum`，
  三个步骤带 `id` / `label` / `requires` / `produces`，`inputs.optional[]` 放保留的 `steps` 与
  `resume`，`acceptance` / `acceptance_checks` 各四条且 id 对齐；`comment` 写清每一节
  为什么存在。**模板里没有绝对路径、具体矿名或阈值数字。** 每个阶段的
  `answers` 与 `inputs.required` 在 scaffold 时替换，所以三份 manifest 的哈希不同。
- `templates/workflow.py`：可独立运行——`argparse`、读输入、按 `result.schema` 写
  `result.json`、`WorkflowError` 表示拒绝、`--help` 能跑；步骤表从**旁边的 manifest**
  读取（不是代码里再抄一份），只执行选中的步骤，先决输出缺失时拒绝。输入名也从
  manifest 读取：ingest 的 `source/format`、model 的 `input/mode`、report 的
  `result/format` 都是声明名，结果里的 `inputs`/`parameters` 用同一组名字，不写死
  `input`/`mode`。**必填输入没给就拒绝并点名，不编默认值**——旧骨架在没有 `format`
  时落到 `"default"`，而 ingest 的 choices 里根本没有 `default`。平台包在步骤实现
  内导入，这样在没有原生构建的环境里 `--help` 与 `py_compile` 仍然成立。
- `templates/SKILL.md`：YAML frontmatter + 不超过 80 行，只讲判断（何时固化、先问什么、
  何时拒绝），不复述 manifest、不写阈值。
- `templates/report-spec.default.json`：`style / outline / format / legend` 与四条规则，
  每条带 `scope/path/value/source/kind`。
- `templates/figure-spec.default.json`：图实例的形状；图从 `artifacts` 派生并带 sha256。

模板本身必须**可校验，并因为占位而被正确拒绝**。这两半是一件事：模板里每个人读字段
都以 `TODO:` 开头（旧模板的整句也仍被认作占位，已有文件无需迁移），所以原样跑
`capability_validate` 得到一个 `manifest.placeholder` 的 error——这正是“还没填”的
诚实结论；把占位替换成真实内容后，必须是 0 error。测试两边都跑。早期验收写成
“模板必须 0 error”，那是把占位误当成了可用内容。

## 四处登记

1. `IAM/plugin/manifest.json` 的 `packages[]`；
2. `IAM/plugin/profile/mining-workspace/cordis.patch.yml` 的 `insert:`；
3. `IAM/plugin/tests/helpers.mjs` 的 `TOOL_PACKAGES`；
4. `IAM/plugin/tests/capability-forge.test.mjs`。

漏一处就是「查不到」：profile 不装、清单不列、测试不构建、或者根本没有回归。

## 测试

```sh
node IAM/plugin/tests/run.mjs
node --test IAM/plugin/tests/capability-forge.test.mjs
```

测试把五个定义挂在一个假 `ctx` 上并**调用**它们（`execute` 与 `render` 两半），
所以验的是 profile 真正加载的那份 `lib/` 产物。需要原生构建的只有 freeze 的版本归因；
没有构建时 lock 写 `null` 并带 `versions_error`，测试按这个事实断言，而不是跳过。

## 已知边界

- **不执行能力。** 这是设计，不是缺功能。见第一段。步骤选择因此也是工作流层的
  契约：工坊校验 `steps`/`resume` 的形状，真正的选择由 `iam_workflow_run` 把参数
  传给冻结后的 workflow；没有声明 `steps` 的能力仍然整条执行。
- **没有 JSON Schema 校验器依赖。** 三份 schema 是契约和数据；工坊只执行表中列出的
  结构性规则，不假装自己是一份完整的 JSON Schema 实现。
- **`lib/` 不随 git 提交**（与兄弟包一致；`.gitignore` 已覆盖）。`npm pack` 的
  `prepack` 会构建，`postpack` 清理。
